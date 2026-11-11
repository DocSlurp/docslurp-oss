import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import { createStageExecution } from "../pipeline/stage-execution.js";
import type { Config } from "../config.js";
import type { Stage } from "../pipeline/pipeline.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { registerExtractorPlugin, resetExtractorPluginsForTest, sandboxedPdfProvider, type SandboxedPdfJob } from "../extractors/plugins.js";
import { createHash } from "node:crypto";
import type { SandboxedPdfBatchEvent, SandboxedPdfBatchJob } from "../extractors/sandboxed-pdf-batch.js";
import { currentPerfContext } from "../lib/perf-context.js";
import { RunPolicyError } from "../lib/document-failure.js";
import { SourceIntegrityError } from "../sandbox/source-integrity.js";
import {
  countFirstPassPages, firstPassDefersPageCount, firstPassPipeline, planFirstPass, primeFirstPassResults, resetFirstPassResultsForTest, runFirstPassBatch, serveFirstPassResult,
} from "../pipeline/first-pass.js";
import { recordedVerdictGate, setFirstPassPublishGate } from "../pipeline/first-pass-gate.js";

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let work: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  work = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "first-pass-db-"));
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

const DOCS = ["d0", "d1", "d2"];

async function seed(pipeline: Record<string, unknown> = {}) {
  await db.exec(`
    delete from usage_events; delete from document_run_stage_states; delete from project_run_stage_states; delete from project_runs; delete from documents;
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com') on conflict do nothing;
    update organizations set credit_balance_cents = 100000;
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 100000), ('o2', 'Other', 'other', 'u1', 100000) on conflict do nothing;
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2') on conflict do nothing;
    insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values ('r1', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '${JSON.stringify(pipeline)}', 3, 3),
             ('r2', 'o2', 'u1', 'w2', 'upload', 'processing', 'extract', '{}', 1, 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_size)
      values ('d0', 'o1', 'u1', 'w', 'r1', 'a.pdf', 'application/pdf', 'u1/k0', 'processing', 1, 'assumed', 100),
             ('d1', 'o1', 'u1', 'w', 'r1', 'b.pdf', 'application/pdf', 'u1/k1', 'processing', 1, 'assumed', 100),
             ('d2', 'o1', 'u1', 'w', 'r1', 'c.pdf', 'application/pdf', 'u1/k2', 'processing', 1, 'assumed', 100),
             ('x0', 'o2', 'u1', 'w2', 'r2', 'x.pdf', 'application/pdf', 'u1/kx', 'processing', 1, 'assumed', 100);
  `);
}

/** The fake VM: its script drives events; `job` is what the host built. */
type Script = (job: SandboxedPdfBatchJob, emit: (event: SandboxedPdfBatchEvent | Record<string, unknown>) => Promise<void>) => Promise<void>;
let script: Script;
let batchCalls = 0;
let pageCounts = 0;
let lastJob: SandboxedPdfBatchJob | undefined;
let singleRuns = 0;

function registerFakeProvider() {
  registerExtractorPlugin({ apiVersion: 1, name: "fake", sandboxedPdf: {
    id: "fake-vm", maxSourceBytes: 1 << 20, assertConfigured() {}, timeoutMs: () => 1000,
    run: async () => { singleRuns++; return { exitCode: 0, stdout: "", stderr: "" }; },
    pageCount: async () => { pageCounts++; return { pages: 1 }; },
    batch: {
      maxFiles: 8, maxBatchBytes: 1 << 20, maxBatchPages: 100,
      run: async (job, onEvent) => {
        batchCalls++;
        lastJob = job;
        await script(job, async (event) => {
          const text = event as { phase?: string; index: number; pages: number; processedPages?: number };
          if (text.phase === "text" && job.files[text.index]) await writeFile(job.files[text.index]!.output, Array.from({ length: text.processedPages ?? text.pages }, (_, i) => `doc ${job.files[text.index]!.documentId} page ${i + 1}`).join("\f"));
          await onEvent(event as SandboxedPdfBatchEvent);
        });
        lastJob = job;
        return { usage: [{ provider: "modal", model: "fake-batch-vm", metric: "sandbox_compute", amount: 1, unit: "cent", costCents: 1 } as never] };
      },
    },
  } });
}

const textEvent = (index: number, pages = 1, words = 50) => ({
  index, phase: "text", pages,
  result: { exitCode: 0, stdout: "", stderr: "", layoutFacts: { version: "pdf-layout-facts@1", pages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, known: true, words })) } },
});

/** What each fake stage saw, in order. */
let seen: Array<{ stage: string; documentId: string; pageCount?: number; served?: string }>;
let piiFails: Set<string>;
let visionReplaces: Set<string>;
/** N1: the index stage skips these documents (no checkpoint), as a stage that silently no-ops would. */
let indexSkips: Set<string>;
/** N1: the index stage throws for these documents (after embed completed). */
let indexThrows: Set<string>;
/** Embedding of these documents waits until released (a slow provider call). */
let embedHold: { ids: Set<string>; until: Promise<void> } | null = null;

function stages(): Stage[] {
  const perDocument = (name: string, body: (state: any, document: any) => Promise<void | Record<string, unknown>>): Stage => ({
    name,
    run: async (state) => {
      for (const document of [...state.documents]) {
        if (name === "index" && indexSkips.has(document.id)) continue;
        await runDocumentStage(state, document, name, `${document.id}:${name}`, name, async () => ({ stats: (await body(state, document)) ?? {} }));
      }
    },
  });
  // As the real ExtractMarkdownStage.run: persisted first-pass results are primed around the stage.
  const primed = (stage: Stage): Stage => ({ name: stage.name, run: async (state, signal) => {
    const release = await primeFirstPassResults(state, fakeStorage() as never, signal);
    try { await stage.run(state, signal); } finally { await release(); }
  } });
  return [
    primed(perDocument("extract-markdown", async (state, document) => {
      // The real stage asks the runner, which asks the first pass; the output is the batch's Markdown.
      const output = path.join(work, `${document.id}-${Date.now()}.md`);
      const job: SandboxedPdfJob = { input: "/unused", output };
      const served = await serveFirstPassResult(currentPerfContext(), job);
      const { readFile } = await import("node:fs/promises");
      // Not served: the ordinary route boots a VM (counted).
      if (!served) await sandboxedPdfProvider()!.run(job, {} as never);
      const text = served ? await readFile(output, "utf8") : undefined;
      seen.push({ stage: "extract-markdown", documentId: document.id, pageCount: document.pageCount, served: text });
      if (state.firstPassShard) expect(state.run.pipeline.documentExtraction.order.pdf).toEqual(["vm-pdf"]);
      state.artifactLedger.recordDocument(document.id, "markdown", `s3://t/markdown/${document.id}.json`);
      return { markdownSha256: createHash("sha256").update(text ?? "vm").digest("hex") };
    })),
    // The ordinary loop's vision stage: replaces d0's Markdown (a reconciled version), leaves the others.
    perDocument("vision-extract", async (state, document) => {
      seen.push({ stage: "vision-extract", documentId: document.id });
      if (visionReplaces.has(document.id)) state.artifactLedger.recordDocument(document.id, "markdown", `s3://t/markdown-reconciled/${document.id}.md`);
    }),
    perDocument("pii-detect", async (_state, document) => {
      seen.push({ stage: "pii-detect", documentId: document.id });
      if (piiFails.has(document.id)) throw Object.assign(new Error("pii blocked"), {});
    }),
    perDocument("embed", async (_state, document) => {
      if (embedHold?.ids.has(document.id)) await embedHold.until;
      seen.push({ stage: "embed", documentId: document.id });
      await store.markDocumentLexicalSearchable(document.id);
    }),
    perDocument("index", async (_state, document) => {
      seen.push({ stage: "index", documentId: document.id });
      if (indexThrows.has(document.id)) throw new Error("vector store unavailable");
    }),
  ];
}

const SOURCE = "%PDF-1.7 trusted test bytes; never parsed here";
let stored: Map<string, unknown>;
let downloads: string[];
function fakeStorage() {
  const download = async (key: string) => {
    downloads.push(key);
    const dir = await mkdtemp(path.join(work, "docslurp-src-"));
    const file = path.join(dir, "source.pdf");
    await writeFile(file, sourceBytes.get(key) ?? SOURCE);
    return file;
  };
  return {
    bucket: "t",
    downloadSourceToTempFile: download,
    downloadToTempFile: download,
    putJson: async (key: string, value: unknown) => { stored.set(key, JSON.parse(JSON.stringify(value))); },
    getJson: async (key: string) => { if (!stored.has(key)) throw new Error("missing"); return stored.get(key); },
    uri: (key: string) => `s3://t/${key}`,
  };
}
/** Bytes served for a source key (default SOURCE); a different value models a source changed after upload. */
let sourceBytes: Map<string, string>;

function deps(overrides: { quarantineEnabled?: boolean } = {}) {
  const execution = createStageExecution({ store, stages: stages(), config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
  const storage = fakeStorage();
  return {
    store, storage: storage as never, quarantineEnabled: overrides.quarantineEnabled ?? false, heartbeat: () => {},
    runStage: async (stageName: string, documentIds: string[], signal?: AbortSignal) => (await execution.runStage(
      { stageName, runId: "r1", totalStages: 4, artifacts: {} },
      { signal: signal ?? new AbortController().signal, heartbeat: () => {}, attempt: 1, documentIds, firstPassRun: true, pipelineOverride: firstPassPipeline, progressFromProcessCpu: false },
    )).usage,
  };
}

// Through the store's own connection: PGlite serves one protocol stream, and a direct query beside a running batch interleaves with it.
const searchable = async () => Object.fromEntries(((await (store as any).sql`select id, lexical_searchable_at as at from documents where run_id = 'r1' order by id`) as Array<{ id: string; at: Date | null }>).map((r) => [r.id, r.at !== null]));
const docStage = async (documentId: string, stage: string) => (await db.query<{ status: string }>(`select status from document_run_stage_states where document_id = $1 and stage_name = $2`, [documentId, stage])).rows[0]?.status;

beforeEach(async () => {
  resetExtractorPluginsForTest();
  resetFirstPassResultsForTest();
  setFirstPassPublishGate(recordedVerdictGate);
  registerFakeProvider();
  batchCalls = 0; singleRuns = 0; pageCounts = 0; lastJob = undefined; seen = []; piiFails = new Set(); embedHold = null;
  stored = new Map(); downloads = []; sourceBytes = new Map(); visionReplaces = new Set(); indexSkips = new Set(); indexThrows = new Set();
  // Production's PDF route: every PDF in a VM, page counts included.
  vi.stubEnv("DOCSLURP_PDF_MODE", "vm");
  await seed();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetExtractorPluginsForTest(); });

async function until(check: () => Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("first pass", () => {
  it("plans only this run's PDFs", async () => {
    const plan = await planFirstPass(store, "r1");
    expect(plan.batches.flat().sort()).toEqual(DOCS);
  });

  it("each document is lexical_searchable as soon as its text event is handled, while later files are still pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    script = async (_job, emit) => {
      await emit(textEvent(0));
      await gate;
      await emit(textEvent(1));
      await emit(textEvent(2));
    };
    const running = runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    await until(async () => (await searchable()).d0 === true);
    expect(await searchable()).toEqual({ d0: true, d1: false, d2: false });
    release();
    const result = await running;
    expect(await searchable()).toEqual({ d0: true, d1: true, d2: true });
    expect(result.indexed.sort()).toEqual(DOCS);
    expect(seen.filter((s) => s.stage === "index").map((s) => s.documentId).sort()).toEqual(DOCS);
    // Served from the batch: no single-document VM ran.
    expect(singleRuns).toBe(0);
    expect(seen.find((s) => s.stage === "extract-markdown" && s.documentId === "d1")?.served).toBe("doc d1 page 1");
    expect(result.timings.firstSearchableMs).not.toBeNull();
  });

  it("records the batch's measured page count before extraction runs, and bills nothing on an estimate", async () => {
    script = async (_job, emit) => { await emit(textEvent(0, 3)); await emit(textEvent(1)); await emit(textEvent(2)); };
    await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(seen.find((s) => s.stage === "extract-markdown" && s.documentId === "d0")?.pageCount).toBe(3);
    const row = (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = 'd0'`)).rows[0]!;
    expect(row).toEqual({ page_count: 3, page_count_source: "counted" });
    // The batch VM's cost is in the ledger.
    expect((await db.query<{ n: number }>(`select count(*)::int as n from usage_events where run_id = 'r1' and model = 'fake-batch-vm'`)).rows[0]!.n).toBe(1);
  });

  it("refuses a batch that names another organization's document before any VM work (cross-tenant)", async () => {
    script = async () => { throw new Error("must not run"); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: ["d0", "x0"] })).rejects.toThrow();
    expect(batchCalls).toBe(0);
  });

  it("refuses a batch whose documents the database places in another run, before any VM work", async () => {
    await db.exec(`update documents set org_id = 'o2' where id = 'd1'`);
    script = async () => { throw new Error("must not run"); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS })).rejects.toThrow("Batch mixes organizations or runs");
    expect(batchCalls).toBe(0);
  });

  it("a failed file fails only its document; a page-count refusal fails it, other failures are counted and handed back", async () => {
    script = async (_job, emit) => {
      await emit({ index: 0, phase: "failed", reason: "page-count", pageCountOutcome: "encrypted" });
      await emit(textEvent(1));
      await emit({ index: 2, phase: "failed", reason: "timeout" });
    };
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(result.indexed).toEqual(["d1"]);
    expect(result.handedBack).toEqual([{ documentId: "d0", reason: "page-count" }, { documentId: "d2", reason: "timeout" }]);
    expect(await docStage("d0", "first-pass:page-count")).toBe("failed");
    // d2 is counted the ordinary way (one VM page count) and left to the stage loop.
    expect((await db.query<{ status: string; error: string }>(`select status, error from document_run_stage_states where document_id = 'd2' and stage_name = 'first-pass:page-count'`)).rows[0]).toEqual({ status: "completed", error: null });
    expect((await db.query<{ s: string }>(`select page_count_source as s from documents where id = 'd2'`)).rows[0]!.s).toBe("counted");
    expect(await docStage("d2", "extract-markdown")).toBeUndefined();
    expect(await searchable()).toEqual({ d0: false, d1: true, d2: false });
  });

  it("a malformed provider event fails the batch, not another document", async () => {
    script = async (_job, emit) => { await emit(textEvent(0)); await emit({ index: 9, phase: "text", pages: 1, result: {} }); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS })).rejects.toThrow("unknown file index");
  });

  it("with piiPolicy.enabled a document is never lexical_searchable before its pii-detect completes; a blocked one is never stamped", async () => {
    await seed({ piiPolicy: { enabled: true, mode: "block", patterns: ["ssn"] } });
    piiFails = new Set(["d1"]);
    script = async (_job, emit) => { await emit(textEvent(0)); await emit(textEvent(1)); await emit(textEvent(2)); };
    await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    for (const id of ["d0", "d2"]) {
      const order = seen.filter((s) => s.documentId === id).map((s) => s.stage);
      expect(order.indexOf("pii-detect")).toBeLessThan(order.indexOf("embed"));
    }
    expect(await searchable()).toEqual({ d0: true, d1: false, d2: true });
    expect(seen.some((s) => s.stage === "embed" && s.documentId === "d1")).toBe(false);
  });

  it("publish gate: with quarantine on, nothing is published without a clean recorded verdict", async () => {
    await db.exec(`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts) values ('r1', 'd0', 'quarantine', 'completed', 1), ('r1', 'd1', 'quarantine', 'failed', 1)`);
    script = async (_job, emit) => { await emit(textEvent(0)); await emit(textEvent(1)); await emit(textEvent(2)); };
    const result = await runFirstPassBatch(deps({ quarantineEnabled: true }), { runId: "r1", documentIds: DOCS });
    expect(result.indexed).toEqual(["d0"]);
    expect(await searchable()).toEqual({ d0: true, d1: false, d2: false });
  });

  it("a replacement gate (a concurrent verdict) is consulted for every document before publishing", async () => {
    const asked: string[] = [];
    setFirstPassPublishGate({ awaitClean: async ({ documentId }) => { asked.push(documentId); return documentId !== "d2"; } });
    script = async (_job, emit) => { await emit(textEvent(0)); await emit(textEvent(1)); await emit(textEvent(2)); };
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(asked.sort()).toEqual(DOCS);
    expect(result.indexed.sort()).toEqual(["d0", "d1"]);
  });

  it("a document with textless pages is extracted but left to the stage loop for OCR before it is embedded", async () => {
    script = async (_job, emit) => { await emit(textEvent(0, 2, 0)); await emit(textEvent(1)); await emit(textEvent(2)); };
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(result.extracted).toEqual(["d0"]);
    expect(await docStage("d0", "extract-markdown")).toBe("completed");
    expect(await docStage("d0", "embed")).toBeUndefined();
    expect(await searchable()).toEqual({ d0: false, d1: true, d2: true });
  });

  it("a slow embedding of one group does not hold back documents that arrive after it", async () => {
    let release!: () => void;
    embedHold = { ids: new Set(["d0"]), until: new Promise<void>((resolve) => (release = resolve)) };
    let sent!: () => void;
    const allSent = new Promise<void>((resolve) => (sent = resolve));
    script = async (_job, emit) => {
      await emit(textEvent(0));
      await new Promise((r) => setTimeout(r, 50));
      await emit(textEvent(1));
      await emit(textEvent(2));
      sent();
    };
    const running = runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    await allSent;
    await until(async () => { const s = await searchable(); return s.d1 && s.d2; });
    expect((await searchable()).d0).toBe(false);
    release();
    await running;
    expect(await searchable()).toEqual({ d0: true, d1: true, d2: true });
  });

  it("fast quality reads the text layer only: a document with textless pages is embedded by the first pass", async () => {
    await seed({ quality: "fast" });
    script = async (_job, emit) => { await emit(textEvent(0, 2, 0)); await emit(textEvent(1)); await emit(textEvent(2)); };
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(result.extracted).toEqual([]);
    expect(await searchable()).toEqual({ d0: true, d1: true, d2: true });
  });
});

/** The ordinary stage loop after the first pass: an unsharded stage run of a first-pass run. */
async function loopStage(stageName: string) {
  const execution = createStageExecution({ store, stages: stages(), config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
  await execution.runStage({ stageName, runId: "r1", totalStages: 6, artifacts: {} },
    { signal: new AbortController().signal, heartbeat: () => {}, attempt: 1, firstPassRun: true, progressFromProcessCpu: false });
}
const all3 = async (_job: SandboxedPdfBatchJob, emit: (event: SandboxedPdfBatchEvent | Record<string, unknown>) => Promise<void>) => {
  await emit(textEvent(0)); await emit(textEvent(1)); await emit(textEvent(2));
};
const pageSource = async (id: string) => (await db.query<{ s: string }>(`select page_count_source as s from documents where id = $1`, [id])).rows[0]!.s;

describe("first pass: council #340 regressions", () => {
  it("H1: a credit refusal from the host's handler fails the batch with that RunPolicyError, even when the provider swallows it", async () => {
    await db.exec(`update organizations set credit_balance_cents = 0 where id = 'o1'`);
    // The reviewer's probe: a provider that catches the handler's rejection and carries on (the old host did).
    script = async (_job, emit) => {
      for (const event of [textEvent(0, 400), textEvent(1), textEvent(2)]) { try { await emit(event); } catch { /* swallowed */ } }
    };
    const error = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(RunPolicyError);
    // Nothing after the refusal was accepted or published.
    expect(await searchable()).toEqual({ d0: false, d1: false, d2: false });
    expect(seen.filter((s) => s.stage === "embed")).toEqual([]);
  });

  it("H1: a provider that follows the contract (rethrows the handler's rejection) fails the batch with the same error", async () => {
    await db.exec(`update organizations set credit_balance_cents = 0 where id = 'o1'`);
    script = async (_job, emit) => { await emit(textEvent(0, 400)); await emit(textEvent(1)); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS })).rejects.toBeInstanceOf(RunPolicyError);
  });

  it("H2: a failed batch leaves no PDF unmeasured: countFirstPassPages measures every one through the VM page count", async () => {
    script = async () => { throw new Error("Document VM execution failed"); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS })).rejects.toThrow("Document VM execution failed");
    expect(await pageSource("d0")).toBe("assumed");
    const counted = await countFirstPassPages({ store, storage: fakeStorage() as never }, { runId: "r1", documentIds: DOCS });
    expect(counted.counted).toBe(3);
    for (const id of DOCS) expect(await pageSource(id)).toBe("counted");
    expect(pageCounts).toBe(3);
    // Checkpointed: a retried count never measures twice.
    await countFirstPassPages({ store, storage: fakeStorage() as never }, { runId: "r1", documentIds: DOCS });
    expect(pageCounts).toBe(3);
  });

  it("H2: deferral uses the planner's predicate: an oversized or unsized PDF is counted by format-detect; the plan counts any PDF it leaves out", async () => {
    const pdf = { mimeType: "application/pdf", fileFacts: null, status: "processing" };
    expect(firstPassDefersPageCount({ firstPassRun: true }, { ...pdf, sourceBytes: 100 })).toBe(true);
    expect(firstPassDefersPageCount({ firstPassRun: true }, { ...pdf, sourceBytes: 2 << 20 })).toBe(false);
    expect(firstPassDefersPageCount({ firstPassRun: true }, { ...pdf, sourceBytes: null })).toBe(false);
    expect(firstPassDefersPageCount({ firstPassRun: false }, { ...pdf, sourceBytes: 100 })).toBe(false);
    await db.exec(`update documents set file_size = ${2 << 20} where id = 'd2'`);
    const plan = await planFirstPass(store, "r1");
    expect(plan.batches.flat().sort()).toEqual(["d0", "d1"]);
    expect(plan.countFirst).toEqual(["d2"]);
  });

  it("M1: a source whose staged bytes differ from the upload hash never enters the batch; it fails, the rest convert", async () => {
    const good = createHash("sha256").update(SOURCE).digest("hex");
    await db.exec(`update documents set source_sha256 = '${good}' where run_id = 'r1'`);
    sourceBytes.set("u1/k1", "%PDF-1.7 swapped after upload");
    script = async (job, emit) => { for (const file of job.files) await emit(textEvent(file.index)); };
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(lastJob!.files.map((file) => file.documentId)).toEqual(["d0", "d2"]);
    expect(result.handedBack).toEqual([{ documentId: "d1", reason: "refused" }]);
    expect(await docStage("d1", "first-pass:page-count")).toBe("failed");
    expect(result.indexed.sort()).toEqual(["d0", "d2"]);
    expect(SourceIntegrityError).toBeDefined();
  });

  it("C3: a rejected batch waits for its running drains (no stage still processing after it returns)", async () => {
    let release!: () => void;
    embedHold = { ids: new Set(["d0"]), until: new Promise<void>((r) => (release = r)) };
    script = async (_job, emit) => {
      await emit(textEvent(0));
      await until(async () => (await docStage("d0", "embed")) === "processing");
      throw new Error("provider lost after text");
    };
    let returned = false;
    const running = runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS }).catch(() => { returned = true; });
    await new Promise((r) => setTimeout(r, 200));
    expect(returned).toBe(false);
    release();
    await running;
    expect(returned).toBe(true);
    expect(await docStage("d0", "embed")).not.toBe("processing");
  });

  it("C4: every document is accounted for exactly once, a gate-withheld one handed back", async () => {
    setFirstPassPublishGate({ awaitClean: async ({ documentId }) => documentId !== "d2" });
    script = all3;
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    const ids = [...result.indexed, ...result.extracted, ...result.handedBack.map((x) => x.documentId)].sort();
    expect(ids).toEqual(DOCS);
    expect(result.handedBack).toEqual([{ documentId: "d2", reason: "withheld" }]);
  });

  it("C5: a rejected paid batch persists every VM's usage it carries", async () => {
    const vm = (model: string) => ({ provider: "modal", model, metric: "sandbox_compute", amount: 1, unit: "cent", costCents: 1 });
    script = async () => { throw Object.assign(new Error("refused guest"), { batchUsage: [vm("failed-batch-vm"), vm("failed-retry-vm")] }); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS })).rejects.toThrow("refused guest");
    const models = (await db.query<{ model: string }>(`select model from usage_events where run_id = 'r1' order by model`)).rows.map((r) => r.model);
    expect(models).toEqual(["failed-batch-vm", "failed-retry-vm"]);
    // A SandboxRunError's single usage event is billed too.
    await seed();
    script = async () => { throw Object.assign(new Error("refused guest"), { usage: vm("single-usage-vm") }); };
    await expect(runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS })).rejects.toThrow();
    expect((await db.query<{ n: number }>(`select count(*)::int as n from usage_events where model = 'single-usage-vm'`)).rows[0]!.n).toBe(1);
  });

  it("L2: the structural count is recorded and the processed pages bill, flagging the document partially extracted", async () => {
    script = async (_job, emit) => { await emit({ ...textEvent(0, 3), processedPages: 2 }); await emit(textEvent(1)); await emit(textEvent(2)); };
    await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect((await db.query<{ page_count: number }>(`select page_count from documents where id = 'd0'`)).rows[0]!.page_count).toBe(2);
    expect(seen.find((s) => s.stage === "extract-markdown" && s.documentId === "d0")?.served).toBe("doc d0 page 1\fdoc d0 page 2");
  });

  it("C1: the ordinary loop re-runs content stages whose Markdown a later stage replaced; unchanged documents are not embedded twice", async () => {
    await seed({ documentExtraction: { order: { pdf: ["vm-pdf"] } }, visionFallback: false, piiPolicy: { enabled: true, mode: "block", patterns: ["ssn"] } });
    script = all3;
    await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    seen = [];
    visionReplaces = new Set(["d0"]);
    for (const stage of ["extract-markdown", "vision-extract", "pii-detect", "embed"]) await loopStage(stage);
    // Same extraction as the first pass: extract-markdown is not run again.
    expect(seen.filter((s) => s.stage === "extract-markdown")).toEqual([]);
    expect(seen.filter((s) => s.stage === "pii-detect").map((s) => s.documentId)).toEqual(["d0"]);
    expect(seen.filter((s) => s.stage === "embed").map((s) => s.documentId)).toEqual(["d0"]);
    expect(singleRuns).toBe(0);
  });

  it("C1: a pipeline that extracts differently re-runs extract-markdown from the persisted batch result (no VM), and PII re-reads changed content", async () => {
    await seed({ piiPolicy: { enabled: true, mode: "block", patterns: ["ssn"] }, visionFallback: true });
    script = all3;
    await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    seen = [];
    resetFirstPassResultsForTest();
    // The loop runs in another activity: nothing of the batch is left in memory, only the persisted results.
    for (const stage of ["extract-markdown", "pii-detect", "embed"]) await loopStage(stage);
    expect(seen.filter((s) => s.stage === "extract-markdown").map((s) => s.served)).toEqual(["doc d0 page 1", "doc d1 page 1", "doc d2 page 1"]);
    expect(singleRuns).toBe(0);
    // Same Markdown as the first pass: no second PII scan or embedding.
    expect(seen.filter((s) => s.stage === "pii-detect" || s.stage === "embed")).toEqual([]);
  });

  it("N1: a document whose index checkpoint the index stage did not complete is never reported indexed; the loop indexes it exactly once", async () => {
    indexSkips = new Set(["d1"]);
    script = all3;
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(result.indexed.sort()).toEqual(["d0", "d2"]);
    expect(result.handedBack).toEqual([{ documentId: "d1", reason: "index-unconfirmed" }]);
    const ids = [...result.indexed, ...result.extracted, ...result.handedBack.map((x) => x.documentId)].sort();
    expect(ids).toEqual(DOCS);
    expect(await docStage("d1", "embed")).toBe("completed");
    expect(await docStage("d1", "index")).toBeUndefined();
    // The stage loop: embed is not run again, index runs for d1 alone, and a second loop pass runs nothing.
    indexSkips = new Set();
    seen = [];
    for (const stage of ["embed", "index"]) await loopStage(stage);
    expect(seen.map((s) => `${s.stage}:${s.documentId}`)).toEqual(["index:d1"]);
    seen = [];
    for (const stage of ["embed", "index"]) await loopStage(stage);
    expect(seen).toEqual([]);
    expect(await docStage("d1", "index")).toBe("completed");
  });

  it("N1: an index failure after embed fails that document as the ordinary loop would; it is handed back, never reported indexed", async () => {
    indexThrows = new Set(["d2"]);
    script = all3;
    const result = await runFirstPassBatch(deps(), { runId: "r1", documentIds: DOCS });
    expect(result.indexed.sort()).toEqual(["d0", "d1"]);
    expect(result.handedBack).toEqual([{ documentId: "d2", reason: "index-unconfirmed" }]);
    expect(await docStage("d2", "embed")).toBe("completed");
    expect(await docStage("d2", "index")).toBe("failed");
  });
});
