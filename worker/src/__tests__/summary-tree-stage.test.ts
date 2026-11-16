import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  artifactUri,
  executionStageOrder,
  getPipelineStageOrder,
  BILLABLE_UNIT_METRICS,
  DISTINCT_TEST_PRICING,
  installTestPricing,
  normalizePipelineFeatures,
  resetPricingProviderForTests,
  UNIT_CHARGE_PROVIDER,
  pipelineStageOrder,
  pipelineTextOperationSchema,
  postIndexStages,
  stageDataFlow,
  type PipelineFeatures,
} from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { orgSpendRefusal, setSpendCheckConfig } from "../db/spend-check.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { artifactExportPath } from "../exports/build-document-export.js";
import type { Document, ProjectRun } from "../models.js";
import { runUsageEventStatements } from "../db/usage-event-store.js";
import { runSpentCents } from "../pipeline/checkpoints.js";
import { WorkflowState, type CheckpointStore } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import { createStages } from "../stages/index.js";
import {
  projectSummaryTreeEnabled,
  runSummaryTreeForDocument,
  SUMMARY_TREE_EMBEDDING_USAGE_METRIC,
  SUMMARY_TREE_STAGE,
  SUMMARY_TREE_USAGE_METRIC,
  SummaryTreeStage,
  type SummaryTreeOverrides,
  type SummaryTreeStorage,
} from "../stages/summary-tree.js";
import type { SummaryTreeModelRequest } from "../summary-tree/index.js";
import { WORKFLOW_STAGE_ORDER } from "../temporal/workflow-stage-order.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The `summary-tree` stage as the pipeline runs it: where it sits, when it runs, what it records in the run's
 * usage ledger and stage checkpoints. The model and the embedder are fakes; nothing is sent to a provider.
 */

const config = { costPer1kInputTokens: 0.001, costPer1kOutputTokens: 0.002, openRouterApiKey: "test-key" } as unknown as Config;
const enabledPipeline = (overrides: Record<string, unknown> = {}): PipelineFeatures => normalizePipelineFeatures({ summaryTree: { enabled: true }, ...overrides } as never);
const profile = resolveEmbeddingModel(config, enabledPipeline());
const MODEL = profile.model;
const DIM = profile.dimensions;
const BUCKET = "test-bucket";
const ON = { DOCSLURP_SUMMARY_TREE_BUILD: "on" };

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
let lanceRoot: string;
let spoolRoot: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
}, 60_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  await sql?.end();
  await server?.stop();
  await db?.close();
});

let logs: string[];
beforeEach(async () => {
  vi.restoreAllMocks();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.join(" ")); });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setSpendCheckConfig({ enabled: false, pages: 0, credits: 0 });
  // Every test starts as a deployment that does not charge; the "billing" tests install a pricing provider.
  resetPricingProviderForTests();
  lanceRoot = await mkdtemp(path.join(tmpdir(), "docslurp-summary-stage-lance-"));
  spoolRoot = await mkdtemp(path.join(tmpdir(), "docslurp-summary-stage-spool-"));
  await sql`delete from projects`;
  // The project's stored setting is on: the stage reads it before every document, whatever the run's snapshot says.
  await sql`insert into projects(id, org_id, user_id, name, pipeline) values ('w', 'o1', 'u1', 'W', ${sql.json({ summaryTree: { enabled: true } })})`;
});

afterEach(async () => {
  await rm(lanceRoot, { recursive: true, force: true });
  await rm(spoolRoot, { recursive: true, force: true });
});

class MemoryStorage implements SummaryTreeStorage {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, Buffer>();
  readonly opened: string[] = [];
  uri(key: string) { return artifactUri(this.bucket, key); }
  async getBytes(key: string) {
    const found = this.objects.get(key);
    if (!found) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    return found;
  }
  async putBytes(key: string, data: Uint8Array) { this.objects.set(key, Buffer.from(data)); }
  async listKeys(options?: { prefix?: string }) {
    return { keys: [...this.objects.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).sort(), truncated: false };
  }
  async deleteKeys(keys: string[]) { for (const key of keys) this.objects.delete(key); }
  async openStream(key: string) {
    this.opened.push(key);
    const data = await this.getBytes(key);
    return { stream: (async function* () { for (let at = 0; at < data.length; at += 64 * 1024) yield data.subarray(at, at + 64 * 1024); })() };
  }
}

function embedArtifact(documentId: string, leaves: number): Buffer {
  return Buffer.from(JSON.stringify({
    documentId,
    embedding: { provider: "test", model: MODEL, dimensions: DIM, runtime: "local" },
    chunks: Array.from({ length: leaves }, (_, index) => {
      const sectionIndex = Math.floor(index / 10);
      const vector = Array.from({ length: DIM }, (_, d) => Math.sin(index * 0.01 + d) * 0.05);
      vector[sectionIndex % DIM]! += 1;
      return {
        index, headingPath: [`Chapter ${Math.floor(sectionIndex / 6) + 1}`, `Section ${sectionIndex + 1}`], pageNumbers: [1 + Math.floor(index / 3)],
        vector, metadata: { rawText: `Section ${sectionIndex + 1} paragraph ${index} on the expansion plan.`, overlapIndex: 0 },
      };
    }),
  }));
}

async function seed(storage: MemoryStorage, pipeline: PipelineFeatures, documents: Array<{ id: string; leaves: number; mimeType?: string; format?: string }>) {
  await sql`insert into project_runs (monthly_reservation_cents,id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values (100, 'run-1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'summary-tree', '{}')`;
  const run = {
    id: "run-1", orgId: "o1", userId: "u1", projectId: "w", kind: "bulk-upload", status: "processing", stage: SUMMARY_TREE_STAGE,
    totalDocuments: documents.length, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
    pipeline, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as ProjectRun;
  const rows: Document[] = [];
  for (const document of documents) {
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, page_count, file_size)
      values (${document.id}, 'o1', 'u1', 'w', 'run-1', ${`${document.id}.md`}, ${document.mimeType ?? "text/markdown"}, ${`u1/src/${document.id}`}, 'processing', ${`/${document.id}`}, 10, 10)`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`vi-${document.id}`}, ${document.id}, 'lancedb', 'b', 'p', ${MODEL}, ${DIM})`;
    storage.objects.set(`u1/run-1/embeddings/${document.id}.json`, embedArtifact(document.id, document.leaves));
    rows.push({
      id: document.id, userId: "u1", runId: "run-1", filename: `${document.id}.md`, mimeType: document.mimeType ?? "text/markdown", sourceKey: `u1/src/${document.id}`,
      parseSourceDecision: "unscanned-allowed", status: "processing", extractionMode: "hybrid", pageCount: 10, createdAt: new Date(), updatedAt: new Date(),
    } as Document);
  }
  const state = new WorkflowState(run, rows);
  for (const document of documents) {
    state.artifactLedger.recordDocument(document.id, "normalizedFormat", document.format ?? "markdown");
    state.setDocumentStage({
      runId: "run-1", documentId: document.id, stageName: "embed", status: "completed", attempts: 1,
      artifactUri: storage.uri(`u1/run-1/embeddings/${document.id}.json`), stats: { chunks: document.leaves },
    } as unknown as Parameters<WorkflowState["setDocumentStage"]>[0]);
  }
  const store = {
    startDocumentStage: vi.fn(async () => undefined), completeDocumentStage: vi.fn(async () => undefined), failDocumentStage: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined), startRunStage: vi.fn(async () => undefined), completeRunStage: vi.fn(async () => undefined),
    failRunStage: vi.fn(async () => undefined), appendEvent: vi.fn(async () => undefined), setPageStageComplete: vi.fn(async () => undefined),
    getCompletedPages: vi.fn(async () => new Set<number>()),
  } satisfies CheckpointStore;
  state.store = store;
  return { state, store };
}

function fakes() {
  const requests: SummaryTreeModelRequest[] = [];
  const embedded: string[][] = [];
  const compactions: string[] = [];
  const overrides = (env: Record<string, string | undefined>): SummaryTreeOverrides => ({
    env, lanceRoot, tmpDirectory: spoolRoot, concurrency: 4,
    tableChanged: (changed) => { compactions.push(`${changed.scope.orgId}/${changed.scope.projectId}`); },
    summarize: async (request) => {
      requests.push(request);
      return { text: `Title ${request.nodeId}\nSummary of ${request.nodeId}.`, finishReason: "stop", usage: { inputTokens: 210, outputTokens: 55, metadata: { generationId: `gen-${requests.length}` } } };
    },
    embed: async (texts) => {
      embedded.push(texts);
      return texts.map((text) => Array.from({ length: DIM }, (_, d) => Math.sin(text.length + d)));
    },
  });
  return { requests, embedded, compactions, overrides };
}

const stageOf = (storage: MemoryStorage, overrides: SummaryTreeOverrides) =>
  new SummaryTreeStage({} as CommandRunner, storage, config, () => sql, overrides);

describe("placement", () => {
  it("is the last stage, after index, in every order a run can execute", () => {
    expect(pipelineStageOrder.at(-1)).toBe(SUMMARY_TREE_STAGE);
    expect(pipelineStageOrder.indexOf(SUMMARY_TREE_STAGE)).toBeGreaterThan(pipelineStageOrder.indexOf("index"));
    expect(WORKFLOW_STAGE_ORDER.at(-1)).toBe(SUMMARY_TREE_STAGE);
    const order = getPipelineStageOrder(enabledPipeline({ graphRag: true, pageIndex: true }));
    expect(order.at(-1)).toBe(SUMMARY_TREE_STAGE);
    // Time to searchable ends at `index`: with enrichment moved after it, the tree still runs after everything else.
    const moved = executionStageOrder(order, { indexBeforeEnrich: true });
    expect(moved.at(-1)).toBe(SUMMARY_TREE_STAGE);
    expect(moved.indexOf("index")).toBeLessThan(moved.indexOf(SUMMARY_TREE_STAGE));
    expect(postIndexStages).not.toContain(SUMMARY_TREE_STAGE);
    // Nothing a document needs to be searchable reads the tree.
    for (const stage of ["embed", "index"] as const) expect(stageDataFlow[stage].consumes ?? []).not.toContain("summary-tree");
    expect(stageDataFlow[SUMMARY_TREE_STAGE].alwaysRerun).toBeTruthy();
  });

  it("is in a run's plan only when the project turned the tree on", () => {
    expect(getPipelineStageOrder(normalizePipelineFeatures({}))).not.toContain(SUMMARY_TREE_STAGE);
    expect(getPipelineStageOrder(enabledPipeline())).toContain(SUMMARY_TREE_STAGE);
    expect(pipelineTextOperationSchema.options).toContain("summary-tree");
  });

  it("is created with the other stages and needs a database client", () => {
    const stages = createStages({ runner: {} as CommandRunner, storage: new MemoryStorage() as never, config: { ...config, databaseUrl: "postgres://worker@127.0.0.1:1/docslurp" } as Config });
    expect(stages.at(-1)?.name).toBe(SUMMARY_TREE_STAGE);
  });

  it("keeps its text artifact out of document exports", () => {
    expect(artifactExportPath(SUMMARY_TREE_STAGE, artifactUri(BUCKET, "u1/run-1/summary-tree/d1/summaries.jsonl"))).toBeNull();
  });
});

describe("stage", () => {
  it("makes zero model calls and writes nothing while the build switch is off", async () => {
    for (const env of [{}, { DOCSLURP_SUMMARY_TREE_BUILD: "off" }, { DOCSLURP_SUMMARY_TREE_BUILD: "maybe" }]) {
      await sql`delete from documents`;
      await sql`delete from project_runs`;
      const storage = new MemoryStorage();
      const { requests, embedded, overrides } = fakes();
      const { state, store } = await seed(storage, enabledPipeline(), [{ id: "d1", leaves: 300 }]);
      await stageOf(storage, overrides(env)).run(state);
      expect(requests).toEqual([]);
      expect(embedded).toEqual([]);
      expect(storage.opened).toEqual([]);
      expect(store.startDocumentStage).not.toHaveBeenCalled();
      expect(state.usageLedger.pendingCount).toBe(0);
      expect((await sql`select count(*)::int as n from document_summary_trees`)[0]).toMatchObject({ n: 0 });
    }
  });

  it("does nothing for a project that has not enabled the tree, whatever the switch says", async () => {
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    const { state, store } = await seed(storage, normalizePipelineFeatures({}), [{ id: "d1", leaves: 300 }]);
    await stageOf(storage, overrides(ON)).run(state);
    expect(requests).toEqual([]);
    expect(store.startDocumentStage).not.toHaveBeenCalled();
  });

  it("builds nothing on a replayed run snapshot once the project turned the tree off", async () => {
    // A reprocess or retry of a run created while the tree was on: the snapshot still says enabled.
    for (const stored of [{ summaryTree: { enabled: false } }, {}, { summaryTree: { enabled: "true" } }, { summaryTree: null }]) {
      await sql`delete from documents`;
      await sql`delete from project_runs`;
      await sql`update projects set pipeline = ${sql.json(stored)} where id = 'w'`;
      const storage = new MemoryStorage();
      const f = fakes();
      const { state, store } = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 60 }, { id: "long2", leaves: 60 }]);
      await stageOf(storage, f.overrides(ON)).run(state);
      expect(f.requests).toEqual([]);
      expect(f.embedded).toEqual([]);
      expect(storage.opened).toEqual([]);
      expect(await sql`select 1 from document_summary_trees`).toEqual([]);
      expect(state.usageLedger.pendingCount).toBe(0);
      expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "off", summaryTreeReason: "project-setting-off", modelCalls: 0 });
      expect(store.failDocumentStage).not.toHaveBeenCalled();
    }
  }, 60_000);

  it("reads the project's own organization: another organization's project with the same id cannot turn it on", async () => {
    await sql`update projects set pipeline = ${sql.json({ summaryTree: { enabled: false } })} where id = 'w'`;
    await sql`insert into "user"(id, name, email) values ('u9', 'Z', 'z@example.com') on conflict do nothing`;
    await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o9', 'Other', 'other9', 'u9') on conflict do nothing`;
    await sql`insert into projects(id, org_id, user_id, name, pipeline) values ('w9', 'o9', 'u9', 'W9', ${sql.json({ summaryTree: { enabled: true } })})`;
    expect(await projectSummaryTreeEnabled(sql, { orgId: "o1", projectId: "w" })).toBe(false);
    expect(await projectSummaryTreeEnabled(sql, { orgId: "o1", projectId: "w9" })).toBe(false);
    expect(await projectSummaryTreeEnabled(sql, { orgId: "o9", projectId: "w9" })).toBe(true);
    expect(await projectSummaryTreeEnabled(sql, { orgId: "o1", projectId: "missing" })).toBe(false);
  });

  it("stops building the run's remaining documents when the project turns the tree off mid-stage", async () => {
    const storage = new MemoryStorage();
    const f = fakes();
    const { state } = await seed(storage, enabledPipeline(), [{ id: "a", leaves: 60 }, { id: "b", leaves: 60 }]);
    state.docConcurrency = 1;
    const overrides = f.overrides(ON);
    const summarize = overrides.summarize!;
    overrides.summarize = async (request) => {
      // Turned off while the first document's last call is in flight.
      if (request.nodeId.startsWith("a:") && request.level > 1) await sql`update projects set pipeline = ${sql.json({ summaryTree: { enabled: false } })} where id = 'w'`;
      return await summarize(request);
    };
    await stageOf(storage, overrides).run(state);
    expect(f.requests.some((request) => request.nodeId.startsWith("b:"))).toBe(false);
    expect(storage.opened).toEqual(["u1/run-1/embeddings/a.json"]);
    expect(state.documentStage("b", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "off", summaryTreeReason: "project-setting-off" });
    expect(await sql`select document_id from document_summary_trees`).toEqual([{ document_id: "a" }]);
  }, 60_000);

  it("builds long documents, records a skip for the others, and stamps every usage event with org, project and run", async () => {
    const storage = new MemoryStorage();
    const { requests, embedded, compactions, overrides } = fakes();
    const { state, store } = await seed(storage, enabledPipeline(), [
      { id: "long", leaves: 300 },
      { id: "short", leaves: 12 },
      { id: "sheet", leaves: 300, format: "office-excel" },
      { id: "talk", leaves: 300, mimeType: "audio/mpeg", format: "unknown" },
    ]);
    await stageOf(storage, overrides(ON)).run(state);

    expect(requests).toHaveLength(36);
    expect(state.documentStage("long", SUMMARY_TREE_STAGE)).toMatchObject({
      status: "completed", artifactUri: artifactUri(BUCKET, "u1/run-1/summary-tree/long/summaries.jsonl"),
      stats: { summaryTreeStatus: "ready", leaves: 300, groups: 30, nodes: 36, levels: 3, modelCalls: 36, failedGroups: 0 },
    });
    expect(state.documentStage("short", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "skipped", summaryTreeSkipReason: "short", modelCalls: 0 });
    expect(state.documentStage("sheet", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "skipped", summaryTreeSkipReason: "format" });
    expect(state.documentStage("talk", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "skipped", summaryTreeSkipReason: "media" });
    // Short, spreadsheet and audio documents never had their artifact read.
    expect(storage.opened).toEqual(["u1/run-1/embeddings/long.json"]);
    expect(await sql`select document_id, status, skip_reason from document_summary_trees order by document_id`).toMatchObject([
      { document_id: "long", status: "ready", skip_reason: null },
      { document_id: "sheet", status: "skipped", skip_reason: "format" },
      { document_id: "short", status: "skipped", skip_reason: "short" },
      { document_id: "talk", status: "skipped", skip_reason: "media" },
    ]);
    // The artifact is the stage's registered artifact, under the run root.
    expect(state.artifacts[`long:${SUMMARY_TREE_STAGE}`]).toBe(artifactUri(BUCKET, "u1/run-1/summary-tree/long/summaries.jsonl"));
    expect(store.completeDocumentStage).toHaveBeenCalledTimes(4);
    // One compaction request for the table the ready tree was written to; none for the skipped documents.
    expect(compactions).toEqual(["o1/w"]);

    // One usage event per model attempt and per embedding request, through the run's ledger.
    const events = state.usageLedger.snapshot();
    const generation = events.filter((event) => event.metric === SUMMARY_TREE_USAGE_METRIC);
    const embedding = events.filter((event) => event.metric === SUMMARY_TREE_EMBEDDING_USAGE_METRIC);
    expect(state.usageLedger.runId).toBe("run-1");
    expect(generation).toHaveLength(36);
    expect(embedding).toHaveLength(embedded.length);
    for (const event of generation) {
      expect(event).toMatchObject({ provider: "openrouter", inputTokens: 210, outputTokens: 55, unit: "node", amount: 1 });
      expect(event.metadata).toMatchObject({ orgId: "o1", projectId: "w", runId: "run-1", documentId: "long", operation: "summary-tree", attempt: 1, finishReason: "stop" });
      expect(typeof event.metadata?.nodeId).toBe("string");
      expect(event.metadata?.generationId).toMatch(/^gen-/);
    }
    for (const event of embedding) expect(event.metadata).toMatchObject({ orgId: "o1", projectId: "w", runId: "run-1", documentId: "long" });
    expect(logs.filter((line) => line.startsWith(`[ai-usage] ${SUMMARY_TREE_USAGE_METRIC} model=`) && line.includes("input_tokens=210") && line.includes("output_tokens=55"))).toHaveLength(36);
    expect(logs.some((line) => line.includes("[summary-tree] run=run-1 document=long status=ready"))).toBe(true);
  }, 60_000);

  it("skips a completed checkpoint on a retried activity without a call", async () => {
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    const { state } = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
    const stage = stageOf(storage, overrides(ON));
    await stage.run(state);
    requests.length = 0;
    await stage.run(state);
    expect(requests).toEqual([]);
  }, 60_000);

  it("refuses before any call when privacy mode forbids a hosted model, and says so", async () => {
    const storage = new MemoryStorage();
    const { embedded, overrides } = fakes();
    const { state } = await seed(storage, { ...enabledPipeline(), privacyMode: "local-only" }, [{ id: "long", leaves: 300 }]);
    // No fake model: the real route would be used, and must not be reached.
    const { summarize: _summarize, ...withoutModel } = overrides(ON);
    await stageOf(storage, withoutModel).run(state);
    expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "blocked", summaryTreeReason: "privacy-mode", modelCalls: 0 });
    expect(embedded).toEqual([]);
    expect(state.usageLedger.pendingCount).toBe(0);
    expect((await sql`select status, error from document_summary_trees where document_id = 'long'`)[0]).toMatchObject({ status: "pending", error: "privacy-mode" });
  });

  it("stops at the run cost cap before the first call", async () => {
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    const { state } = await seed(storage, { ...enabledPipeline(), maxCostCents: 5 }, [{ id: "long", leaves: 300 }]);
    state.run.spentCents = 5;
    await stageOf(storage, overrides(ON)).run(state);
    expect(requests).toEqual([]);
    expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "partial", summaryTreeReason: "stopped:run-cost-cap", modelCalls: 0 });
  });
});

/** An arbitrary test price for the summary tree unit: no deployment's price. */
const UNIT = 0.75;
const charging = () => installTestPricing({ ...DISTINCT_TEST_PRICING, summaryTreeCallCredits: () => UNIT });

describe("billing: a deployment that charges for the tree", () => {
  beforeEach(async () => {
    await sql`delete from usage_events`;
    await sql`delete from credit_debits_pending`;
  });

  it("bills one unit per model call in the run's ledger, and the run's checkpoint writes and debits it for the run's organization", async () => {
    charging();
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    const { state } = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
    await stageOf(storage, overrides(ON)).run(state);
    expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "ready", modelCalls: 36 });
    expect(requests).toHaveLength(36);

    const events = state.usageLedger.snapshot();
    const charges = events.filter((event) => event.metric === BILLABLE_UNIT_METRICS.summaryTree);
    expect(charges).toHaveLength(36);
    for (const charge of charges) {
      expect(charge).toMatchObject({ provider: UNIT_CHARGE_PROVIDER, unit: "summary-call", amount: 1, costCents: UNIT });
      expect(charge.metadata).toMatchObject({ unitCharge: true, billable: true, feature: "summaryTree", orgId: "o1", projectId: "w", runId: "run-1", documentId: "long" });
    }
    // The run's spend (what its cost cap reads) is the billed units; the model's own cost bills nothing.
    expect(state.usageLedger.pendingBillableCents).toBeCloseTo(36 * UNIT, 9);
    expect(runSpentCents(state)).toBeCloseTo(36 * UNIT, 9);

    // The checkpoint's own statements (db/usage-event-store.ts): the events, and the organization's pending debit.
    const batch = state.usageLedger.checkpoint();
    const write = runUsageEventStatements({ client: sql, state, usageEvents: batch.events });
    for (const statement of write.statements) await statement;
    batch.commit();
    const rows = await sql<Array<{ org_id: string; project_id: string; run_id: string; cost_cents: number }>>`
      select org_id, project_id, run_id, cost_cents::float8 as cost_cents from usage_events where metric = ${BILLABLE_UNIT_METRICS.summaryTree}`;
    expect(rows).toHaveLength(36);
    for (const row of rows) expect(row).toMatchObject({ org_id: "o1", project_id: "w", run_id: "run-1", cost_cents: UNIT });
    expect((await sql`select coalesce(sum(cost_cents), 0)::float8 as cents from usage_events`)[0]!.cents).toBeCloseTo(36 * UNIT, 9);
    const [debit] = await sql<Array<{ credits: number; orgs: string[]; runs: string[] }>>`
      select sum(credits)::float8 as credits, array_agg(distinct org_id) as orgs, array_agg(distinct run_id) as runs from credit_debits_pending`;
    expect(debit).toMatchObject({ orgs: ["o1"], runs: ["run-1"] });
    expect(debit!.credits).toBeCloseTo(36 * UNIT, 9);
  }, 60_000);

  it("never bills past the run's cost cap by more than one unit, with four calls in flight", async () => {
    charging();
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    const cap = 9.5 * UNIT;
    const { state } = await seed(storage, { ...enabledPipeline(), maxCostCents: cap }, [{ id: "long", leaves: 300 }, { id: "longer", leaves: 300 }]);
    await stageOf(storage, overrides(ON)).run(state);
    const billed = runSpentCents(state);
    expect(billed).toBeGreaterThanOrEqual(cap);
    expect(billed).toBeLessThan(cap + UNIT);
    expect(requests).toHaveLength(10);
    expect(state.usageLedger.snapshot().filter((event) => event.metric === BILLABLE_UNIT_METRICS.summaryTree)).toHaveLength(10);
    const reasons = ["long", "longer"].map((id) => (state.documentStage(id, SUMMARY_TREE_STAGE)?.stats as { summaryTreeReason?: string }).summaryTreeReason);
    expect(reasons).toContain("stopped:run-cost-cap");
  }, 60_000);

  it("makes no call and reads nothing while the deployment has no price for the tree, and says why", async () => {
    // A pricing provider without a price for the tree's unit, then billing switched on with no provider at all.
    for (const setup of [() => ({ env: ON, install: true }), () => ({ env: { ...ON, DOCSLURP_BILL_INGEST: "true" }, install: false })]) {
      await sql`delete from documents`;
      await sql`delete from project_runs`;
      const { env, install } = setup();
      if (install) installTestPricing(DISTINCT_TEST_PRICING);
      else resetPricingProviderForTests();
      const storage = new MemoryStorage();
      const { requests, embedded, overrides } = fakes();
      const { state } = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
      await stageOf(storage, overrides(env)).run(state);
      expect(requests).toEqual([]);
      expect(embedded).toEqual([]);
      expect(storage.opened).toEqual([]);
      expect(state.usageLedger.pendingCount).toBe(0);
      expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "blocked", summaryTreeReason: "unpriced", modelCalls: 0 });
      expect((await sql`select count(*)::int as n from document_summary_trees`)[0]).toMatchObject({ n: 0 });
    }
  });

  it("refuses through the build's own check too: a caller that skips the stage's check still makes no call", async () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
    const recorded: unknown[] = [];
    const result = await runSummaryTreeForDocument({
      sql, storage, config, pipeline: enabledPipeline(), scope: { orgId: "o1", projectId: "w" }, runId: "run-1", runRoot: "u1/run-1",
      document: { id: "long", normalizedFormat: "markdown", mimeType: "text/markdown", chunkCount: 300 },
      embeddingArtifactUri: storage.uri("u1/run-1/embeddings/long.json"),
      usage: { record: (input, charge) => { recorded.push(input, charge); } },
      overrides: overrides(ON),
    });
    expect(result).toMatchObject({ status: "blocked", reason: "unpriced" });
    expect(requests).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("stage time budget", () => {
  it("stops starting calls past its budget: the document in progress is partial, the rest are not started, the run does not fail", async () => {
    const storage = new MemoryStorage();
    const { requests, overrides } = fakes();
    const { state, store } = await seed(storage, enabledPipeline(), [{ id: "first", leaves: 300 }, { id: "second", leaves: 300 }]);
    state.docConcurrency = 1;
    let clock = 0;
    const base = overrides(ON);
    await stageOf(storage, {
      ...base, concurrency: 1, stageBudgetMs: 10_000, now: () => clock,
      summarize: async (request) => {
        clock += 1_000; // every call takes a second of the budget
        return await base.summarize!(request);
      },
    }).run(state);

    expect(requests).toHaveLength(10);
    expect(state.documentStage("first", SUMMARY_TREE_STAGE)).toMatchObject({ status: "completed", stats: { summaryTreeStatus: "partial", summaryTreeReason: "stopped:stage-time-budget", modelCalls: 10 } });
    expect(state.documentStage("second", SUMMARY_TREE_STAGE)).toMatchObject({ status: "completed", stats: { summaryTreeStatus: "blocked", summaryTreeReason: "stage-time-budget", modelCalls: 0 } });
    expect(store.failDocumentStage).not.toHaveBeenCalled();
    expect(storage.opened).toEqual(["u1/run-1/embeddings/first.json"]);
    expect(await sql`select document_id, status, error from document_summary_trees order by document_id`).toMatchObject([
      { document_id: "first", status: "partial", error: "stopped:stage-time-budget" },
    ]);
    // The ten paid summaries are on disk for the next build.
    expect([...storage.objects.keys()].filter((key) => key.includes("/summary-tree/first/parts/"))).toHaveLength(10);
  }, 60_000);
});

describe("spend guard", () => {
  /** The organization's balance as the shared spend rule reads it (`org_spend_status`), far below any running-job floor or well above it. */
  const setBalance = (cents: number) => sql`update organizations set credit_balance_cents = ${cents} where id = 'o1'`;
  afterEach(async () => { await setBalance(0); });

  it("makes no call for an organization that is out of credits, through the stage's own default balance check", async () => {
    // Nothing is injected: the stage reaches `orgSpendRefusal` by itself, with the real spend rule switched on.
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await setBalance(-1_000_000);
    expect(await orgSpendRefusal(sql, { orgId: "o1", projectId: "w" })).toBe("credit_exhausted");
    const storage = new MemoryStorage();
    const f = fakes();
    const { state, store } = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
    await stageOf(storage, f.overrides(ON)).run(state);
    expect(f.requests).toEqual([]);
    expect(f.embedded).toEqual([]);
    expect(state.usageLedger.pendingCount).toBe(0);
    expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "blocked", summaryTreeReason: "credit_exhausted", modelCalls: 0 });
    expect(await sql`select status, error from document_summary_trees where document_id = 'long'`).toEqual([{ status: "pending", error: "credit_exhausted" }]);
    expect(store.failDocumentStage).not.toHaveBeenCalled();

    // The same organization with credits builds: the refusal above was the balance, not the fixture.
    await setBalance(1_000_000);
    expect(await orgSpendRefusal(sql, { orgId: "o1", projectId: "w" })).toBeNull();
    await sql`delete from documents`;
    await sql`delete from project_runs`;
    const funded = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
    await stageOf(storage, f.overrides(ON)).run(funded.state);
    expect(f.requests).toHaveLength(36);
    expect(funded.state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "ready" });
  }, 60_000);

  it("stops at the next window when the balance runs out mid-build: no model call or embedding request follows", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await setBalance(1_000_000);
    const storage = new MemoryStorage();
    const f = fakes();
    const { state } = await seed(storage, enabledPipeline(), [{ id: "long", leaves: 300 }]);
    const overrides = f.overrides(ON);
    const summarize = overrides.summarize!;
    let embeddedAtFlip = -1;
    overrides.summarize = async (request) => {
      // The organization's balance goes below its floor while the sixth call (the second window) is in flight.
      if (f.requests.length === 5) {
        await setBalance(-1_000_000);
        embeddedAtFlip = f.embedded.length;
      }
      return await summarize(request);
    };
    await stageOf(storage, overrides).run(state);
    expect(state.documentStage("long", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "partial", summaryTreeReason: "stopped:credit_exhausted" });
    // The window of four in flight finished and was committed with one embedding request.
    expect(f.requests).toHaveLength(8);
    expect(f.embedded.length).toBe(embeddedAtFlip + 1);
    expect(await sql`select status, error from document_summary_trees where document_id = 'long'`).toEqual([{ status: "partial", error: "stopped:credit_exhausted" }]);
  }, 60_000);

  it("stops every document of the stage when the run is paused or cancelled mid-build", async () => {
    for (const [control, reason] of [["pause_requested", "run-paused"], ["paused", "run-paused"], ["cancel_requested", "run-cancelled"], ["cancelled", "run-cancelled"]] as const) {
      await sql`delete from documents`;
      await sql`delete from project_runs`;
      const storage = new MemoryStorage();
      const f = fakes();
      const { state } = await seed(storage, enabledPipeline(), [{ id: "a", leaves: 300 }, { id: "b", leaves: 300 }]);
      state.docConcurrency = 1;
      const overrides = f.overrides(ON);
      const summarize = overrides.summarize!;
      overrides.summarize = async (request) => {
        if (f.requests.length === 1) await sql`update project_runs set control_state = ${control} where id = 'run-1'`;
        return await summarize(request);
      };
      await stageOf(storage, overrides).run(state);
      expect([control, state.documentStage("a", SUMMARY_TREE_STAGE)?.stats]).toEqual([control, expect.objectContaining({ summaryTreeStatus: "partial", summaryTreeReason: `stopped:${reason}` })]);
      // The first window of four finished; the second document made no call at all.
      expect(f.requests).toHaveLength(4);
      expect(f.requests.every((request) => request.nodeId.startsWith("a:"))).toBe(true);
      expect(state.documentStage("b", SUMMARY_TREE_STAGE)?.stats).toMatchObject({ summaryTreeStatus: "blocked", summaryTreeReason: reason, modelCalls: 0 });
    }
  }, 60_000);


  it("refuses a document of an organization that may not spend, through the default balance check", async () => {
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const storage = new MemoryStorage();
    const { requests, embedded, overrides } = fakes();
    await sql`insert into project_runs (monthly_reservation_cents,id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (100, 'run-1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'summary-tree', '{}')`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, page_count, file_size)
      values ('d1', 'o1', 'u1', 'w', 'run-1', 'd1.md', 'text/markdown', 'u1/src/d1', 'processing', '/d1', 10, 10)`;
    storage.objects.set("u1/run-1/embeddings/d1.json", embedArtifact("d1", 300));
    // The project is not this organization's: the shared spend rule answers `plan_not_entitled`.
    expect(await orgSpendRefusal(sql, { orgId: "o-unknown", projectId: "w" })).toBe("plan_not_entitled");
    expect(await orgSpendRefusal(sql, { orgId: null, projectId: "w" })).toBe("plan_not_entitled");

    const usage: unknown[] = [];
    const result = await runSummaryTreeForDocument({
      sql, storage, config, pipeline: enabledPipeline(), scope: { orgId: "o1", projectId: "w" }, runId: "run-1", runRoot: "u1/run-1",
      document: { id: "d1", normalizedFormat: "markdown", mimeType: "text/markdown" },
      embeddingArtifactUri: storage.uri("u1/run-1/embeddings/d1.json"),
      usage: { record: (input) => { usage.push(input); } },
      spendRefusal: () => orgSpendRefusal(sql, { orgId: "o-unknown", projectId: "w" }),
      overrides: overrides(ON),
    });
    expect(result).toMatchObject({ status: "blocked", reason: "plan_not_entitled" });
    expect(requests).toEqual([]);
    expect(embedded).toEqual([]);
    expect(usage).toEqual([]);
  });
});
