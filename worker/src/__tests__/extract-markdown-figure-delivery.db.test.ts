import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { acceptSandboxedPdfResult, registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedPdfResult } from "../extractors/plugins.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { v2Manifest, v3Text, writeV3Folder } from "../test/doppler-manifest-v2.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// The real ExtractMarkdownStage over a faked VM and the worker's real Store (migrated PGlite): a validated range is
// stored and committed as soon as the VM job returns, before the Markdown is stored, so a Markdown failure keeps it.
const DOC_ID = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";
const MARKDOWN = "# Heading\n\n![image](images/page-0001/image-001.webp)\fTwo.\fThree.";

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u', 'U', 'u@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o', 'O', 'o', 'u');
    insert into projects(id, org_id, user_id, name) values ('p', 'o', 'u', 'P');
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values ('r', 'o', 'u', 'p', 'upload', 'processing', 'extract', '{}', 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count) values
      ('${DOC_ID}', 'o', 'u', 'p', 'r', 'source.pdf', 'application/pdf', 'u/source.pdf', 'processing', 3);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
}, 120_000);
afterAll(async () => { await store?.close(); await server?.stop(); await db?.close(); });
beforeEach(async () => {
  resetExtractorPluginsForTest();
  await sql`delete from document_assets`;
  await sql`delete from document_extraction_levels`;
});
afterEach(() => { resetExtractorPluginsForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function registerProvider() {
  registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: {
    id: "test-vm", maxSourceBytes: 1024, assertConfigured: () => undefined, timeoutMs: () => 1_000,
    run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }), figures: { producerId: "test-figures" },
  } });
}

async function runStage(options: { failMarkdown?: boolean } = {}) {
  const { defaultPipelineFeatures, defaultDocumentExtractionConfig } = await import("@docslurp/shared");
  const { WorkflowState } = await import("../pipeline/pipeline.js");
  const dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "figure-delivery-stage-"));
  const sourcePath = path.join(dir, "source.pdf");
  await writeFile(sourcePath, "trusted test input; VM faked");
  const objects = new Map<string, Buffer>();
  const deletes: string[] = [];
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { objects.set(key, Buffer.from(JSON.stringify(value))); },
    deleteKeys: async (keys: string[]) => { deletes.push(...keys); for (const key of keys) objects.delete(key); },
    openStream: async (key: string) => { const v = objects.get(key); if (!v) throw Object.assign(new Error("missing"), { name: "NoSuchKey" }); return { stream: (async function* () { yield v; })(), size: v.length }; },
    getBytes: async (key: string) => objects.get(key)!,
    streamText: async (key: string, value: string) => { objects.set(key, Buffer.from(value)); },
    createMultipartUploadStream: (key: string) => {
      const parts: Buffer[] = [];
      const writable = new Writable({ write(chunk, _enc, cb) { parts.push(Buffer.from(chunk)); cb(); } });
      const done = new Promise<void>((resolve, reject) => {
        writable.on("finish", () => {
          if (options.failMarkdown && key.includes("/markdown/")) return reject(Object.assign(new Error("markdown upload failed"), { code: "SlowDown" }));
          objects.set(key, Buffer.concat(parts));
          resolve();
        });
        writable.on("error", reject);
      });
      return { writable, done };
    },
  };
  const run = vi.fn(async (plan: any) => {
    await writeFile(plan.sandboxedPdf.output, MARKDOWN);
    const built = v2Manifest();
    await writeV3Folder(plan.sandboxedPdf.figures.dir, v3Text(built.manifest), built.files);
    acceptSandboxedPdfResult(plan.sandboxedPdf, { stdout: "", stderr: "", exitCode: 0, figures: { status: "extracted" } } as SandboxedPdfResult & { stdout: string; stderr: string; exitCode: number }, 3);
    return { stdout: "", stderr: "" };
  });
  const runner = { sandboxedPdfMarkdown: async (input: string, output: string) => ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }), run };
  const stage = new ExtractMarkdownStage(runner as any, storage as any, {} as any);
  const internals = stage as any;
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "a".repeat(64) }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.recordPageImageEvidence = async () => null;
  const doc = { id: DOC_ID, userId: "u", runId: "r", filename: "source.pdf", mimeType: "application/pdf", sourceKey: "u/source.pdf", status: "processing", extractionMode: "hybrid", pageCount: 3, createdAt: new Date(), updatedAt: new Date() };
  const state = WorkflowState.create({ id: "r", orgId: "o", projectId: "p", userId: "u", kind: "bulk-upload", status: "processing", stage: "extract-markdown", totalDocuments: 1, processedDocuments: 0, pagesTotal: 3, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, quality: "fast", markdownExtraction: true, visionFallback: false,
      documentExtraction: { ...defaultDocumentExtractionConfig, order: { pdf: ["vm-pdf"] } } },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date() } as any, [doc as any]);
  (state as any).store = store;
  state.artifactLedger.recordDocument(DOC_ID, "normalizedFormat", "pdf");
  let error: unknown = null;
  try {
    await stage.run(state);
  } catch (caught) {
    error = caught;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { objects, deletes, state, error, stageState: state.documentStage(DOC_ID, "extract-markdown"), ledger: state.artifactLedger.all() as Record<string, string>, pending: state.pendingAssetLedger.get(DOC_ID) };
}

const rows = async () => sql<Array<{ asset_id: string; status: string; storage_state: string }>>`
  select asset_id, status, storage_state from document_assets where document_id = ${DOC_ID} order by asset_id`;
const level = async () => (await sql<Array<Record<string, unknown>>>`
  select images_status, markdown_complete, figures_generation::int as generation from document_extraction_levels where document_id = ${DOC_ID}`)[0];

describe("extract-markdown stores figures per range, independent of the Markdown", () => {
  it("success: the range is committed, slots come from the stored rows, and the checkpoint write is level-only", async () => {
    registerProvider();
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "1");
    const out = await runStage();
    expect(out.error).toBeNull();
    expect(out.stageState?.status).toBe("completed");
    expect((await rows()).filter((row) => row.status === "extracted").map((row) => row.storage_state)).toEqual(["stored", "stored", "stored"]);
    expect(await level()).toMatchObject({ images_status: "complete", generation: 1 });
    expect(out.stageState?.stats?.dopplerFigures).toMatchObject({ status: "stored", deliveries: 1, files: 3 });
    expect(out.ledger[`${DOC_ID}:doppler-figure:p1.1`]).toMatch(/\/images\/page-0001\/image-001\.[0-9a-f]{16}\.webp$/);
    expect(out.ledger[`${DOC_ID}:doppler-figures`]).toBe(`s3://test/u/r/doppler/${DOC_ID}/index.json`);
    expect(out.pending).toMatchObject({ levelOnly: true, level: { indexBytes: expect.any(Number) } });
    expect(out.deletes).toEqual([]);
  });

  it("the Markdown upload fails after the figures validated: the figures stay stored, the level is honest, nothing is deleted", async () => {
    registerProvider();
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "1");
    const out = await runStage({ failMarkdown: true });
    expect(out.stageState?.status === "completed").toBe(false);
    expect((await rows()).filter((row) => row.status === "extracted").map((row) => row.storage_state)).toEqual(["stored", "stored", "stored"]);
    expect(await level()).toMatchObject({ images_status: "complete", markdown_complete: false });
    expect([...out.objects.keys()].filter((key) => /\/images\/page-\d{4}\//.test(key))).toHaveLength(3);
    expect(out.deletes).toEqual([]);
    // The retry (same PDF and settings) merges: no image is uploaded again.
    const again = await runStage();
    expect(again.stageState?.status).toBe("completed");
    expect(await level()).toMatchObject({ generation: 1, images_status: "complete" });
    expect([...again.objects.keys()].filter((key) => /\/images\/page-\d{4}\//.test(key))).toHaveLength(0);
    expect(again.ledger[`${DOC_ID}:doppler-figure:p1.1`]).toMatch(/\/images\/page-0001\/image-001\.[0-9a-f]{16}\.webp$/);
  });
});
