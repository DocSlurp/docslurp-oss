import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalExtractorId, resetExtractorIdAliasesForTest } from "@docslurp/shared";
import { Store } from "../db/store.js";
import { registerExtractorPlugin, resetExtractorPluginsForTest } from "../extractors/plugins.js";
import { configureWorkerExtractorIdAliases, documentExtractorRegistry, servedExtractorIds } from "../extractors/registry.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// A made-up id a deployment used before renaming its sandboxed PDF extractor to vm-pdf.
const LEGACY = "legacy-pdf";
const ALIAS = { DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:vm-pdf` };

function registerTestProvider() {
  registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: {
    id: "test-vm", maxSourceBytes: 1024, assertConfigured: () => undefined, timeoutMs: () => 1_000,
    run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
  } });
}

beforeEach(() => { resetExtractorPluginsForTest(); resetExtractorIdAliasesForTest(); vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { resetExtractorPluginsForTest(); resetExtractorIdAliasesForTest(); vi.restoreAllMocks(); });

describe("worker startup with DOCSLURP_EXTRACTOR_ID_ALIASES", () => {
  it("refuses an alias to vm-pdf when no provider plugin serves it", () => {
    expect(servedExtractorIds()).not.toContain("vm-pdf");
    expect(() => configureWorkerExtractorIdAliases(ALIAS)).toThrow(/does not serve/);
    expect(canonicalExtractorId(LEGACY)).toBe(LEGACY);
  });

  it("refuses an alias to an unknown id and over a built-in id", () => {
    registerTestProvider();
    expect(() => configureWorkerExtractorIdAliases({ DOCSLURP_EXTRACTOR_ID_ALIASES: `${LEGACY}:no-such-extractor` })).toThrow(/does not serve/);
    expect(() => configureWorkerExtractorIdAliases({ DOCSLURP_EXTRACTOR_ID_ALIASES: "kreuzberg:vm-pdf" })).toThrow(/may not override/);
    expect(canonicalExtractorId("kreuzberg")).toBe("kreuzberg");
  });

  it("with a provider, resolves and prepares the legacy id as vm-pdf; unknown ids still fail", async () => {
    registerTestProvider();
    expect(() => documentExtractorRegistry.resolve("pdf", [LEGACY])).toThrow(/unknown extractor/);
    configureWorkerExtractorIdAliases(ALIAS);
    expect(documentExtractorRegistry.resolve("pdf", [LEGACY, "vm-pdf", "kreuzberg"])).toEqual(["vm-pdf", "kreuzberg"]);
    expect(() => documentExtractorRegistry.resolve("pdf", ["mystery"])).toThrow(/unknown extractor mystery/);
    const runner = { sandboxedPdfMarkdown: async (input: string, output: string) => ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }) };
    const prepared = await documentExtractorRegistry.prepare(LEGACY, runner as never, "/unused/source.pdf");
    expect(prepared.label).toBe("vm-pdf");
  });
});

describe("a run created with the legacy id before the deploy", () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let store: Store;
  let dir: string;
  // What the pre-deploy API stored on the run row: the legacy id in order, options and voting.
  const legacyPipeline = {
    quality: "fast", markdownExtraction: true, visionFallback: false,
    documentExtraction: { order: { pdf: [LEGACY] }, options: { [LEGACY]: { images: { enabled: false } } }, voting: { enabled: false, secondary: LEGACY } },
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "extractor-alias-"));
    db = await createMigratedDatabase();
    await db.exec(`
      insert into "user"(id, name, email) values ('u1', 'A', 'a@example.invalid');
      insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
      insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    `);
    await db.query(`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract-markdown', $1::jsonb, 1)`, [JSON.stringify(legacyPipeline)]);
    const served = await serveOnRandomPort(db);
    server = served.server;
    store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  }, 120_000);

  afterAll(async () => {
    await store?.close();
    await server?.stop();
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("loads with the canonical id and completes extraction on the VM route after the worker restarts with the alias", async () => {
    registerTestProvider();
    configureWorkerExtractorIdAliases(ALIAS);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = await store.loadRun("run-1");
    expect(run.pipeline.documentExtraction).toMatchObject({ order: { pdf: ["vm-pdf"] }, options: { "vm-pdf": { images: { enabled: false } } }, voting: { secondary: "vm-pdf" } });
    expect(error).not.toHaveBeenCalled();

    const sourcePath = path.join(dir, "source.pdf");
    await writeFile(sourcePath, "trusted test input; VM faked");
    const objects = new Map<string, Buffer>();
    const storage = {
      uri: (key: string) => `s3://test/${key}`,
      putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
      putJson: async () => undefined,
      streamText: async (key: string, value: string) => { objects.set(key, Buffer.from(value)); },
      streamToStorage: async (key: string, stream: AsyncIterable<Buffer>) => { const parts: Buffer[] = []; for await (const b of stream) parts.push(b); objects.set(key, Buffer.concat(parts)); },
      createMultipartUploadStream: (key: string) => {
        const parts: Buffer[] = [];
        const writable = new Writable({ write(chunk, _enc, cb) { parts.push(Buffer.from(chunk)); cb(); } });
        const done = new Promise<void>((resolve, reject) => { writable.on("finish", () => { objects.set(key, Buffer.concat(parts)); resolve(); }); writable.on("error", reject); });
        return { writable, done };
      },
    };
    const vm = vi.fn(async (plan: { sandboxedPdf: { output: string } }) => {
      await writeFile(plan.sandboxedPdf.output, "# Heading\n\nBorn digital prose.\fSecond page.");
      return { stdout: "", stderr: "" };
    });
    const runner = { sandboxedPdfMarkdown: async (input: string, output: string) => ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }), run: vm };
    const stage = new ExtractMarkdownStage(runner as never, storage as never, {} as never);
    const internals = stage as unknown as Record<string, unknown>;
    internals.sources = { get: async () => ({ path: sourcePath, sha256: "a".repeat(64) }) };
    internals.recordSourcePageFacts = async () => undefined;
    internals.recordPageImageEvidence = async () => null;
    const doc = { id: "d", userId: "u1", runId: "run-1", filename: "source.pdf", mimeType: "application/pdf", sourceKey: "u1/source.pdf", status: "processing", extractionMode: "hybrid", pageCount: 2, createdAt: new Date(), updatedAt: new Date() };
    const state = WorkflowState.create(run, [doc as never]);
    state.artifactLedger.recordDocument("d", "normalizedFormat", "pdf");
    await stage.run(state);
    expect(vm).toHaveBeenCalledOnce();
    expect(state.documentStage("d", "extract-markdown")?.status).toBe("completed");
    expect([...objects.values()].some((value) => value.toString().includes("Born digital prose."))).toBe(true);
  });
});
