/*
 * The same-organization first-pass batch against a migrated database: several runs of one organization share one provider
 * job; the tenant rule, demux, per-run cancellation, a poisoned file and per-run billing are checked end to end.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedPdfJob } from "../extractors/plugins.js";
import type { SandboxedPdfBatchEvent, SandboxedPdfBatchJob } from "../extractors/sandboxed-pdf-batch.js";
import { OrgBatchScopeError, type SandboxedPdfOrgBatchJob } from "../extractors/sandboxed-pdf-org-batch.js";
import { currentPerfContext } from "../lib/perf-context.js";
import { firstPassPipeline, resetFirstPassResultsForTest, serveFirstPassResult } from "../pipeline/first-pass.js";
import { runOrgFirstPassBatch, type OrgFirstPassDeps } from "../pipeline/first-pass-org.js";
import { recordedVerdictGate, setFirstPassPublishGate } from "../pipeline/first-pass-gate.js";

let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let work: string;

const SOURCE = "%PDF-1.7 trusted test bytes; never parsed here";
const SOURCE_SHA = createHash("sha256").update(SOURCE).digest("hex");

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1, workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 } });
  work = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "first-pass-org-db-"));
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

/** Org o1: runs ra (da0, da1) and rb (db0); org o2: run rx (dx0). */
async function seed() {
  const doc = (id: string, org: string, project: string, run: string) =>
    `('${id}', '${org}', 'u1', '${project}', '${run}', '${id}.pdf', 'application/pdf', 'u1/${id}', 'processing', 1, 'assumed', 100, 1, '${SOURCE_SHA}')`;
  await db.exec(`
    delete from usage_events; delete from document_run_stage_states; delete from project_run_stage_states; delete from project_runs; delete from documents;
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com') on conflict do nothing;
    insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 100000), ('o2', 'Other', 'other', 'u1', 100000) on conflict do nothing;
    update organizations set credit_balance_cents = 100000;
    insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2') on conflict do nothing;
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total)
      values (100, 'ra', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 2, 2),
             (100, 'rb', 'o1', 'u1', 'w', 'upload', 'processing', 'extract', '{}', 1, 1),
             (100, 'rx', 'o2', 'u1', 'w2', 'upload', 'processing', 'extract', '{}', 1, 1);
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, file_size, parse_source_scan_version, parse_source_sha256)
      values ${[doc("da0", "o1", "w", "ra"), doc("da1", "o1", "w", "ra"), doc("db0", "o1", "w", "rb"), doc("dx0", "o2", "w2", "rx")].join(",")};
  `);
}

/** The fake VM's script: drives events for the merged (or single) job it was given. */
type Emit = (event: Record<string, unknown>) => Promise<void>;
type Script = (job: { files: Array<{ documentId: string; output: string }> }, emit: Emit) => Promise<void>;
let script: Script;
let orgJobs: SandboxedPdfOrgBatchJob[];
let singleJobs: SandboxedPdfBatchJob[];
let withOrgBatch = true;
const VM_COST = 4;

function registerFakeProvider() {
  const drive = async (job: { files: Array<{ documentId: string; output: string }> }, onEvent: (event: SandboxedPdfBatchEvent) => Promise<void>) => {
    await script(job, async (event) => {
      const text = event as { phase?: string; index: number; pages: number };
      const file = job.files[text.index];
      if (text.phase === "text" && file) await writeFile(file.output, Array.from({ length: text.pages }, (_, i) => `doc ${file.documentId} page ${i + 1}`).join("\f"));
      await onEvent(event as unknown as SandboxedPdfBatchEvent);
    });
    return { usage: [{ provider: "modal", model: "fake-batch-vm", metric: "sandbox_compute", amount: VM_COST, unit: "cent", costCents: VM_COST } as never] };
  };
  registerExtractorPlugin({ apiVersion: 1, name: "fake", sandboxedPdf: {
    id: "fake-vm", maxSourceBytes: 1 << 20, assertConfigured() {}, timeoutMs: () => 1000,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    pageCount: async () => ({ pages: 1 }),
    batch: {
      maxFiles: 8, maxBatchBytes: 1 << 20, maxBatchPages: 100,
      run: async (job, onEvent) => { singleJobs.push(job); return drive(job, onEvent); },
      ...(withOrgBatch ? { runOrgBatch: async (job: SandboxedPdfOrgBatchJob, onEvent: (event: SandboxedPdfBatchEvent) => Promise<void>) => { orgJobs.push(job); return drive(job, onEvent); } } : {}),
    },
  } });
}

const textEvent = (index: number, pages = 1) => ({
  index, phase: "text", pages,
  result: { exitCode: 0, stdout: "", stderr: "", layoutFacts: { version: "pdf-layout-facts@1", pages: Array.from({ length: pages }, (_, i) => ({ pageNumber: i + 1, known: true, words: 50 })) } },
});
const indexOf = (job: { files: Array<{ documentId: string }> }, documentId: string) => job.files.findIndex((f) => f.documentId === documentId);

let seen: Array<{ stage: string; runId: string; documentId: string; served?: string }>;

function stages(): Stage[] {
  const perDocument = (name: string, body?: (state: any, document: any) => Promise<Record<string, unknown> | void>): Stage => ({
    name,
    run: async (state) => {
      for (const document of [...state.documents]) {
        await runDocumentStage(state, document, name, `${document.id}:${name}`, name, async () => ({ stats: (await body?.(state, document)) ?? {} }));
        if (name !== "extract-markdown") seen.push({ stage: name, runId: state.run.id, documentId: document.id });
      }
    },
  });
  return [
    perDocument("extract-markdown", async (state, document) => {
      const output = path.join(work, `${document.id}-${Date.now()}-${Math.random()}.md`);
      const job: SandboxedPdfJob = { input: "/unused", output };
      const served = await serveFirstPassResult(currentPerfContext(), job);
      const text = served ? await readFile(output, "utf8") : undefined;
      seen.push({ stage: "extract-markdown", runId: state.run.id, documentId: document.id, served: text });
      state.artifactLedger.recordDocument(document.id, "markdown", `s3://t/markdown/${document.id}.json`);
      return { markdownSha256: createHash("sha256").update(text ?? "vm").digest("hex") };
    }),
    perDocument("embed", async (_state, document) => { await store.markDocumentLexicalSearchable(document.id); }),
    perDocument("index"),
  ];
}

function fakeStorage() {
  const download = async () => {
    const dir = await mkdtemp(path.join(work, "docslurp-src-"));
    const file = path.join(dir, "source.pdf");
    await writeFile(file, SOURCE);
    return file;
  };
  return { bucket: "t", downloadSourceToTempFile: download, downloadToTempFile: download, putJson: async () => {}, getJson: async () => { throw new Error("missing"); }, uri: (key: string) => `s3://t/${key}` };
}

function deps(overrides: Partial<OrgFirstPassDeps> = {}): OrgFirstPassDeps {
  const execution = createStageExecution({ store, stages: stages(), config: { workerDocConcurrency: 1, workerAdaptiveTuning: false } as Config });
  return {
    store, storage: fakeStorage() as never, quarantineEnabled: false, heartbeat: () => {}, cancelPollMs: 50, workDir: work,
    runStageFor: (runId) => async (stageName, documentIds, signal) => (await execution.runStage(
      { stageName, runId, totalStages: 3, artifacts: {} },
      { signal: signal ?? new AbortController().signal, heartbeat: () => {}, attempt: 1, documentIds, firstPassRun: true, pipelineOverride: firstPassPipeline, progressFromProcessCpu: false },
    )).usage,
    ...overrides,
  };
}

/** The VM's provider cost recorded against a run (`amount`, in cents for sandbox_compute; the test store prices cost_cents itself). */
const vmCost = async (runId: string) => Number((await db.query<{ c: string | null }>(`select sum(amount)::text as c from usage_events where run_id = $1 and model = 'fake-batch-vm'`, [runId])).rows[0]!.c ?? 0);
const searchableIds = async () => ((await (store as any).sql`select id from documents where lexical_searchable_at is not null order by id`) as Array<{ id: string }>).map((r) => r.id);
const pageCount = async (id: string) => (await db.query<{ page_count: number; page_count_source: string }>(`select page_count, page_count_source from documents where id = $1`, [id])).rows[0]!;

async function until(check: () => Promise<boolean> | boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ENTRIES = [{ runId: "ra", documentIds: ["da0", "da1"] }, { runId: "rb", documentIds: ["db0"] }];

beforeEach(async () => {
  resetExtractorPluginsForTest();
  resetFirstPassResultsForTest();
  setFirstPassPublishGate(recordedVerdictGate);
  withOrgBatch = true;
  registerFakeProvider();
  orgJobs = []; singleJobs = []; seen = [];
  vi.stubEnv("DOCSLURP_PDF_MODE", "vm");
  await seed();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetExtractorPluginsForTest(); });

describe("same-organization first-pass batch", () => {
  it("runs two runs of one organization in ONE provider job, each result reaching only its own run", async () => {
    script = async (job, emit) => { for (let i = 0; i < job.files.length; i++) await emit(textEvent(i, job.files[i]!.documentId === "da0" ? 3 : 1)); };
    const out = await runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    expect(orgJobs).toHaveLength(1);
    expect(singleJobs).toHaveLength(0);
    const job = orgJobs[0]!;
    expect(job.scope).toEqual({ orgId: "o1", runIds: ["ra", "rb"] });
    expect(job.files.map((f) => `${f.runId}:${f.documentId}`)).toEqual(["ra:da0", "ra:da1", "rb:db0"]);
    // The provider never sees a run's own folders: every path is the coalescer's.
    for (const file of job.files) expect(file.output.includes("docslurp-org-batch-")).toBe(true);
    expect(out.results.map((r) => r.status)).toEqual(["done", "done"]);
    const [ra, rb] = out.results as Array<Extract<typeof out.results[number], { status: "done" }>>;
    expect(ra!.output.indexed.sort()).toEqual(["da0", "da1"]);
    expect(rb!.output.indexed).toEqual(["db0"]);
    // Each extract-markdown was served its own document's text, inside its own run.
    for (const s of seen.filter((s) => s.stage === "extract-markdown")) expect(s.served).toMatch(new RegExp(`^doc ${s.documentId} page 1`));
    expect(new Set(seen.map((s) => `${s.runId}:${s.documentId}`))).toEqual(new Set(["ra:da0", "ra:da1", "rb:db0"]));
    expect(await searchableIds()).toEqual(["da0", "da1", "db0"]);
  });

  it("bills each run exactly: its own measured pages, and a page-weighted share of the VM that sums to the whole", async () => {
    script = async (job, emit) => { for (let i = 0; i < job.files.length; i++) await emit(textEvent(i, job.files[i]!.documentId === "da0" ? 3 : 1)); };
    await runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    expect(await pageCount("da0")).toEqual({ page_count: 3, page_count_source: "counted" });
    expect(await pageCount("db0")).toEqual({ page_count: 1, page_count_source: "counted" });
    // ra put 4 pages through the VM, rb 1: shares 4:1 of the one VM, nothing billed twice or dropped.
    expect(await vmCost("ra")).toBeCloseTo(VM_COST * 4 / 5, 4);
    expect(await vmCost("rb")).toBeCloseTo(VM_COST / 5, 4);
    expect((await vmCost("ra")) + (await vmCost("rb"))).toBe(VM_COST);
    expect(await vmCost("rx")).toBe(0);
  });

  it("refuses a cross-organization mix before any staging or VM work", async () => {
    script = async () => { throw new Error("no VM may run"); };
    await expect(runOrgFirstPassBatch(deps(), { orgId: "o1", entries: [...ENTRIES, { runId: "rx", documentIds: ["dx0"] }] })).rejects.toBeInstanceOf(OrgBatchScopeError);
    // The input organization is checked against the database, not trusted.
    await expect(runOrgFirstPassBatch(deps(), { orgId: "o2", entries: ENTRIES })).rejects.toBeInstanceOf(OrgBatchScopeError);
    // Another organization's document listed under one of this organization's runs.
    await expect(runOrgFirstPassBatch(deps(), { orgId: "o1", entries: [{ runId: "ra", documentIds: ["da0", "dx0"] }] })).rejects.toBeInstanceOf(OrgBatchScopeError);
    // A document listed under a run of the same organization that does not own it.
    await expect(runOrgFirstPassBatch(deps(), { orgId: "o1", entries: [{ runId: "ra", documentIds: ["da0", "db0"] }] })).rejects.toBeInstanceOf(OrgBatchScopeError);
    expect(orgJobs).toHaveLength(0);
    expect(singleJobs).toHaveLength(0);
    expect(await searchableIds()).toEqual([]);
  });

  it("refuses the merged job when the database's owners change before the VM (re-checked at the provider boundary)", async () => {
    script = async () => { throw new Error("no VM may run"); };
    const owners = store.documentScopes.bind(store);
    let merged = 0;
    // The run-level checks pass; the owner lookup the coalescer makes right before the VM says db0 moved organizations.
    const lying = Object.create(store, { documentScopes: { value: async (ids: readonly string[]) => {
      const map = await owners(ids);
      // Only the merged lookup (the second one of all three documents, after the activity's own check) lies.
      if (ids.length === 3 && ++merged === 2) map.set("db0", { ...map.get("db0")!, orgId: "o2" });
      return map;
    } } });
    const out = await runOrgFirstPassBatch(deps({ store: lying }), { orgId: "o1", entries: ENTRIES });
    expect(orgJobs).toHaveLength(0);
    expect(out.results.map((r) => r.status === "failed" ? r.reason : r.status)).toEqual(["scope-refused", "scope-refused"]);
  });

  it("refuses an event the host cannot route to its own run (the whole batch), and nothing reaches another run", async () => {
    script = async (_job, emit) => { await emit(textEvent(0)); await emit({ ...textEvent(7), index: 7 }); };
    const out = await runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    expect(out.results.every((r) => r.status === "failed")).toBe(true);
    expect(seen.filter((s) => s.stage === "extract-markdown" && s.runId === "rb")).toEqual([]);
  });

  it("a run cancelled mid-batch is detached alone: its documents are dropped, the other run finishes, the VM is billed once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    script = async (job, emit) => {
      await emit(textEvent(indexOf(job, "da0")));
      await gate;
      await emit(textEvent(indexOf(job, "db0")));
      await emit(textEvent(indexOf(job, "da1")));
    };
    const running = runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    await until(async () => (await searchableIds()).includes("da0"));
    await db.query(`update project_runs set control_state = 'cancel_requested' where id = 'rb'`);
    // The cancellation poll (50 ms here) detaches rb before its result is released.
    await new Promise((r) => setTimeout(r, 300));
    release();
    const out = await running;
    expect(out.results.find((r) => r.runId === "rb")?.status).toBe("cancelled");
    expect(out.results.find((r) => r.runId === "ra")?.status).toBe("done");
    expect(out.stats?.detached).toEqual(["rb"]);
    expect(seen.some((s) => s.runId === "rb")).toBe(false);
    expect(await searchableIds()).toEqual(["da0", "da1"]);
    expect((await vmCost("ra")) + (await vmCost("rb"))).toBe(VM_COST);
    expect(await vmCost("rb")).toBeGreaterThan(0);
  });

  it("a poisoned file fails only its own run's document; the other run is unaffected", async () => {
    script = async (job, emit) => {
      await emit({ index: indexOf(job, "db0"), phase: "failed", reason: "parser" });
      await emit(textEvent(indexOf(job, "da0")));
      await emit(textEvent(indexOf(job, "da1")));
    };
    const out = await runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    const rb = out.results.find((r) => r.runId === "rb") as Extract<typeof out.results[number], { status: "done" }>;
    expect(rb.output.indexed).toEqual([]);
    expect(rb.output.handedBack).toEqual([{ documentId: "db0", reason: "parser" }]);
    const ra = out.results.find((r) => r.runId === "ra") as Extract<typeof out.results[number], { status: "done" }>;
    expect(ra.output.indexed.sort()).toEqual(["da0", "da1"]);
  });

  it("a malformed result for one run's file ends that run's part only", async () => {
    script = async (job, emit) => {
      // pages 0 is out of bounds: rb's own handler refuses it.
      await emit({ ...textEvent(indexOf(job, "db0")), pages: 0 });
      await emit(textEvent(indexOf(job, "da0")));
      await emit(textEvent(indexOf(job, "da1")));
    };
    const out = await runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    expect(out.results.find((r) => r.runId === "rb")).toEqual({ runId: "rb", status: "failed", reason: "batch-failed" });
    expect(out.results.find((r) => r.runId === "ra")?.status).toBe("done");
    expect(await searchableIds()).toEqual(["da0", "da1"]);
    expect((await vmCost("ra")) + (await vmCost("rb"))).toBe(VM_COST);
  });

  it("a provider without runOrgBatch runs each run's own job, unmerged", async () => {
    withOrgBatch = false;
    resetExtractorPluginsForTest();
    registerFakeProvider();
    script = async (job, emit) => { for (let i = 0; i < job.files.length; i++) await emit(textEvent(i)); };
    const out = await runOrgFirstPassBatch(deps(), { orgId: "o1", entries: ENTRIES });
    expect(orgJobs).toHaveLength(0);
    expect(singleJobs.map((job) => job.scope.runId).sort()).toEqual(["ra", "rb"]);
    expect(out.results.map((r) => r.status)).toEqual(["done", "done"]);
    expect(await vmCost("ra")).toBe(VM_COST);
    expect(await vmCost("rb")).toBe(VM_COST);
  });
});
