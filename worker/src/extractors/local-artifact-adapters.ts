import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtractionArtifactRef } from "@docslurp/shared";
import type { ArtifactGraphAdapter } from "./artifact-graph.js";
import { CommandRunner, resolveVenvBin } from "../tools/runner.js";
import { ensureBinary } from "../tools/python-deps.js";

/** The caller owns outputDir and its lifetime. Each run writes immutable files there. */
export interface LocalArtifactAdapterOptions {
  outputDir: string;
  maxBytes?: number;
  timeoutMs?: number;
  imageScaleTo?: number;
}

const defaultMaxBytes = 32 * 1024 * 1024;
const defaultTimeoutMs = 60_000;

// One runner for every adapter. Inside an activity it uses the activity's session; elsewhere
// the process default sandbox (see setDefaultParserSandbox).
let sharedRunner: CommandRunner | undefined;

function localArtifactRunner(): CommandRunner {
  sharedRunner ??= new CommandRunner();
  return sharedRunner;
}

export async function runLocalArtifactCommand(binary: string, args: string[], maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const runner = localArtifactRunner();
  const plan = { binary, args, available: true, timeoutMs };
  const launched = await runner.launch(plan, signal);
  try {
    if ("remote" in launched) {
      const result = await runner.settleRemote(plan, launched);
      if (result.exitCode !== 0) throw new Error(`${binary} exited ${result.exitCode}: ${result.stderr.trim().slice(0, 4096)}`);
      if (Buffer.byteLength(result.stdout) > maxBytes) throw new Error(`${binary} output exceeds ${maxBytes} bytes`);
      return Buffer.from(result.stdout);
    }
    const { child } = launched;
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let limitError: Error | null = null;
      const timer = setTimeout(() => { limitError = new Error(`${binary} timed out`); child.kill("SIGKILL"); }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { limitError = new Error(`${binary} output exceeds ${maxBytes} bytes`); child.kill("SIGKILL"); return; }
        chunks.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString().slice(0, 4096 - stderr.length);
      });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (limitError) reject(limitError);
        else if (code !== 0) reject(new Error(`${binary} exited ${code}: ${stderr.trim()}`));
        else resolve(Buffer.concat(chunks));
      });
    });
  } finally {
    await launched.release();
  }
}

function filePath(ref: ExtractionArtifactRef): string {
  if (ref.uri.startsWith("file://")) return new URL(ref.uri).pathname;
  if (ref.uri.includes("://")) throw new Error(`Local adapter requires a file URI: ${ref.uri}`);
  return path.resolve(ref.uri);
}

export async function localArtifactToolAvailability(): Promise<Record<string, boolean>> {
  const binaries = ["pdftoppm", "pdftotext", "pdftohtml", "pdfinfo", "pdfimages", "tesseract", "pandoc"];
  // Commands spawn with the venv bin first on PATH, so binaries provisioned there count.
  const venvBin = resolveVenvBin(process.env.PYTHON_VENV);
  return Object.fromEntries(await Promise.all(binaries.map(async (binary) => {
    const paths = [venvBin, ...(process.env.PATH ?? "").split(path.delimiter)];
    for (const directory of paths) {
      if (!directory) continue;
      try { await access(path.join(directory, binary)); return [binary, true] as const; } catch { /* next PATH entry */ }
    }
    // Some binaries ship as wheels (pandoc); provision them lazily.
    return [binary, await ensureBinary(binary, { venvBin }).catch(() => false)] as const;
  })));
}

export function createLocalArtifactAdapters(options: LocalArtifactAdapterOptions): ArtifactGraphAdapter[] {
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const imageScaleTo = options.imageScaleTo ?? 1600;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(imageScaleTo) || imageScaleTo < 1 || imageScaleTo > 4000) throw new Error("Invalid local adapter limits");
  const outputDir = path.resolve(options.outputDir);
  const emit = async (adapter: string, kind: string, input: ExtractionArtifactRef, bytes: Buffer, mediaType: string, extension: string, pageNumber?: number, ordinal = 0): Promise<ExtractionArtifactRef> => {
    if (bytes.length > maxBytes) throw new Error(`${adapter} artifact exceeds ${maxBytes} bytes`);
    await mkdir(outputDir, { recursive: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `${input.sourceDocumentId}:${adapter}:${pageNumber ?? "document"}:${ordinal}:${sha256.slice(0, 12)}`;
    const uri = path.join(outputDir, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`);
    await writeFile(uri, bytes);
    return { id, kind, uri, mediaType, sha256, sourceDocumentId: input.sourceDocumentId, derivedFrom: [input.id], placements: pageNumber === undefined ? [] : [{ pageNumber, fidelity: "page-only" }], producer: { id: adapter, optionsDigest: createHash("sha256").update(JSON.stringify({ maxBytes, timeoutMs, imageScaleTo })).digest("hex") } };
  };
  const page = (number?: number) => { if (!number || !Number.isSafeInteger(number) || number < 1) throw new Error("Page number required"); return number; };
  const one = (inputs: readonly ExtractionArtifactRef[]) => { if (inputs.length !== 1) throw new Error("Exactly one input required"); return inputs[0]; };
  const aggregate = async (adapter: string, kind: string, inputs: readonly ExtractionArtifactRef[], bytes: Buffer, mediaType: string, extension: string): Promise<ExtractionArtifactRef[]> => {
    if (inputs.length === 0 || bytes.length > maxBytes) throw new Error(`${adapter} has no inputs or exceeds output limit`);
    if (inputs.some((input) => input.sourceDocumentId !== inputs[0].sourceDocumentId)) throw new Error("Aggregate inputs belong to different documents");
    await mkdir(outputDir, { recursive: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const id = `${inputs[0].sourceDocumentId}:${adapter}:${sha256.slice(0, 12)}`;
    const uri = path.join(outputDir, `${id.replace(/[^a-zA-Z0-9._-]/g, "_")}.${extension}`);
    await writeFile(uri, bytes);
    return [{ id, kind, uri, mediaType, sha256, sourceDocumentId: inputs[0].sourceDocumentId, derivedFrom: inputs.map((input) => input.id), placements: [], producer: { id: adapter, optionsDigest: createHash("sha256").update(JSON.stringify({ maxBytes, timeoutMs })).digest("hex") } }];
  };
  const ordered = (inputs: readonly ExtractionArtifactRef[]) => [...inputs].sort((a, b) => a.placements[0].pageNumber - b.placements[0].pageNumber || a.id.localeCompare(b.id));
  const adapters: ArtifactGraphAdapter[] = [
    { id: "poppler-page-image", accepts: ["source/pdf"], emits: ["page/image"], scope: "page", cost: 2, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      await mkdir(outputDir, { recursive: true });
      const prefix = path.join(outputDir, `render-${randomUUID()}-${number}`);
      await runLocalArtifactCommand("pdftoppm", ["-f", String(number), "-l", String(number), "-singlefile", "-scale-to", String(imageScaleTo), "-png", filePath(input), prefix], maxBytes, timeoutMs, ctx.signal);
      const rendered = `${prefix}.png`;
      if ((await stat(rendered)).size > maxBytes) throw new Error("Rendered page exceeds output limit");
      const bytes = await readFile(rendered);
      return [await emit("poppler-page-image", "page/image", input, bytes, "image/png", "png", number)];
    } },
    { id: "poppler-page-text", accepts: ["source/pdf"], emits: ["page/text"], scope: "page", cost: 1, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      const bytes = await runLocalArtifactCommand("pdftotext", ["-f", String(number), "-l", String(number), "-layout", "-enc", "UTF-8", filePath(input), "-"], maxBytes, timeoutMs, ctx.signal);
      return [await emit("poppler-page-text", "page/text", input, bytes, "text/plain; charset=utf-8", "txt", number)];
    } },
    { id: "poppler-page-html", accepts: ["source/pdf"], emits: ["page/html"], scope: "page", cost: 1, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      const bytes = await runLocalArtifactCommand("pdftohtml", ["-f", String(number), "-l", String(number), "-i", "-stdout", filePath(input)], maxBytes, timeoutMs, ctx.signal);
      return [await emit("poppler-page-html", "page/html", input, bytes, "text/html; charset=utf-8", "html", number)];
    } },
    { id: "poppler-pdf-metadata", accepts: ["source/pdf"], emits: ["document/metadata"], scope: "document", cost: 1, async run(inputs, ctx) {
      const input = one(inputs);
      const raw = (await runLocalArtifactCommand("pdfinfo", [filePath(input)], maxBytes, timeoutMs, ctx.signal)).toString("utf8");
      const metadata = Object.fromEntries(raw.split(/\r?\n/).flatMap(line => { const at = line.indexOf(":"); return at < 1 ? [] : [[line.slice(0, at).trim(), line.slice(at + 1).trim()]]; }));
      return [await emit("poppler-pdf-metadata", "document/metadata", input, Buffer.from(JSON.stringify(metadata)), "application/json", "json")];
    } },
    { id: "poppler-embedded-images", accepts: ["source/pdf"], emits: ["page/embedded-image-set", "page/embedded-image"], scope: "page", cost: 2, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      await mkdir(outputDir, { recursive: true });
      const prefix = `embedded-${randomUUID()}-${number}`;
      await runLocalArtifactCommand("pdfimages", ["-f", String(number), "-l", String(number), "-png", filePath(input), path.join(outputDir, prefix)], maxBytes, timeoutMs, ctx.signal);
      const files = (await readdir(outputDir)).filter(name => name.startsWith(`${prefix}-`) && name.endsWith(".png")).sort();
      if (files.length > 128) throw new Error("Too many embedded images on page");
      const images = await Promise.all(files.map(async (name, index) => {
        const imagePath = path.join(outputDir, name);
        if ((await stat(imagePath)).size > maxBytes) throw new Error("Embedded image exceeds output limit");
        return emit("poppler-embedded-images", "page/embedded-image", input, await readFile(imagePath), "image/png", "png", number, index);
      }));
      const imageRefs = images.map((image) => ({ pageNumber: number, artifactId: image.id, mediaType: image.mediaType, sha256: image.sha256, placement: "page-only" }));
      const set = await emit("poppler-embedded-images", "page/embedded-image-set", input, Buffer.from(JSON.stringify({ pageNumber: number, images: imageRefs })), "application/json", "json", number);
      return [set, ...images];
    } },
    { id: "tesseract-page-ocr", accepts: ["page/image"], emits: ["page/text"], scope: "page", cost: 4, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      const bytes = await runLocalArtifactCommand("tesseract", [filePath(input), "stdout", "-l", "eng"], maxBytes, timeoutMs, ctx.signal);
      return [await emit("tesseract-page-ocr", "page/text", input, bytes, "text/plain; charset=utf-8", "txt", number)];
    } },
    { id: "pandoc-text-markdown", accepts: ["page/text"], emits: ["page/markdown"], scope: "page", cost: 1, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      const bytes = await runLocalArtifactCommand("pandoc", ["-f", "markdown", "-t", "gfm", filePath(input)], maxBytes, timeoutMs, ctx.signal);
      return [await emit("pandoc-text-markdown", "page/markdown", input, bytes, "text/markdown; charset=utf-8", "md", number)];
    } },
    { id: "pandoc-html-markdown", accepts: ["page/html"], emits: ["page/markdown"], scope: "page", cost: 1, async run(inputs, ctx) {
      const input = one(inputs), number = page(ctx.pageNumber);
      const bytes = await runLocalArtifactCommand("pandoc", ["-f", "html", "-t", "gfm", filePath(input)], maxBytes, timeoutMs, ctx.signal);
      return [await emit("pandoc-html-markdown", "page/markdown", input, bytes, "text/markdown; charset=utf-8", "md", number)];
    } },
    { id: "assemble-page-markdown", accepts: ["page/markdown"], emits: ["document/markdown"], scope: "aggregate", cost: 1, async run(inputs, ctx) {
      ctx.signal?.throwIfAborted();
      const parts: string[] = [];
      const refs = ordered(inputs);
      for (const ref of refs) {
        const pageNumber = ref.placements[0]?.pageNumber;
        if (!pageNumber) throw new Error("Page markdown lacks page placement");
        const text = await readFile(filePath(ref), "utf8");
        parts.push(`<!-- page ${pageNumber}; source ${ref.id} -->\n\n${text.trim()}\n`);
      }
      return aggregate("assemble-page-markdown", "document/markdown", refs, Buffer.from(parts.join("\n")), "text/markdown; charset=utf-8", "md");
    } },
    { id: "assemble-media-map", accepts: ["page/embedded-image-set"], emits: ["document/media-map"], scope: "aggregate", cost: 1, async run(inputs, ctx) {
      ctx.signal?.throwIfAborted();
      const refs = ordered(inputs);
      const images: Array<{ pageNumber: number; artifactId: string; mediaType: string; sha256: string; placement: "page-only" }> = [];
      for (const ref of refs) {
        const pageNumber = ref.placements[0]?.pageNumber;
        if (!pageNumber) throw new Error("Image set lacks page placement");
        const set = JSON.parse(await readFile(filePath(ref), "utf8")) as { pageNumber: number; images: typeof images };
        if (set.pageNumber !== pageNumber || !Array.isArray(set.images) || set.images.some((image) => image.pageNumber !== pageNumber || image.placement !== "page-only")) throw new Error("Invalid page image set");
        images.push(...set.images);
      }
      return aggregate("assemble-media-map", "document/media-map", refs, Buffer.from(JSON.stringify({ images }, null, 2)), "application/json", "json");
    } },
  ];
  return adapters;
}

/** Returns only adapters whose required local binaries are present. */
export async function availableLocalArtifactAdapters(options: LocalArtifactAdapterOptions): Promise<ArtifactGraphAdapter[]> {
  const available = await localArtifactToolAvailability();
  const binary: Record<string, string> = {
    "poppler-page-image": "pdftoppm", "poppler-page-text": "pdftotext",
    "poppler-page-html": "pdftohtml", "poppler-pdf-metadata": "pdfinfo",
    "poppler-embedded-images": "pdfimages", "tesseract-page-ocr": "tesseract",
    "pandoc-text-markdown": "pandoc", "pandoc-html-markdown": "pandoc",
  };
  return createLocalArtifactAdapters(options).filter((adapter) => !binary[adapter.id] || available[binary[adapter.id]]);
}
