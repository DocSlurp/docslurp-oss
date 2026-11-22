import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { createLocalArtifactAdapters } from "../extractors/local-artifact-adapters.js";
import { assertSandboxPolicy } from "../sandbox/policy.js";
import { createModalProvider } from "../sandbox/providers/modal/index.js";
import type { SandboxSession } from "../sandbox/types.js";
import type { ArtifactGraphAdapter, ExtractionArtifactRef, ProcessorModule } from "./index.js";

const recipe = "pdf-text-v1";
const maxSourceBytes = 128 * 1024 * 1024;
const maxWindowPages = 64;
const maxArtifactBytes = 4 * 1024 * 1024;
const allowedTools = new Set(["pdfinfo", "pdftotext", "pandoc"]);
const adapterIds = new Set(["poppler-page-text", "pandoc-text-markdown", "assemble-page-markdown"]);

async function stagePdf(input: string, destination: string, signal: AbortSignal): Promise<string> {
  const file = await open(input, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxSourceBytes) throw new Error("PDF source must be a regular file of at most 128 MiB");
    const digest = createHash("sha256");
    let length = 0;
    const boundAndHash = new Transform({
      transform(bytes: Buffer, _encoding, done) {
        length += bytes.length;
        if (length > maxSourceBytes) return done(new Error("PDF source exceeds 128 MiB"));
        digest.update(bytes);
        done(null, bytes);
      },
    });
    await pipeline(file.createReadStream({ autoClose: false }), boundAndHash,
      createWriteStream(destination, { mode: 0o600, flags: "wx" }), { signal });
    return digest.digest("hex");
  } finally {
    await file.close();
  }
}

function markdownChunks(outputDir: string): ArtifactGraphAdapter {
  const id = "markdown-page-chunks";
  return {
    id,
    scope: "page",
    accepts: ["page/markdown"],
    emits: ["page/chunks"],
    async run([source], ctx) {
      ctx.signal?.throwIfAborted();
      const text = await readFile(source.uri, { encoding: "utf8", signal: ctx.signal });
      // Split plain text with Unicode-aware boundaries. Markdown and raw HTML stay text here.
      const chunks = text.match(/[\s\S]{1,2000}/gu) ?? [];
      const bytes = Buffer.from(JSON.stringify(chunks));
      if (bytes.length > maxArtifactBytes) throw new Error("Page chunks exceed the artifact size limit");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uri = path.join(outputDir, `page-${ctx.pageNumber}.chunks.json`);
      await writeFile(uri, bytes, { flag: "wx" });
      return [{
        ...source,
        id: `${source.sourceDocumentId}:${id}:${ctx.pageNumber}`,
        kind: "page/chunks",
        uri,
        mediaType: "application/json",
        sha256,
        derivedFrom: [source.id],
        producer: { id, optionsDigest: createHash("sha256").update(`${recipe}:plain-text:2000`).digest("hex") },
      }];
    },
  };
}

/** A one-job reference module for the standalone CLI, with a VM-only text layer. */
export const configure: ProcessorModule["configure"] = async (env) => {
  if (env.DOCSLURP_PARSER_SANDBOX !== "modal") throw new Error("The PDF recipe requires DOCSLURP_PARSER_SANDBOX=modal");
  const configuredOutput = env.DOCSLURP_PROCESSOR_OUTPUT_DIR?.trim();
  if (!configuredOutput) throw new Error("Set DOCSLURP_PROCESSOR_OUTPUT_DIR to a new output directory");
  const outputDir = path.resolve(configuredOutput);
  const pageStart = Number(env.DOCSLURP_PROCESSOR_FIRST_PAGE ?? "1");
  if (!Number.isSafeInteger(pageStart) || pageStart < 1) throw new Error("The starting page must be a positive integer");

  const provider = createModalProvider(() => import("modal"));
  const strictEnv = { ...env, NODE_ENV: "production" };
  const config = provider.readConfig(strictEnv);
  let session: SandboxSession | undefined;
  let inputPath: string | undefined;
  let scratchDir: string | undefined;
  let preparationStarted = false;
  const command = async (binary: string, args: string[], maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> => {
    const invoke = session?.run?.bind(session);
    const inputs = args.filter((arg) => path.isAbsolute(arg));
    if (!invoke || !inputPath || !scratchDir || !allowedTools.has(binary) || inputs.length !== 1) {
      throw new Error("PDF recipe refused a command outside its VM inputs");
    }
    const [source] = inputs;
    let staged = inputPath;
    if (binary === "pandoc") {
      if (path.dirname(source) !== outputDir || path.extname(source) !== ".txt") {
        throw new Error("PDF recipe refused a Markdown input outside its page text");
      }
      staged = path.join(scratchDir, `${randomUUID()}.txt`);
      await copyFile(source, staged, constants.COPYFILE_EXCL);
    } else if (source !== inputPath) {
      throw new Error("PDF recipe refused a command outside its staged PDF");
    }
    const result = await invoke({
      binary, args: args.map((arg) => arg === source ? staged : arg), env: { LANG: "C", LC_ALL: "C" },
      readablePaths: [], inputPaths: [staged], writablePaths: [],
      affinityKey: inputPath,
      limits: { timeoutMs, maxOutputBytes: maxBytes },
    }, signal);
    if (result.exitCode !== 0) throw new Error(`${binary} failed in the parser VM`);
    const bytes = Buffer.from(result.stdout, "utf8");
    if (bytes.length > maxBytes) throw new Error(`${binary} exceeded the output limit`);
    return bytes;
  };

  const adapters = createLocalArtifactAdapters({ outputDir, maxBytes: maxArtifactBytes, command })
    .filter((adapter) => adapterIds.has(adapter.id));
  adapters.push(markdownChunks(outputDir));

  return {
    adapters,
    async prepare(input, targets, signal) {
      if (preparationStarted) throw new Error("Configure a fresh PDF recipe for each CLI invocation");
      preparationStarted = true;
      if (targets.some((target) => !["document/markdown", "page/markdown", "page/chunks"].includes(target))) {
        throw new Error("PDF recipe targets: document/markdown, page/markdown, page/chunks");
      }
      signal.throwIfAborted();
      const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-pdf-recipe-"));
      scratchDir = scratch;
      const close = async () => {
        try {
          try { await session?.close(); }
          finally { await provider.drain?.(); }
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      };

      try {
        inputPath = path.join(scratch, "input.pdf");
        const sha256 = await stagePdf(input, inputPath, signal);
        signal.throwIfAborted();
        const probe = await provider.probe(config);
        if (!probe.ok) throw new Error("The configured PDF parser VM failed its probe");
        assertSandboxPolicy({ providerId: provider.id, isolation: probe.isolation, env: strictEnv });
        session = await provider.openSession(config, { activityId: randomUUID() });
        assertSandboxPolicy({ providerId: session.providerId, isolation: session.isolation, env: strictEnv });
        const info = await command("pdfinfo", [inputPath], 64 * 1024, 60_000, signal);
        const counts = [...info.toString("utf8").matchAll(/^Pages:[ \t]*(\d+)[ \t]*\r?$/gm)];
        const pageCount = counts.length === 1 ? Number(counts[0][1]) : NaN;
        if (!Number.isSafeInteger(pageCount) || pageCount < pageStart) throw new Error("The parser did not report the requested PDF page");
        const pageNumbers = Array.from({ length: Math.min(maxWindowPages, pageCount - pageStart + 1) }, (_, i) => pageStart + i);
        if (targets.includes("document/markdown") && (pageStart !== 1 || pageNumbers.length !== pageCount)) {
          throw new Error("Document Markdown requires at most 64 pages; request page artifacts for larger PDFs");
        }
        signal.throwIfAborted();
        await mkdir(outputDir, { mode: 0o700 });
        const sourceDocumentId = `pdf-${sha256.slice(0, 16)}`;
        const source: ExtractionArtifactRef = {
          id: `${sourceDocumentId}:source`, kind: "source/pdf", uri: inputPath, mediaType: "application/pdf",
          sha256, sourceDocumentId, derivedFrom: [], placements: [], producer: { id: recipe, optionsDigest: sha256 },
        };
        return { request: { sourceDocumentId, initial: [source], pageNumbers, maxOutputs: maxWindowPages * 3 + 2 }, close };
      } catch (error) {
        await close();
        throw error;
      }
    },
  };
};
