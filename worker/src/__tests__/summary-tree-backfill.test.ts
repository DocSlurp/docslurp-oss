import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { connect } from "@lancedb/lancedb";
import {
  artifactUri,
  BILLABLE_UNIT_METRICS,
  DISTINCT_TEST_PRICING,
  installTestPricing,
  normalizePipelineFeatures,
  resetPricingProviderForTests,
  SUMMARY_TREE_JOB_NOTES,
  UNIT_CHARGE_PROVIDER,
  type PipelineFeatures,
} from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import { jobCreditReserve } from "../db/chat-reserve.js";
import { orgSpendRefusal, setSpendCheckConfig } from "../db/spend-check.js";
import { flushPendingCreditDebits } from "../db/usage-event-store.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { providerBalanceProbe, readProviderBalance, setProviderBalanceProbe, type ProviderBalanceProbe } from "../lib/provider-balance-probe.js";
import { projectSummariesLocation } from "../stages/lancedb-summaries.js";
import { SUMMARY_TREE_EMBEDDING_USAGE_METRIC, SUMMARY_TREE_USAGE_METRIC, type SummaryTreeOverrides, type SummaryTreeStorage } from "../stages/summary-tree.js";
import { runSummaryTreeJobs, type SummaryTreeJobRunnerOptions } from "../summary-tree/backfill-job.js";
import type { SummaryTreeModelRequest } from "../summary-tree/index.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * The summary tree backfill job (summary-tree/backfill-job.ts) against a migrated Postgres, real LanceDB tables on
 * disk and an in-memory object store. The model and the embedder are fakes: nothing is sent to a provider.
 *
 * Costs: every fake model call reports 100 input and 50 output tokens, priced by the test config at 1 cent per
 * 1,000 input tokens and 2 cents per 1,000 output tokens, so one call costs 0.2 cents.
 *
 * Billing: every test starts as a deployment that does not charge (no pricing provider, no billing in the job's
 * environment), where the job's cap counts the model's own cost. The "billing" tests install a pricing provider: with
 * a price for the summary tree unit (an arbitrary test number), or without one.
 */

const config = { costPer1kInputTokens: 1, costPer1kOutputTokens: 2, openRouterApiKey: "test-key" } as unknown as Config;
const CALL_CENTS = 0.2;
const TREE: PipelineFeatures = normalizePipelineFeatures({ summaryTree: { enabled: true } } as never);
const profile = resolveEmbeddingModel(config, TREE);
const MODEL = profile.model;
const DIM = profile.dimensions;
const SPACE = { model: MODEL, dimensions: DIM };
const BUCKET = "test-bucket";
const ON = { DOCSLURP_SUMMARY_TREE_BUILD: "on", DOCSLURP_SUMMARY_TREE_SERVE: "on" };
/** A sixty-leaf document: six sections of ten leaves, one node above them. */
const BIG_LEAVES = 60;
const BIG_NODES = 7;

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
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com'), ('u2', 'B', 'b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1'), ('o2', 'Other', 'other', 'u2')`;
}, 60_000);

afterAll(async () => {
  setSpendCheckConfig(null);
  setProviderBalanceProbe(undefined);
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
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(`ERROR ${args.join(" ")}`); });
  setSpendCheckConfig({ enabled: false, pages: 0, credits: 0 });
  resetPricingProviderForTests();
  lanceRoot = await mkdtemp(path.join(tmpdir(), "docslurp-summary-job-lance-"));
  spoolRoot = await mkdtemp(path.join(tmpdir(), "docslurp-summary-job-spool-"));
  await sql`delete from usage_events`;
  await sql`delete from projects`;
  for (const [id, org, user] of [["w", "o1", "u1"], ["w2", "o1", "u1"], ["x", "o2", "u2"]] as const) {
    await sql`insert into projects(id, org_id, user_id, name, pipeline) values (${id}, ${org}, ${user}, ${id}, ${sql.json(TREE as unknown as postgres.JSONValue)})`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (${`run-${id}`}, ${org}, ${user}, ${id}, 'bulk-upload', 'completed', 'completed', '{}')`;
  }
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

type Project = "w" | "w2" | "x";
const orgOf = (project: Project) => (project === "x" ? "o2" : "o1");
const userOf = (project: Project) => (project === "x" ? "u2" : "u1");

function embedArtifact(documentId: string, leaves: number): Buffer {
  return Buffer.from(JSON.stringify({
    documentId,
    embedding: { provider: "test", model: MODEL, dimensions: DIM, runtime: "local" },
    chunks: Array.from({ length: leaves }, (_, index) => {
      const section = Math.floor(index / 10);
      const vector = Array.from({ length: DIM }, (_, d) => Math.sin(index * 0.01 + d) * 0.05);
      vector[section % DIM]! += 1;
      return {
        index, headingPath: [`Section ${section + 1}`], pageNumbers: [1 + Math.floor(index / 3)],
        vector, metadata: { rawText: `${documentId} section ${section + 1} paragraph ${index} on the expansion plan.`, overlapIndex: 0 },
      };
    }),
  }));
}

/** A completed, indexed document of a project, with its embed artifact and embed stage row. */
async function seedDocument(storage: MemoryStorage, project: Project, id: string, leaves: number, options: { artifact?: boolean } = {}) {
  const user = userOf(project);
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, page_count, file_size)
    values (${id}, ${orgOf(project)}, ${user}, ${project}, ${`run-${project}`}, ${`${id}.md`}, 'text/markdown', ${`${user}/src/${id}`}, 'completed', ${`/${id}`}, ${Math.ceil(leaves / 3)}, 10)`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', ${MODEL}, ${DIM})`;
  const key = `${user}/run-${project}/embeddings/${id}.json`;
  if (options.artifact !== false) storage.objects.set(key, embedArtifact(id, leaves));
  await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats)
    values (${`run-${project}`}, ${id}, 'embed', 'completed', 1, ${storage.uri(key)}, ${sql.json({ chunks: leaves })})`;
}

async function queueJob(project: Project, maxCostCents = 1_000, extra: { cursor?: string; id?: string } = {}): Promise<string> {
  const id = extra.id ?? `job-${project}-${Math.random().toString(36).slice(2, 8)}`;
  await sql`insert into summary_tree_jobs (id, org_id, project_id, user_id, max_cost_cents, documents_total, cursor)
    values (${id}, ${orgOf(project)}, ${project}, ${userOf(project)}, ${maxCostCents}, 0, ${extra.cursor ?? null})`;
  return id;
}

async function jobOf(id: string) {
  const [row] = await sql<Array<Record<string, unknown>>>`select * from summary_tree_jobs where id = ${id}`;
  return row!;
}
const treeOf = async (documentId: string) => (await sql<Array<Record<string, unknown>>>`select * from document_summary_trees where document_id = ${documentId}`)[0] ?? null;
const treeStatuses = async () => Object.fromEntries((await sql<Array<{ document_id: string; status: string }>>`select document_id, status from document_summary_trees order by document_id`).map((row) => [row.document_id, row.status]));

async function summaryRowsOf(project: Project): Promise<Array<{ id: string; documentId: string; runId: string }> | null> {
  const location = projectSummariesLocation({ orgId: orgOf(project), projectId: project }, SPACE, lanceRoot);
  const connection = await connect(location.uri);
  try {
    if (!(await connection.tableNames()).includes(location.table)) return null;
    const table = await connection.openTable(location.table);
    try {
      return await table.query().select(["id", "documentId", "runId"]).limit(100_000).toArray() as never;
    } finally {
      table.close();
    }
  } finally {
    connection.close();
  }
}

interface Fakes {
  storage: MemoryStorage;
  requests: SummaryTreeModelRequest[];
  env: Record<string, string | undefined>;
  /** Called before each fake model call answers; may throw, wait or change the world. */
  beforeAnswer: (request: SummaryTreeModelRequest, call: number) => Promise<void> | void;
  run(options?: Partial<SummaryTreeJobRunnerOptions>): Promise<number>;
}

function fakes(): Fakes {
  const storage = new MemoryStorage();
  const requests: SummaryTreeModelRequest[] = [];
  const env: Record<string, string | undefined> = { ...ON };
  const self: Fakes = {
    storage, requests, env,
    beforeAnswer: () => undefined,
    async run(options = {}) {
      const overrides: SummaryTreeOverrides = {
        env, lanceRoot, tmpDirectory: spoolRoot, tableChanged: () => undefined,
        summarize: async (request) => {
          requests.push(request);
          await self.beforeAnswer(request, requests.length);
          return { text: `Title ${request.nodeId}\nSummary of ${request.nodeId}.`, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 50, metadata: { generationId: `gen-${requests.length}` } } };
        },
        embed: async (texts) => texts.map((text) => Array.from({ length: DIM }, (_, d) => Math.sin(text.length + d))),
        ...options.overrides,
      };
      return await runSummaryTreeJobs(sql, {
        workerId: "worker-a", config, storage, env, balanceProbe: null, concurrency: 1, documentConcurrency: 1, parkMs: 0, probeTtlMs: 0,
        ...options, overrides,
      });
    },
  };
  return self;
}

/**
 * Model calls as the ledger holds them. Provider calls are recorded with their provider cost in metadata and bill
 * nothing by themselves (only price-card unit charges bill a customer).
 */
const modelUsage = async () => await sql<Array<{ org_id: string; project_id: string; provider_cents: number; metadata: Record<string, unknown> }>>`
  select org_id, project_id, (metadata->>'providerCostCents')::float8 as provider_cents, metadata from usage_events where metric = ${SUMMARY_TREE_USAGE_METRIC} order by created_at`;
const providerSpend = async (metric?: string) => (await sql<Array<{ cost: number; largest: number }>>`
  select coalesce(sum((metadata->>'providerCostCents')::float8), 0)::float8 as cost, coalesce(max((metadata->>'providerCostCents')::float8), 0)::float8 as largest
  from usage_events where (${metric ?? null}::text is null or metric = ${metric ?? null})`)[0]!;

describe("what a job builds", () => {
  it("builds the documents without a tree, skips ready and short ones, and records every call", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "c-small", 5);
    await seedDocument(f.storage, "w", "d-ready", BIG_LEAVES);
    // d-ready already has a servable tree for its current run and this embedding space.
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, built_at)
      values ('d-ready', 'o1', 'w', 'run-w', 'ready', ${MODEL}, ${DIM}, now())`;
    const jobId = await queueJob("w");

    expect(await f.run()).toBe(1);
    const job = await jobOf(jobId);
    expect(job).toMatchObject({
      status: "completed", error: null, documents_ready: 2, documents_skipped: 1, documents_partial: 0,
      nodes_built: 2 * BIG_NODES, model_calls: 2 * BIG_NODES, lease_owner: null, cursor: "c-small",
    });
    expect(Number(job.cost_cents)).toBeGreaterThanOrEqual(2 * BIG_NODES * CALL_CENTS);
    expect(await treeStatuses()).toEqual({ "a-big": "ready", "b-big": "ready", "c-small": "skipped", "d-ready": "ready" });
    // The ready document was not read, and the short one was marked without opening its artifact.
    expect(f.requests.every((request) => /^(a-big|b-big):/.test(request.nodeId))).toBe(true);
    expect(f.storage.opened.sort()).toEqual(["u1/run-w/embeddings/a-big.json", "u1/run-w/embeddings/b-big.json"]);
    // Summary rows carry each document's own run; the tree artifact is registered where the delete paths look.
    const rows = (await summaryRowsOf("w"))!;
    expect(rows).toHaveLength(2 * BIG_NODES);
    expect(rows.every((row) => row.runId === "run-w")).toBe(true);
    const registered = await sql<Array<{ document_id: string; artifact_uri: string }>>`
      select document_id, artifact_uri from document_run_stage_states where stage_name = 'summary-tree' order by document_id`;
    expect(registered.map((row) => row.document_id)).toEqual(["a-big", "b-big"]);
    expect(registered[0]!.artifact_uri).toBe(f.storage.uri("u1/run-w/summary-tree/a-big/summaries.jsonl"));
    // One usage event per model call, stamped with the job's tenant, plus the embedding requests.
    const usage = await modelUsage();
    expect(usage).toHaveLength(2 * BIG_NODES);
    expect(usage.every((event) => event.org_id === "o1" && event.project_id === "w" && event.metadata.summaryTreeJobId === jobId)).toBe(true);
    expect(usage.every((event) => Math.abs(event.provider_cents - CALL_CENTS) < 1e-9)).toBe(true);
    expect((await sql`select 1 from usage_events where metric = ${SUMMARY_TREE_EMBEDDING_USAGE_METRIC}`).length).toBeGreaterThan(0);
    expect(Number(job.cost_cents)).toBeCloseTo((await providerSpend()).cost, 6);
    expect(logs.filter((line) => line.startsWith(`[ai-usage] ${SUMMARY_TREE_USAGE_METRIC} model=`))).toHaveLength(2 * BIG_NODES);
    // Nothing left to do: no job is claimed, and a second job finds no document.
    expect(await f.run()).toBe(0);
    const again = await queueJob("w");
    await f.run();
    expect(await jobOf(again)).toMatchObject({ status: "completed", model_calls: 0, documents_ready: 0, documents_skipped: 0 });
    expect(f.requests).toHaveLength(2 * BIG_NODES);
  });

  it("marks many short documents skipped in batches, without reading an artifact or calling a model", async () => {
    const f = fakes();
    const count = 1_000;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
      select 'small-' || lpad(n::text, 5, '0'), 'o1', 'u1', 'w', 'run-w', 'small-' || n || '.md', 'text/markdown', 'u1/src/small-' || n, 'completed'
      from generate_series(1, ${count}) as n`;
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats)
      select 'run-w', id, 'embed', 'completed', 1, 's3://test-bucket/u1/run-w/embeddings/' || id || '.json', '{"chunks": 6}'::jsonb
      from documents where project_id = 'w'`;
    await seedDocument(f.storage, "w", "zz-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    const started = performance.now();
    await f.run({ batchSize: 200 });
    const elapsedMs = performance.now() - started;
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_skipped: count, documents_ready: 1, model_calls: BIG_NODES });
    const [skipped] = await sql<Array<{ count: number }>>`select count(*)::int as count from document_summary_trees where project_id = 'w' and status = 'skipped' and skip_reason = 'short'`;
    expect(skipped!.count).toBe(count);
    expect(f.storage.opened).toEqual(["u1/run-w/embeddings/zz-big.json"]);
    // Batched: a thousand documents are a handful of statements, far from a round trip each.
    expect(elapsedMs).toBeLessThan(20_000);
  }, 60_000);

  it("does not let a building row left by a dead worker block it, and leaves a live build alone", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-stale", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-live", BIG_LEAVES);
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, build_owner, embedding_model, dimension, updated_at)
      values ('a-stale', 'o1', 'w', 'run-w', 'building', 'run:run-w', ${MODEL}, ${DIM}, now() - interval '11 minutes'),
             ('b-live', 'o1', 'w', 'run-w', 'building', 'run:run-w', ${MODEL}, ${DIM}, now())`;
    const jobId = await queueJob("w");
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 1, model_calls: BIG_NODES });
    expect(await treeOf("a-stale")).toMatchObject({ status: "ready", build_owner: null });
    expect(await treeOf("b-live")).toMatchObject({ status: "building", build_owner: "run:run-w" });
    expect(f.requests.every((request) => request.nodeId.startsWith("a-stale:"))).toBe(true);
  });
});

describe("tenant boundary", () => {
  it("never touches another project's or another organization's documents, whatever its cursor says", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "m-mine", BIG_LEAVES);
    await seedDocument(f.storage, "w2", "a-other-project", BIG_LEAVES);
    await seedDocument(f.storage, "w2", "z-other-project", BIG_LEAVES);
    await seedDocument(f.storage, "x", "b-other-org", BIG_LEAVES);
    await seedDocument(f.storage, "x", "y-other-org", BIG_LEAVES);

    // A forged cursor naming another organization's document: it is only a position inside the job's own project.
    const forged = await queueJob("w", 1_000, { cursor: "b-other-org" });
    await f.run();
    expect(await jobOf(forged)).toMatchObject({ status: "completed", documents_ready: 1, cursor: "m-mine" });
    expect(await treeStatuses()).toEqual({ "m-mine": "ready" });
    expect(f.requests.every((request) => request.nodeId.startsWith("m-mine:"))).toBe(true);
    expect(f.storage.opened).toEqual(["u1/run-w/embeddings/m-mine.json"]);
    expect(await summaryRowsOf("w2")).toBeNull();
    expect(await summaryRowsOf("x")).toBeNull();
    expect((await summaryRowsOf("w"))!.every((row) => row.documentId === "m-mine")).toBe(true);
    const usage = await sql<Array<{ org_id: string; project_id: string }>>`select distinct org_id, project_id from usage_events`;
    expect(usage).toEqual([{ org_id: "o1", project_id: "w" }]);

    // A cursor past every id of the project finds nothing, in any project.
    const past = await queueJob("w", 1_000, { cursor: "zzzz" });
    const calls = f.requests.length;
    await f.run();
    expect(await jobOf(past)).toMatchObject({ status: "completed", documents_ready: 0, model_calls: 0 });
    expect(f.requests).toHaveLength(calls);
    expect(await treeStatuses()).toEqual({ "m-mine": "ready" });
  });

  it("fails a job whose project is not in its organization, and builds nothing", async () => {
    const f = fakes();
    await seedDocument(f.storage, "x", "b-other-org", BIG_LEAVES);
    // A job row naming organization o1 and project x (which belongs to o2).
    await sql`insert into summary_tree_jobs (id, org_id, project_id, user_id, max_cost_cents) values ('job-forged', 'o1', 'x', 'u1', 100)`;
    await f.run();
    expect(await jobOf("job-forged")).toMatchObject({ status: "failed", model_calls: 0 });
    expect(f.requests).toEqual([]);
    expect(await treeStatuses()).toEqual({});
  });
});

describe("usage", () => {
  it("is in the ledger and in the job's totals before the next call starts", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    const seen: Array<{ call: number; events: number; calls: number; cost: number }> = [];
    f.beforeAnswer = async (_request, call) => {
      const [events] = await sql<Array<{ count: number }>>`select count(*)::int as count from usage_events where metric = ${SUMMARY_TREE_USAGE_METRIC}`;
      const job = await jobOf(jobId);
      seen.push({ call, events: events!.count, calls: Number(job.model_calls), cost: Number(job.cost_cents) });
    };
    await f.run();
    // One call in flight at a time: when call n starts, the n - 1 before it are already recorded, with their cost.
    expect(seen.map((entry) => entry.events)).toEqual(Array.from({ length: BIG_NODES }, (_, index) => index));
    expect(seen.map((entry) => entry.calls)).toEqual(Array.from({ length: BIG_NODES }, (_, index) => index));
    for (const entry of seen) expect(entry.cost).toBeGreaterThanOrEqual((entry.call - 1) * CALL_CENTS - 1e-9);
    // A worker that dies here loses nothing: the totals a successor reads are the ledger's.
    expect(Number((await jobOf(jobId)).cost_cents)).toBeCloseTo((await providerSpend()).cost, 6);
  });
});

describe("cost cap", () => {
  it("never passes the cap by more than one group, with calls in flight", async () => {
    const f = fakes();
    for (const id of ["a", "b", "c", "d"]) await seedDocument(f.storage, "w", `${id}-big`, BIG_LEAVES);
    // Room for ten calls.
    const cap = 10 * CALL_CENTS;
    const jobId = await queueJob("w", cap);
    await f.run({ concurrency: 4, documentConcurrency: 2 });
    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.costCap });
    const spent = await providerSpend();
    // One group is one model call and the embedding of its summary (one embedding request covers a window of four).
    const embedding = await providerSpend(SUMMARY_TREE_EMBEDDING_USAGE_METRIC);
    expect(spent.cost).toBeGreaterThanOrEqual(cap);
    expect(spent.cost).toBeLessThanOrEqual(cap + CALL_CENTS + embedding.largest + 1e-9);
    expect(Number(job.cost_cents)).toBeCloseTo(spent.cost, 6);
    const paid = f.requests.length;
    expect(paid).toBeLessThanOrEqual(11);

    // A later job with room finishes the work and repeats no call whose answer was kept.
    const before = new Set(f.requests.map((request) => request.nodeId));
    const second = await queueJob("w", 1_000);
    await f.run({ concurrency: 4, documentConcurrency: 2 });
    expect(await jobOf(second)).toMatchObject({ status: "completed" });
    expect(Object.values(await treeStatuses())).toEqual(["ready", "ready", "ready", "ready"]);
    const repeated = f.requests.slice(paid).filter((request) => before.has(request.nodeId));
    expect(repeated).toEqual([]);
    expect(f.requests).toHaveLength(4 * BIG_NODES);
  });

  it("makes no call for a job that is already at its cap", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w", 1);
    await sql`update summary_tree_jobs set cost_cents = 1 where id = ${jobId}`;
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.costCap, model_calls: 0 });
    expect(f.requests).toEqual([]);
  });
});

/** An arbitrary test price for the summary tree unit: no deployment's price. */
const UNIT = 0.75;
const charging = (unit: number = UNIT) => installTestPricing({ ...DISTINCT_TEST_PRICING, summaryTreeCallCredits: () => unit });
/** A deployment that charges for work (a pricing provider is installed) but whose provider has no price for the tree. */
const chargingWithoutTreePrice = () => installTestPricing(DISTINCT_TEST_PRICING);
const unitCharges = async () => await sql<Array<{ org_id: string; project_id: string; run_id: string | null; provider: string; unit: string; cost_cents: number; metadata: Record<string, unknown> }>>`
  select org_id, project_id, run_id, provider, unit, cost_cents::float8 as cost_cents, metadata from usage_events where metric = ${BILLABLE_UNIT_METRICS.summaryTree} order by created_at`;
const billedCents = async () => (await sql<Array<{ cents: number }>>`select coalesce(sum(cost_cents), 0)::float8 as cents from usage_events`)[0]!.cents;
const pendingDebits = async (orgId: string) => (await sql<Array<{ credits: number; n: number }>>`
  select coalesce(sum(credits), 0)::float8 as credits, count(*)::int as n from credit_debits_pending where org_id = ${orgId}`)[0]!;

describe("billing: a deployment that charges for the tree", () => {
  beforeEach(async () => {
    await sql`delete from credit_debits_pending`;
    await sql`delete from credit_ledger`;
  });

  it("bills one unit per model call to the job's organization and project, and debits it as the graph rebuild's charge is", async () => {
    charging();
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "x", "other-org-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    await sql`update organizations set credit_balance_cents = 1000 where id in ('o1', 'o2')`;
    try {
      await f.run();
      const job = await jobOf(jobId);
      expect(job).toMatchObject({ status: "completed", documents_ready: 1, model_calls: BIG_NODES });
      expect(f.requests).toHaveLength(BIG_NODES);

      // One price-card unit charge per call, stamped with the job's own organization and project.
      const charges = await unitCharges();
      expect(charges).toHaveLength(BIG_NODES);
      for (const charge of charges) {
        expect(charge).toMatchObject({ org_id: "o1", project_id: "w", run_id: null, provider: UNIT_CHARGE_PROVIDER, unit: "summary-call", cost_cents: UNIT });
        expect(charge.metadata).toMatchObject({ unitCharge: true, billable: true, feature: "summaryTree", documentId: "a-big", summaryTreeJobId: jobId, priceCard: "test-1" });
      }
      // The calls themselves stay internal cost: recorded, never billed.
      for (const call of await modelUsage()) expect(call.metadata).toMatchObject({ billable: false });
      expect(await billedCents()).toBeCloseTo(BIG_NODES * UNIT, 9);
      // The job's spend is what was billed, not what the model cost.
      expect(Number(job.cost_cents)).toBeCloseTo(BIG_NODES * UNIT, 4);

      // The debit: pending rows for this organization only (the hot path never locks the organization's row), ...
      expect(await pendingDebits("o1")).toMatchObject({ n: BIG_NODES });
      expect((await pendingDebits("o1")).credits).toBeCloseTo(BIG_NODES * UNIT, 9);
      expect(await pendingDebits("o2")).toMatchObject({ n: 0, credits: 0 });
      const [pending] = await sql<Array<{ row: Record<string, unknown> }>>`select to_jsonb(p) as row from credit_debits_pending p where org_id = 'o1' limit 1`;
      expect(pending!.row).toMatchObject({ reason: "usage", run_id: null, metadata: { summaryTreeJobId: jobId } });
      expect(Object.values(pending!.row)).toContain("w");
      // ... which the flusher applies to the organization's balance and writes to the credit ledger.
      const flushed = await flushPendingCreditDebits(sql);
      expect(flushed.credits).toBeCloseTo(BIG_NODES * UNIT, 9);
      const [balances] = await sql<Array<{ o1: number; o2: number }>>`
        select (select credit_balance_cents::float8 from organizations where id = 'o1') as o1, (select credit_balance_cents::float8 from organizations where id = 'o2') as o2`;
      expect(balances!.o1).toBeCloseTo(1000 - BIG_NODES * UNIT, 6);
      expect(balances!.o2).toBe(1000);
      // The ledger is in dollars (credits / 100).
      const [ledger] = await sql<Array<{ dollars: number; orgs: string[] }>>`
        select coalesce(sum(-delta), 0)::float8 as dollars, array_agg(distinct org_id) as orgs from credit_ledger where delta < 0`;
      expect(ledger!.orgs).toEqual(["o1"]);
      expect(ledger!.dollars * 100).toBeCloseTo(BIG_NODES * UNIT, 6);
    } finally {
      await sql`update organizations set credit_balance_cents = 0 where id in ('o1', 'o2')`;
    }
  });

  it("never bills past the cap by more than one unit, with calls in flight", async () => {
    charging();
    const f = fakes();
    for (const id of ["a", "b", "c", "d"]) await seedDocument(f.storage, "w", `${id}-big`, BIG_LEAVES);
    // Room for nine units and a half: the model's own cost (0.2 cents a call) would never reach this cap.
    const cap = 9.5 * UNIT;
    const jobId = await queueJob("w", cap);
    await f.run({ concurrency: 4, documentConcurrency: 2 });
    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.costCap, model_calls: 10 });
    const billed = await billedCents();
    expect(billed).toBeGreaterThanOrEqual(cap);
    expect(billed).toBeLessThan(cap + UNIT);
    expect(Number(job.cost_cents)).toBeCloseTo(billed, 4);
    expect((await pendingDebits("o1")).credits).toBeCloseTo(billed, 9);
    // Every call that was made is billed: no paid call without its unit.
    expect(await unitCharges()).toHaveLength(f.requests.length);
  });

  it("stops when the organization's balance runs out mid-job, because the units it billed moved the balance", async () => {
    const unit = 5;
    charging(unit);
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    const balance = 10;
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await sql`update organizations set credit_balance_cents = ${balance} where id = 'o1'`;
    try {
      expect(await orgSpendRefusal(sql, { orgId: "o1", projectId: "w" })).toBeNull();
      await f.run();
      // A running job may finish down to the running-job floor; the first window that finds the balance below it stops.
      const calls = Math.floor((balance - jobCreditReserve()) / unit) + 1;
      expect(calls).toBeLessThan(2 * BIG_NODES);
      expect(f.requests).toHaveLength(calls);
      expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "credits", model_calls: calls });
      // Nothing but the job's own units changed the organization: no budget pause, no manual balance edit.
      const [status] = await sql<Array<{ available: number; org_budget_paused: boolean }>>`
        select available::float8 as available, org_budget_paused from org_spend_status('o1', 'w', 0)`;
      expect(status).toMatchObject({ org_budget_paused: false });
      expect(status!.available).toBeCloseTo(balance - calls * unit, 6);
      expect(await orgSpendRefusal(sql, { orgId: "o1", projectId: "w" })).toBe("credit_exhausted");

      // A parked job does not spend: looked at again, it makes no call until the organization has credits.
      await f.run();
      expect(f.requests).toHaveLength(calls);
      await sql`update organizations set credit_balance_cents = 1000 where id = 'o1'`;
      await f.run();
      expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 2, model_calls: 2 * BIG_NODES });
      expect(await billedCents()).toBeCloseTo(2 * BIG_NODES * unit, 6);
    } finally {
      setSpendCheckConfig({ enabled: false, pages: 0, credits: 0 });
      await sql`update organizations set credit_balance_cents = 0 where id = 'o1'`;
    }
  });

  it("claims and calls nothing while the deployment has no price for the tree", async () => {
    chargingWithoutTreePrice();
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    expect(await f.run()).toBe(0);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "unpriced", model_calls: 0, lease_owner: null, started_at: null });
    expect(f.requests).toEqual([]);
    expect(f.storage.opened).toEqual([]);
    expect((await sql`select count(*)::int as n from usage_events`)[0]).toMatchObject({ n: 0 });
    expect(await treeOf("a-big")).toBeNull();

    // Billing switched on by the environment alone, with no provider at all, is unpriced too: never the open default.
    resetPricingProviderForTests();
    f.env.DOCSLURP_BILL_INGEST = "true";
    expect(await f.run()).toBe(0);
    expect(f.requests).toEqual([]);
    delete f.env.DOCSLURP_BILL_INGEST;

    // With a price, the same job runs and bills.
    charging();
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 1 });
    expect(await unitCharges()).toHaveLength(BIG_NODES);
  });

  it("parks at the next window when the price goes missing mid-job, and bills the call that was in flight", async () => {
    charging();
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.beforeAnswer = (_request, call) => {
      if (call === 2) chargingWithoutTreePrice();
    };
    await f.run();
    expect(f.requests).toHaveLength(2);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "unpriced", model_calls: 2, documents_ready: 0, cursor: null });
    expect(await treeOf("a-big")).toMatchObject({ status: "partial", error: "stopped:unpriced" });
    // Both calls were admitted under a price, and both are billed at it.
    expect((await unitCharges()).map((charge) => charge.cost_cents)).toEqual([UNIT, UNIT]);
  });
});

describe("stopping and parking", () => {
  it("stops a cancelled job before its next call and keeps what was built", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.beforeAnswer = async (_request, call) => {
      if (call === 3) await sql`update summary_tree_jobs set cancel_requested_at = now() where id = ${jobId}`;
    };
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.cancelled, model_calls: 3, lease_owner: null });
    // The call in flight when the request landed finished; none started after it, in this document or the next.
    expect(f.requests).toHaveLength(3);
    expect(await treeStatuses()).toEqual({ "a-big": "partial" });
    expect((await summaryRowsOf("w"))!).toHaveLength(3);
  });

  it("parks when the build switch goes off mid-job, makes no further call, and resumes without repeating one", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.beforeAnswer = (_request, call) => {
      if (call === 4) f.env.DOCSLURP_SUMMARY_TREE_BUILD = "off";
    };
    expect(await f.run()).toBe(1);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "build-off", model_calls: 4, lease_owner: null, lease_expires_at: null });
    expect(f.requests).toHaveLength(4);

    // Still off: the job is looked at, parked again, and nothing is called.
    expect(await f.run()).toBe(0);
    expect(await f.run()).toBe(0);
    expect(f.requests).toHaveLength(4);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "build-off" });

    f.env.DOCSLURP_SUMMARY_TREE_BUILD = "on";
    f.beforeAnswer = () => undefined;
    expect(await f.run()).toBe(1);
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", blocked_reason: null, documents_ready: 2, model_calls: 2 * BIG_NODES });
    // Every node was called exactly once across the park.
    expect(new Set(f.requests.map((request) => request.nodeId)).size).toBe(2 * BIG_NODES);
    expect(f.requests).toHaveLength(2 * BIG_NODES);
  });

  it("does not claim a job while the build switch is off", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.env.DOCSLURP_SUMMARY_TREE_BUILD = "off";
    expect(await f.run()).toBe(0);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "build-off", started_at: null, model_calls: 0 });
    expect(f.requests).toEqual([]);
    expect(f.storage.opened).toEqual([]);
  });

  it("parks as blocked when the balance probe reports below its floor, before the claim and between batches", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    let sufficient = false;
    const asked: string[] = [];
    const probe: ProviderBalanceProbe = { check: async (request) => { asked.push(request.purpose); return { sufficient }; } };

    expect(await f.run({ balanceProbe: probe })).toBe(0);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "balance", started_at: null, model_calls: 0 });
    expect(f.requests).toEqual([]);
    expect(asked).toEqual(["summary-tree-backfill"]);

    // Enough again: the job runs; the balance drops while the first document is being built.
    sufficient = true;
    f.beforeAnswer = (_request, call) => { if (call === 2) sufficient = false; };
    expect(await f.run({ balanceProbe: probe, batchSize: 1 })).toBe(1);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "balance", documents_ready: 0, model_calls: 2, lease_owner: null });
    // The window in flight finished (its call was already admitted); the next window never started.
    expect(f.requests).toHaveLength(2);

    // A probe that cannot answer reads as below the floor.
    const broken: ProviderBalanceProbe = { check: async () => { throw new Error("unreachable"); } };
    expect(await f.run({ balanceProbe: broken })).toBe(0);
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "balance" });
    expect(f.requests).toHaveLength(2);

    sufficient = true;
    f.beforeAnswer = () => undefined;
    await f.run({ balanceProbe: probe });
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 2, model_calls: 2 * BIG_NODES });
  });

  it("parks when the organization may not spend, and cancels when the project turned the tree off", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    // The job asks before it selects a document: a refusal parks it with no document touched and no artifact read,
    // however often the parked job is looked at again.
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await sql`update organizations set budget_paused = true where id = 'o1'`;
    try {
      expect(await orgSpendRefusal(sql, { orgId: "o1", projectId: "w" })).toBe("org_budget_paused");
      for (let look = 0; look < 3; look++) await f.run();
      expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "credits", model_calls: 0, documents_ready: 0, cursor: null, park_count: 3 });
      expect(f.requests).toEqual([]);
      expect(f.storage.opened).toEqual([]);
      expect(await treeOf("a-big")).toBeNull();
    } finally {
      setSpendCheckConfig({ enabled: false, pages: 0, credits: 0 });
      await sql`update organizations set budget_paused = false where id = 'o1'`;
    }

    await sql`update projects set pipeline = ${sql.json(normalizePipelineFeatures(null) as unknown as postgres.JSONValue)} where id = 'w'`;
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.disabled, model_calls: 0 });
    expect(f.requests).toEqual([]);
  });
});

describe("spend and the project setting, between windows of a running job", () => {
  it("parks at the next window when the organization's budget pauses mid-build, and resumes without repeating a call", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await sql`update organizations set credit_balance_cents = 1000000 where id = 'o1'`;
    try {
      f.beforeAnswer = async (_request, call) => {
        if (call === 2) await sql`update organizations set budget_paused = true where id = 'o1'`;
      };
      await f.run();
      // One call a window (concurrency 1): the call in flight finished, the next window asked and was refused.
      expect(f.requests).toHaveLength(2);
      expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "credits", model_calls: 2, documents_ready: 0, cursor: null });
      expect(await treeOf("a-big")).toMatchObject({ status: "partial", error: "stopped:org_budget_paused" });
      expect(await treeOf("b-big")).toBeNull();

      await sql`update organizations set budget_paused = false where id = 'o1'`;
      f.beforeAnswer = () => undefined;
      await f.run();
      expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 2 });
      expect(f.requests).toHaveLength(2 * BIG_NODES);
    } finally {
      setSpendCheckConfig({ enabled: false, pages: 0, credits: 0 });
      await sql`update organizations set budget_paused = false, credit_balance_cents = 0 where id = 'o1'`;
    }
  });

  it("ends the job at the next window when the project turns the tree off mid-build, and starts no other document", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.beforeAnswer = async (_request, call) => {
      if (call === 3) await sql`update projects set pipeline = jsonb_set(pipeline, '{summaryTree}', '{"enabled": false}'::jsonb) where id = 'w'`;
    };
    await f.run();
    expect(f.requests).toHaveLength(3);
    expect(await jobOf(jobId)).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.disabled, model_calls: 3, documents_ready: 0 });
    expect(await treeOf("a-big")).toMatchObject({ status: "partial", error: "stopped:project-setting-off" });
    expect(await treeOf("b-big")).toBeNull();
    expect(f.storage.opened).toEqual(["u1/run-w/embeddings/a-big.json"]);
  });
});

describe("settings that change while a job runs", () => {
  const setPipeline = async (path: string, value: unknown) =>
    await sql`update projects set pipeline = jsonb_set(pipeline, ${`{${path}}`}::text[], ${JSON.stringify(value)}::text::jsonb) where id = 'w'`;

  it("makes no further hosted call from the next window on once the project leaves standard privacy mode", async () => {
    for (const mode of ["local-only", "strict-privacy"]) {
      await sql`delete from summary_tree_jobs`;
      await sql`delete from documents`;
      await setPipeline("privacyMode", "standard");
      const f = fakes();
      await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
      await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
      const jobId = await queueJob("w");
      f.beforeAnswer = async (_request, call) => {
        if (call === 2) await setPipeline("privacyMode", mode);
      };
      await f.run();
      // One call a window: the call in flight when the mode changed finished; the next window asked and was refused.
      expect(f.requests, mode).toHaveLength(2);
      expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "policy", model_calls: 2, documents_ready: 0, cursor: null });
      expect(await treeOf("a-big")).toMatchObject({ status: "partial", error: "stopped:privacy-mode" });
      expect(await treeOf("b-big")).toBeNull();
      // strict-privacy records the blocked attempt, attributed to the project.
      const [audit] = await sql<Array<{ n: number }>>`select count(*)::int as n from privacy_audit_log where project_id = 'w'`;
      expect(audit!.n > 0, mode).toBe(mode === "strict-privacy");
      await sql`delete from privacy_audit_log`;

      // Looked at again while the mode stands: parked before any document is selected, and no call.
      f.beforeAnswer = () => undefined;
      await f.run();
      expect(f.requests).toHaveLength(2);
      expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "policy", park_count: 2 });
      expect(f.storage.opened).toEqual(["u1/run-w/embeddings/a-big.json"]);

      // Back in standard mode the job continues and repeats no call.
      await setPipeline("privacyMode", "standard");
      await f.run();
      expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 2 });
      expect(f.requests).toHaveLength(2 * BIG_NODES);
    }
  });

  it("does not claim a hosted call for a job whose project is already outside standard mode", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await setPipeline("privacyMode", "strict-privacy");
    const jobId = await queueJob("w");
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "blocked", blocked_reason: "policy", model_calls: 0 });
    expect(f.requests).toEqual([]);
    expect(f.storage.opened).toEqual([]);
  });

  it("builds the rest with the model the project has now when it changes mid-job", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.beforeAnswer = async (_request, call) => {
      if (call === 2) await setPipeline("textGeneration", { model: "vendor/other-model", models: {} });
    };
    await f.run();
    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "completed", documents_ready: 1 });
    // The document stopped at the window after the change and was rebuilt by the next batch: the two answers written
    // by the earlier model are not part of the tree (a node's hash covers the model), so every node was asked again.
    expect(f.requests).toHaveLength(2 + BIG_NODES);
    const models = (await modelUsage()).map((call) => String((call.metadata as { model?: string }).model ?? ""));
    expect(models).toHaveLength(2 + BIG_NODES);
    const usage = await sql<Array<{ model: string; n: number }>>`select model, count(*)::int as n from usage_events where metric = ${SUMMARY_TREE_USAGE_METRIC} group by model order by min(created_at)`;
    expect(usage.map((row) => row.n)).toEqual([2, BIG_NODES]);
    expect(usage[1]!.model).toContain("other-model");
    expect(await treeOf("a-big")).toMatchObject({ status: "ready" });
  });

  it("asks the provider balance probe before every window, not once a batch", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    let sufficient = true;
    let asked = 0;
    const probe: ProviderBalanceProbe = { check: async () => { asked += 1; return sufficient ? { sufficient: true } : { sufficient: false, retryAfterSeconds: 90 }; } };
    f.beforeAnswer = (_request, call) => {
      if (call === 3) sufficient = false;
    };
    // Both documents are in one batch: a probe asked once a batch would let all fourteen calls through.
    await f.run({ balanceProbe: probe, probeTtlMs: 0 });
    expect(f.requests).toHaveLength(3);
    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "blocked", blocked_reason: "balance", model_calls: 3, documents_ready: 0, cursor: null });
    expect(await treeOf("a-big")).toMatchObject({ status: "partial", error: "stopped:provider-balance" });
    // The probe's own retry interval is the job's wait.
    const [wait] = await sql<Array<{ seconds: number }>>`select extract(epoch from (resume_after - updated_at))::float8 as seconds from summary_tree_jobs where id = ${jobId}`;
    expect(wait!.seconds).toBeCloseTo(90, 0);
    // Before the claim, before the batch, and before each of the windows that started.
    expect(asked).toBeGreaterThanOrEqual(5);

    // A sufficient reading is reused within its lifetime: many windows, few questions.
    sufficient = true;
    asked = 0;
    f.beforeAnswer = () => undefined;
    await sql`update summary_tree_jobs set resume_after = now() where id = ${jobId}`;
    await f.run({ balanceProbe: probe, probeTtlMs: 60_000 });
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 2 });
    expect(asked).toBe(1);
  });
});

describe("fair claiming, parking and time slices", () => {
  /** One more project of an organization, with its run, so the organization can hold another active job. */
  async function addProject(id: string, org: "o1" | "o2") {
    const user = org === "o1" ? "u1" : "u2";
    await sql`insert into projects(id, org_id, user_id, name, pipeline) values (${id}, ${org}, ${user}, ${id}, ${sql.json(TREE as unknown as postgres.JSONValue)})`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (${`run-${id}`}, ${org}, ${user}, ${id}, 'bulk-upload', 'completed', 'completed', '{}')`;
  }
  const insertJob = async (id: string, project: string, org: "o1" | "o2", createdSecondsAgo: number) => {
    await sql`insert into summary_tree_jobs (id, org_id, project_id, user_id, max_cost_cents, documents_total, created_at)
      values (${id}, ${org}, ${project}, ${org === "o1" ? "u1" : "u2"}, 1000, 0, now() - ${`${createdSecondsAgo} seconds`}::interval)`;
  };
  const statuses = async () => Object.fromEntries((await sql<Array<{ id: string; status: string }>>`select id, status from summary_tree_jobs`).map((row) => [row.id, row.status]));

  it("claims a fresh job of another organization next, whatever one organization has parked", async () => {
    const f = fakes();
    // Organization o1 may not spend: every job of its twenty projects parks, and is due again at once.
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    await sql`update organizations set budget_paused = true where id = 'o1'`;
    try {
      for (let n = 1; n <= 20; n++) {
        const project = `p${String(n).padStart(2, "0")}`;
        await addProject(project, "o1");
        await insertJob(`parked-${project}`, project, "o1", 1_000 - n);
      }
      for (let tick = 0; tick < 20; tick++) expect(await f.run({ parkMs: 60_000 })).toBe(1);
      const parked = await sql<Array<{ status: string; blocked_reason: string; park_count: number; due: boolean }>>`
        select status, blocked_reason, park_count, resume_after <= now() as due from summary_tree_jobs`;
      expect(parked).toHaveLength(20);
      for (const row of parked) expect(row).toEqual({ status: "blocked", blocked_reason: "credits", park_count: 1, due: false });
      // No artifact was read to find that out, and no call was made.
      expect(f.storage.opened).toEqual([]);
      expect(f.requests).toEqual([]);

      // A minute later all twenty are due again, each older than the job another organization starts now.
      await sql`update summary_tree_jobs set resume_after = now() - interval '1 second'`;
      await seedDocument(f.storage, "x", "x-big", BIG_LEAVES);
      const fresh = await queueJob("x");
      expect(await f.run({ parkMs: 60_000 })).toBe(1);
      expect(await jobOf(fresh)).toMatchObject({ status: "completed", documents_ready: 1, model_calls: BIG_NODES });
      // None of the parked jobs was looked at in that tick.
      expect((await sql`select count(*)::int as n from summary_tree_jobs where park_count > 1`)[0]).toMatchObject({ n: 0 });

      // The parked jobs are then looked at one a tick, each waiting twice as long as before.
      for (let tick = 0; tick < 20; tick++) await f.run({ parkMs: 60_000 });
      const again = await sql<Array<{ park_count: number; wait: number }>>`
        select park_count, extract(epoch from (resume_after - updated_at))::float8 as wait from summary_tree_jobs where status = 'blocked'`;
      expect(again).toHaveLength(20);
      for (const row of again) {
        expect(row.park_count).toBe(2);
        expect(row.wait).toBeCloseTo(120, 0);
      }
      expect(f.storage.opened).toEqual(["u2/run-x/embeddings/x-big.json"]);
    } finally {
      setSpendCheckConfig({ enabled: false, pages: 0, credits: 0 });
      await sql`update organizations set budget_paused = false where id = 'o1'`;
    }
  });

  it("bounds a parked job's wait, and ends a job that has been parked too long with a note", async () => {
    const f = fakes();
    f.env.DOCSLURP_SUMMARY_TREE_BUILD = "off";
    const jobId = await queueJob("w");
    // The twelfth park in a row would wait for days at a plain doubling; the bound holds it.
    await sql`update summary_tree_jobs set status = 'blocked', blocked_reason = 'build-off', park_count = 11, parked_since = now() - interval '2 hours', resume_after = now() where id = ${jobId}`;
    expect(await f.run({ parkMs: 60_000, parkMaxMs: 30 * 60_000 })).toBe(0);
    const [bounded] = await sql<Array<{ park_count: number; wait: number; parked_hours: number }>>`
      select park_count, extract(epoch from (resume_after - now()))::float8 as wait, extract(epoch from (now() - parked_since))::float8 / 3600 as parked_hours from summary_tree_jobs where id = ${jobId}`;
    expect(bounded!.park_count).toBe(12);
    expect(bounded!.wait).toBeGreaterThan(29 * 60);
    expect(bounded!.wait).toBeLessThanOrEqual(30 * 60);
    // The row of parks keeps its start: a later park does not restart the clock.
    expect(bounded!.parked_hours).toBeGreaterThanOrEqual(2);

    // Past the longest a job may stay parked: it ends, says why in closed copy, and keeps its last parking reason.
    await sql`update summary_tree_jobs set resume_after = now(), parked_since = now() - interval '25 hours' where id = ${jobId}`;
    expect(await f.run({ maxParkedMs: 24 * 60 * 60_000 })).toBe(0);
    expect(await jobOf(jobId)).toMatchObject({ status: "failed", error: SUMMARY_TREE_JOB_NOTES.parkedTooLong, blocked_reason: "build-off", lease_owner: null });
    expect((await jobOf(jobId)).finished_at).not.toBeNull();
    // The project can start another job: the ended one no longer counts as active.
    f.env.DOCSLURP_SUMMARY_TREE_BUILD = "on";
    await queueJob("w");
    expect(f.requests).toEqual([]);
  });

  it("resets the row of parks when the job makes progress", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-small", 5);
    const jobId = await queueJob("w");
    await sql`update summary_tree_jobs set status = 'blocked', blocked_reason = 'balance', park_count = 6, parked_since = now() - interval '3 hours', resume_after = now() where id = ${jobId}`;
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_skipped: 1, park_count: 0, parked_since: null });
  });

  it("serves organizations in turn: the one served longest ago first, never-attempted jobs before any other", async () => {
    const f = fakes();
    await addProject("w3", "o1");
    for (const [project, document] of [["w", "a-small"], ["w2", "b-small"], ["w3", "c-small"], ["x", "x-small"]] as const) await seedDocument(f.storage, project as Project, document, 5);
    // Three jobs of o1, all older than the one job of o2.
    await insertJob("o1-first", "w", "o1", 400);
    await insertJob("o1-second", "w2", "o1", 300);
    await insertJob("o1-third", "w3", "o1", 200);
    await insertJob("o2-only", "x", "o2", 100);
    const order: string[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const before = await statuses();
      await f.run();
      const after = await statuses();
      order.push(...Object.keys(after).filter((id) => before[id] !== after[id]));
    }
    expect(order).toEqual(["o1-first", "o2-only", "o1-second", "o1-third"]);
    expect(Object.values(await statuses())).toEqual(["completed", "completed", "completed", "completed"]);
  });

  it("runs at most one job of an organization at a time", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w2", "b-small", 5);
    await seedDocument(f.storage, "x", "x-small", 5);
    // Another worker holds a live job of o1.
    await insertJob("o1-running", "w", "o1", 300);
    await sql`update summary_tree_jobs set status = 'running', lease_owner = 'worker-b', lease_expires_at = now() + interval '5 minutes', last_attempt_at = now() - interval '1 hour' where id = 'o1-running'`;
    await insertJob("o1-waiting", "w2", "o1", 200);
    expect(await f.run()).toBe(0);
    expect(await jobOf("o1-waiting")).toMatchObject({ status: "queued", last_attempt_at: null });
    // Another organization's job is not held back by it.
    await insertJob("o2-job", "x", "o2", 100);
    expect(await f.run()).toBe(1);
    expect(await jobOf("o2-job")).toMatchObject({ status: "completed" });
    expect(await jobOf("o1-waiting")).toMatchObject({ status: "queued" });
    // Once the running job's lease is over, the organization's next job may run (the abandoned one is claimable too).
    await sql`update summary_tree_jobs set status = 'completed', lease_owner = null, lease_expires_at = null where id = 'o1-running'`;
    expect(await f.run()).toBe(1);
    expect(await jobOf("o1-waiting")).toMatchObject({ status: "completed" });
  });

  it("gives the runner up after its slice when another job waits, so two organizations' long jobs interleave", async () => {
    const f = fakes();
    for (const id of ["a", "b", "c"]) {
      await seedDocument(f.storage, "w", `w-${id}`, BIG_LEAVES);
      await seedDocument(f.storage, "x", `x-${id}`, BIG_LEAVES);
    }
    await insertJob("job-w", "w", "o1", 200);
    await insertJob("job-x", "x", "o2", 100);
    // One document a batch, one batch a slice.
    const slice = { batchSize: 1, sliceBatches: 1 };
    const built: string[] = [];
    for (let tick = 0; tick < 6; tick++) {
      const from = f.requests.length;
      expect(await f.run(slice)).toBe(1);
      built.push(...new Set(f.requests.slice(from).map((request) => request.nodeId.split(":")[0]!)));
    }
    expect(built).toEqual(["w-a", "x-a", "w-b", "x-b", "w-c", "x-c"]);
    // A yielded job is queued, holds no lease and kept its cursor; it is not parked.
    expect(await jobOf("job-w")).toMatchObject({ documents_ready: 3, park_count: 0, lease_owner: null });
    for (let tick = 0; tick < 2; tick++) await f.run(slice);
    expect(await statuses()).toEqual({ "job-w": "completed", "job-x": "completed" });
    expect(f.requests).toHaveLength(6 * BIG_NODES);
    expect(new Set(f.requests.map((request) => request.nodeId)).size).toBe(6 * BIG_NODES);
  });

  it("yields in the middle of a long document at its next window, and resumes it without repeating a call", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "w-long", BIG_LEAVES);
    await seedDocument(f.storage, "x", "x-long", BIG_LEAVES);
    await insertJob("job-w", "w", "o1", 200);
    await insertJob("job-x", "x", "o2", 100);
    // The slice is over as soon as the job has made a call: every window gives way to the other job.
    const slice = { sliceMs: 0 };
    const turns: string[] = [];
    for (let tick = 0; tick < 40 && Object.values(await statuses()).some((status) => status !== "completed"); tick++) {
      const from = f.requests.length;
      await f.run(slice);
      const documents = [...new Set(f.requests.slice(from).map((request) => request.nodeId.split(":")[0]!))];
      expect(documents.length).toBeLessThanOrEqual(1);
      turns.push(...documents);
    }
    expect(await statuses()).toEqual({ "job-w": "completed", "job-x": "completed" });
    // Neither job waited for the other to finish: their calls alternate.
    expect(turns.slice(0, 6)).toEqual(["w-long", "x-long", "w-long", "x-long", "w-long", "x-long"]);
    expect(f.requests).toHaveLength(2 * BIG_NODES);
    expect(new Set(f.requests.map((request) => request.nodeId)).size).toBe(2 * BIG_NODES);
    expect(await treeStatuses()).toEqual({ "w-long": "ready", "x-long": "ready" });
  });

  it("keeps the runner while no other job waits", async () => {
    const f = fakes();
    for (const id of ["a", "b", "c"]) await seedDocument(f.storage, "w", `w-${id}`, BIG_LEAVES);
    const jobId = await queueJob("w");
    expect(await f.run({ batchSize: 1, sliceBatches: 1, sliceMs: 0 })).toBe(1);
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 3 });
  });
});

describe("lease", () => {
  it("is resumed by another worker after its lease expires, repeating no call whose answer was kept", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    // The second worker is another process over the same bucket and tables.
    const second = fakes();
    let takeover: Promise<number> | null = null;
    const committedByFirst: string[] = [];
    f.beforeAnswer = async (_request, call) => {
      if (call <= 3) return;
      if (call === 4) {
        committedByFirst.push(...f.requests.slice(0, 3).map((earlier) => earlier.nodeId));
        // The first worker stalls inside its fourth call; its lease runs out and another worker claims the job.
        await sql`update summary_tree_jobs set lease_expires_at = now() - interval '1 second' where id = ${jobId}`;
        takeover = second.run({ workerId: "worker-b", storage: f.storage });
        await takeover;
      }
    };
    await f.run({ workerId: "worker-a" });
    expect(await takeover).toBe(1);

    const job = await jobOf(jobId);
    expect(job).toMatchObject({ status: "completed", documents_ready: 2, documents_partial: 0, lease_owner: null });
    expect(await treeStatuses()).toEqual({ "a-big": "ready", "b-big": "ready" });
    // The three calls the first worker had committed were read back from the artifact, never called again.
    const secondCalls = second.requests.map((request) => request.nodeId);
    expect(secondCalls.filter((nodeId) => committedByFirst.includes(nodeId))).toEqual([]);
    expect(new Set(secondCalls).size).toBe(secondCalls.length);
    expect(secondCalls).toHaveLength(2 * BIG_NODES - 3);
    // The first worker noticed it no longer held the lease: its stalled call was its last, and it changed no state.
    expect(f.requests).toHaveLength(4);
    // Every call either worker paid for is in the ledger and in the job's totals.
    expect(await modelUsage()).toHaveLength(f.requests.length + second.requests.length);
    expect(job.model_calls).toBe(f.requests.length + second.requests.length);
    const rows = (await summaryRowsOf("w"))!;
    expect(new Set(rows.map((row) => row.id)).size).toBe(2 * BIG_NODES);
  });

  it("keeps its lease while it runs longer than the lease lasts", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    const other = fakes();
    const claimedMeanwhile: number[] = [];
    f.beforeAnswer = async (_request, call) => {
      // Fourteen calls of 60 ms against a 150 ms lease: the job outlives its lease several times over.
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Another worker polling all the while never gets the job.
      if (call % 4 === 0) claimedMeanwhile.push(await other.run({ workerId: "worker-b", storage: f.storage, leaseMs: 150 }));
    };
    await f.run({ leaseMs: 150 });
    expect(claimedMeanwhile).toEqual([0, 0, 0]);
    expect(other.requests).toEqual([]);
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 2, model_calls: 2 * BIG_NODES });
    expect(f.requests).toHaveLength(2 * BIG_NODES);
  });

  it("does not claim a job another worker holds", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    await sql`update summary_tree_jobs set status = 'running', lease_owner = 'worker-z', lease_expires_at = now() + interval '5 minutes' where id = ${jobId}`;
    expect(await f.run()).toBe(0);
    expect(f.requests).toEqual([]);
    expect(await jobOf(jobId)).toMatchObject({ status: "running", lease_owner: "worker-z" });
  });
});

describe("documents that change under the job", () => {
  it("skips a document deleted mid-build and leaves none of its rows or text behind", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-gone", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    f.beforeAnswer = async (request, call) => {
      if (call === 3 && request.nodeId.startsWith("a-gone:")) await sql`delete from documents where id = 'a-gone'`;
    };
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 1, documents_skipped: 1, documents_partial: 0 });
    expect(await treeStatuses()).toEqual({ "b-big": "ready" });
    expect(await sql`select 1 from document_summary_tree_nodes where document_id = 'a-gone'`).toHaveLength(0);
    expect(await sql`select 1 from document_run_stage_states where document_id = 'a-gone'`).toHaveLength(0);
    // The two summaries committed before the delete are gone from the summaries table and from object storage.
    expect((await summaryRowsOf("w"))!.filter((row) => row.documentId === "a-gone")).toEqual([]);
    expect([...f.storage.objects.keys()].filter((key) => key.includes("/summary-tree/a-gone/"))).toEqual([]);
    // No further call was made for it, and what was paid is still recorded.
    expect(f.requests.filter((request) => request.nodeId.startsWith("a-gone:"))).toHaveLength(3);
    expect(await modelUsage()).toHaveLength(f.requests.length);
  });

  it("builds no tree for a corrected document, before or during its build, and never marks one ready", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-corrected", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-mid", BIG_LEAVES);
    await seedDocument(f.storage, "w", "c-big", BIG_LEAVES);
    // What the API's correction reindex leaves (summary-tree-withdrawal.ts). The worker's role cannot read the corrections table.
    const correct = (id: string) => sql`
      insert into document_summary_trees (document_id, org_id, project_id, run_id, status, skip_reason)
      values (${id}, 'o1', 'w', 'run-w', 'skipped', 'corrected')
      on conflict (document_id) do update set status = 'skipped', skip_reason = 'corrected', build_owner = null, built_at = null`;
    await correct("a-corrected");
    f.beforeAnswer = async (request, call) => {
      if (call === 2 && request.nodeId.startsWith("b-mid:")) await correct("b-mid");
    };
    const jobId = await queueJob("w");
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 1 });
    expect(await treeStatuses()).toEqual({ "a-corrected": "skipped", "b-mid": "skipped", "c-big": "ready" });
    expect(await treeOf("b-mid")).toMatchObject({ skip_reason: "corrected", built_at: null });
    expect(f.storage.opened).not.toContain("u1/run-w/embeddings/a-corrected.json");
    expect(f.requests.some((request) => request.nodeId.startsWith("a-corrected:"))).toBe(false);
    // No call for the corrected document after the correction landed.
    expect(f.requests.filter((request) => request.nodeId.startsWith("b-mid:")).length).toBeLessThanOrEqual(2);
    // A later job does not pick either of them up.
    const again = await queueJob("w");
    const calls = f.requests.length;
    await f.run();
    expect(await jobOf(again)).toMatchObject({ status: "completed", model_calls: 0 });
    expect(f.requests).toHaveLength(calls);
  });

  it("leaves a document it cannot read for a later job and builds the rest; a run of such failures fails the job", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-broken", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    f.storage.objects.set("u1/run-w/embeddings/a-broken.json", Buffer.from("{ this is not an embed artifact"));
    const jobId = await queueJob("w");
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 1, documents_partial: 1, model_calls: BIG_NODES });
    expect((await treeStatuses())["b-big"]).toBe("ready");
    expect(f.requests.every((request) => request.nodeId.startsWith("b-big:"))).toBe(true);

    // Every document failing the same way is not the documents' fault: the job fails instead of marking a project partial.
    await sql`delete from document_summary_trees`;
    await sql`delete from documents where id = 'b-big'`;
    for (const id of ["c", "d", "e", "f", "g"]) {
      await seedDocument(f.storage, "w", `${id}-broken`, BIG_LEAVES);
      f.storage.objects.set(`u1/run-w/embeddings/${id}-broken.json`, Buffer.from("{ this is not an embed artifact"));
    }
    const failing = await queueJob("w");
    await f.run();
    const failed = await jobOf(failing);
    expect(failed).toMatchObject({ status: "failed", documents_ready: 0, lease_owner: null });
    expect(failed.error).toBeTruthy();
  });

  it("retries a failed group once more, then leaves the document partial with no fallback text", async () => {
    const f = fakes();
    await seedDocument(f.storage, "w", "a-big", BIG_LEAVES);
    await seedDocument(f.storage, "w", "b-big", BIG_LEAVES);
    const jobId = await queueJob("w");
    let failures = 0;
    f.beforeAnswer = (request) => {
      // One section of a-big fails three times (the build's two attempts, then the job's first retry attempt).
      if (request.nodeId === "a-big:L1:10-19" && failures < 3) {
        failures += 1;
        throw new Error("model unavailable");
      }
      // One section of b-big never succeeds.
      if (request.nodeId === "b-big:L1:10-19") throw new Error("model unavailable");
    };
    await f.run();
    expect(await jobOf(jobId)).toMatchObject({ status: "completed", documents_ready: 1, documents_partial: 1 });
    expect(await treeStatuses()).toEqual({ "a-big": "ready", "b-big": "partial" });
    // Nothing stands in for the missing summary: the failed node has no row and no text.
    const rows = (await summaryRowsOf("w"))!;
    expect(rows.some((row) => row.id === "b-big:L1:10-19")).toBe(false);
    expect([...f.storage.objects.entries()].filter(([key]) => key.includes("/summary-tree/b-big/")).some(([, value]) => value.toString("utf8").includes("L1:10-19"))).toBe(false);
    expect(await treeOf("b-big")).toMatchObject({ status: "partial", built_at: null });
    // The sections that succeeded were called once each; only the failing one was retried.
    const counts = new Map<string, number>();
    for (const request of f.requests) counts.set(request.nodeId, (counts.get(request.nodeId) ?? 0) + 1);
    expect(counts.get("b-big:L1:10-19")).toBe(4);
    expect([...counts].filter(([nodeId, count]) => count > 1 && !nodeId.endsWith(":L1:10-19"))).toEqual([]);
  });
});

describe("provider balance probe", () => {
  it("is absent unless configured, and fails closed when its module cannot be loaded or its answer is not a reading", async () => {
    setProviderBalanceProbe(undefined);
    expect(await providerBalanceProbe({})).toBeNull();
    setProviderBalanceProbe(undefined);
    const loaded = await providerBalanceProbe({ DOCSLURP_PROVIDER_BALANCE_PROBE: "/opt/probe.mjs" }, async (specifier) => {
      expect(specifier).toBe("file:///opt/probe.mjs");
      return { createProviderBalanceProbe: (host: { apiVersion: number }) => ({ check: async () => ({ sufficient: host.apiVersion === 1, retryAfterSeconds: 30 }) }) };
    });
    expect(await readProviderBalance(loaded!, { provider: "p", model: "m", purpose: "t" })).toEqual({ sufficient: true, retryAfterSeconds: 30 });
    setProviderBalanceProbe(undefined);
    const missing = await providerBalanceProbe({ DOCSLURP_PROVIDER_BALANCE_PROBE: "/opt/missing.mjs" }, async () => { throw new Error("Cannot find module"); });
    expect(await readProviderBalance(missing!, { provider: "p", model: "m", purpose: "t" })).toEqual({ sufficient: false });
    setProviderBalanceProbe(undefined);
    const relative = await providerBalanceProbe({ DOCSLURP_PROVIDER_BALANCE_PROBE: "probe.mjs" }, async () => ({}));
    expect(await readProviderBalance(relative!, { provider: "p", model: "m", purpose: "t" })).toEqual({ sufficient: false });
    expect(await readProviderBalance({ check: async () => ({}) as never }, { provider: "p", model: "m", purpose: "t" })).toEqual({ sufficient: false });
    expect(await readProviderBalance({ check: () => new Promise(() => undefined) }, { provider: "p", model: "m", purpose: "t" }, 20)).toEqual({ sufficient: false });
    setProviderBalanceProbe(undefined);
  });
});
