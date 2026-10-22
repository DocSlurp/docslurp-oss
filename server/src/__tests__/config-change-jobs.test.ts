import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { compilePipelinePlan, defaultPipelineFeatures, estimatePipelineWork, indexConfigHash, indexConfigOf, withoutStageSelection, type PipelineFeatures } from "@docslurp/shared";

// PGlite is a worker dev dependency; its migrated-Postgres harness is shared by path.
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { withTestSession } from "./helpers/session-app.js";

/**
 * Config-change jobs against a migrated database: PATCH bodies that succeed on main still succeed, required
 * re-indexes auto-queue, blocked jobs resume, estimates equal the job's, and the job resource reads the runs.
 */
const cancelSignal = vi.fn(async () => undefined);
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let change: typeof import("../services/config-change.js");
let blocked: typeof import("../services/blocked-runs.js");
let jobs: typeof import("../services/jobs.js");
let jobsRoutes: typeof import("../routes/jobs.js").jobsRoutes;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(), signalPipelineCancel: cancelSignal }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  change = await import("../services/config-change.js");
  blocked = await import("../services/blocked-runs.js");
  jobs = await import("../services/jobs.js");
  jobsRoutes = (await import("../routes/jobs.js")).jobsRoutes;
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const pipeline = (patch: Partial<PipelineFeatures> = {}): PipelineFeatures => ({ ...defaultPipelineFeatures, ...patch });

async function seed(args: { credits: number; autoConfirm?: boolean; documents?: number; vectorized?: boolean }) {
  await sql`delete from workspace_runs`;
  await sql`delete from documents`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', ${args.credits})`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline, auto_confirm_reindex)
    values ('w', 'o1', 'u1', 'W', ${sql.json(JSON.parse(JSON.stringify(pipeline())))}, ${args.autoConfirm ?? false})`;
  await sql`insert into workspace_search_settings(workspace_id, user_id) values ('w', 'u1') on conflict do nothing`.catch(() => undefined);
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, artifacts)
    values ('src', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(pipeline())))}, ${args.documents ?? 2}, ${sql.json(Object.fromEntries(Array.from({ length: args.documents ?? 2 }, (_, i) => [`d${i}:markdown`, `s3://b/d${i}.md`])))})`;
  for (let i = 0; i < (args.documents ?? 2); i += 1) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values (${`d${i}`}, 'o1', 'u1', 'w', 'src', ${`f${i}.pdf`}, 'application/pdf', ${`k${i}`}, 'completed', 5, ${`c${i}`})`;
    if (args.vectorized) {
      await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
        values (${`v${i}`}, ${`d${i}`}, 'lancedb', 'b', 'p', 'm', 384)`;
    }
  }
}

const embeddingChange = () => ({ pipeline: pipeline({ embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/gte-small" as never } }) });

async function patch(input: Record<string, unknown>) {
  const plan = await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: input as never });
  expect(plan).not.toBeNull();
  return { plan: plan!, applied: await change.applyWorkspaceChange({ plan: plan!, userId: "u1" }) };
}

describe("PATCH /v1/workspaces/:id is non-breaking", () => {
  beforeEach(() => seed({ credits: 10_000 }));

  const validBodies: Array<[string, Record<string, unknown>]> = [
    ["empty body", {}],
    ["name", { name: "Renamed" }],
    ["system prompt", { systemPrompt: "Be brief" }],
    ["budget", { monthlyBudgetCents: 5000 }],
    ["retention days", { artifactRetentionDays: 30, runRetentionDays: 60 }],
    ["clear retention", { artifactRetentionDays: null, runRetentionDays: 0 }],
    ["pipeline summarize", { pipeline: pipeline({ summarize: true }) }],
    ["workspace summaries", { summaries: true }],
    ["pipeline same", { pipeline: pipeline() }],
    ["pipeline webhooks", { pipeline: pipeline({ webhooks: { enabled: false } as never }) }],
    ["apply new-uploads", { apply: "new-uploads", pipeline: pipeline({ summarize: true }) }],
    ["autoConfirmReindex", { autoConfirmReindex: true }],
    ["embedding model", embeddingChange()],
  ];

  it.each(validBodies)("accepts %s", async (_name, body) => {
    const { applied } = await patch(body);
    expect(applied).not.toBeNull();
    expect(applied!.workspace.id).toBe("w");
  });
});

describe("config-change jobs", () => {
  it("plans document-summary backfill through the workspace summaries option", async () => {
    await seed({ credits: 10_000 });
    const planned = await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: { summaries: true } });
    expect(planned?.impact.kind).toBe("reindex-recommended");
    expect(planned?.impact.stages).toContain("document-summary");
    const { applied } = await patch({ summaries: true, apply: "new-uploads" });
    expect(applied?.workspace.summaries).toBe(true);
    expect(applied?.job).toBeNull();
    await seed({ credits: 10_000 });
    expect((await patch({ summaries: true, apply: "reindex" })).applied?.job).not.toBeNull();
  });

  it("auto-queues a re-index job for an embedding change and records the previous index", async () => {
    await seed({ credits: 10_000 });
    const before = indexConfigOf(pipeline());
    const { plan, applied } = await patch(embeddingChange());
    expect(plan.impact.kind).toBe("reindex-required");
    expect(applied!.job).toMatchObject({ kind: "reindex", status: "queued", statusUrl: expect.stringMatching(/^\/v1\/jobs\//) });
    expect(applied!.queuedRunIds).toEqual(applied!.job!.runIds);
    const [ws] = await sql<{ index_configs: Record<string, unknown> | null }[]>`select index_configs from workspaces where id = 'w'`;
    expect(ws!.index_configs).toEqual({
      [indexConfigHash(before)]: before,
      [indexConfigHash(indexConfigOf(embeddingChange().pipeline))]: indexConfigOf(embeddingChange().pipeline),
    });
    const [run] = await sql<{ job_id: string }[]>`select job_id from workspace_runs where id = ${applied!.job!.id}`;
    expect(run!.job_id).toBe(applied!.job!.id);
    const [child] = await sql<{ reindex_of: string }[]>`select reindex_of from documents where run_id = ${applied!.job!.id} order by id limit 1`;
    expect(child!.reindex_of).toMatch(/^d\d$/);
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from documents where run_id = ${applied!.job!.id}`;
    expect(count!.n).toBe(2);
  });

  it("creates no job for a search-only or new-uploads change", async () => {
    await seed({ credits: 10_000 });
    for (const body of [{ monthlyBudgetCents: 4000 }, { name: "x" }, { pipeline: pipeline({ webhooks: { enabled: false } as never }) }]) {
      const { applied } = await patch(body);
      expect(applied!.job).toBeNull();
    }
    const [runs] = await sql<{ n: number }[]>`select count(*)::int as n from workspace_runs where kind = 'reindex'`;
    expect(runs!.n).toBe(0);
  });

  it("re-indexes a recommended change only with apply or autoConfirmReindex", async () => {
    await seed({ credits: 10_000, autoConfirm: false });
    const body = { pipeline: pipeline({ summarize: true }) };
    expect((await patch(body)).applied!.job).toBeNull();
    await seed({ credits: 10_000, autoConfirm: false });
    expect((await patch({ ...body, apply: "reindex" })).applied!.job).not.toBeNull();

    await seed({ credits: 10_000, autoConfirm: true });
    expect((await patch(body)).applied!.job).not.toBeNull();
    await seed({ credits: 10_000, autoConfirm: true });
    expect((await patch({ ...body, apply: "new-uploads" })).applied!.job).toBeNull();
  });

  it("saves the config and parks the job as blocked without credits, then resumes after a grant", async () => {
    await seed({ credits: 0 });
    const { applied } = await patch(embeddingChange());
    expect(applied!.job).toMatchObject({ status: "blocked", reason: "credits" });
    expect(applied!.queuedRunIds).toEqual([]);
    const [ws] = await sql<{ pipeline: PipelineFeatures }[]>`select pipeline from workspaces where id = 'w'`;
    expect(ws!.pipeline.embedding.modelUri).toBe("llm://transformers.js/Xenova/gte-small");

    expect((await blocked.resumeBlockedRuns({ sql: sql as never })).resumed).toBe(0);
    await sql`update organizations set credit_balance_cents = 10000 where id = 'o1'`;
    expect((await blocked.resumeBlockedRuns({ sql: sql as never })).resumed).toBe(applied!.job!.runIds.length);
    const [run] = await sql<{ status: string; blocked_reason: string | null }[]>`select status, blocked_reason from workspace_runs where id = ${applied!.job!.id}`;
    expect(run).toEqual({ status: "queued", blocked_reason: null });
  });

  it("A to B then B to C mid-flight: cancels the B job, re-queues every document for C, ends with only C", async () => {
    await seed({ credits: 10_000, documents: 3, vectorized: true });
    const A = pipeline();
    const B = embeddingChange().pipeline;
    const C = pipeline({ embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/all-MiniLM-L6-v2" as never } });
    const hashes = { A: indexConfigHash(indexConfigOf(A)), B: indexConfigHash(indexConfigOf(B)), C: indexConfigHash(indexConfigOf(C)) };

    const first = await patch({ pipeline: B });
    expect(first.applied!.job).toMatchObject({ status: "queued" });
    // Legacy documents (no hash yet) are stamped with the config that was current.
    expect((await sql<{ h: string | null }[]>`select index_config_hash h from documents where run_id = 'src'`).map((r) => r.h)).toEqual([hashes.A, hashes.A, hashes.A]);

    // d0 is re-indexed on B mid-flight; the B run is still processing.
    const [kid] = await sql<{ id: string }[]>`select id from documents where previous_version_id = 'd0'`;
    await sql`update workspace_runs set status = 'processing' where id = ${first.applied!.job!.id}`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values ('vk', ${kid!.id}, 'lancedb', 'b', 'p', 'm2', 384)`;
    await sql`update documents set status = 'completed', index_config_hash = ${hashes.B} where id = ${kid!.id}`;

    const second = await patch({ pipeline: C });
    expect(second.applied!.cancelledRunIds).toEqual([first.applied!.job!.id]);
    expect(cancelSignal).toHaveBeenCalledWith(first.applied!.job!.id);
    const [oldRun] = await sql<{ status: string; control_state: string }[]>`select status, control_state from workspace_runs where id = ${first.applied!.job!.id}`;
    expect(oldRun).toEqual({ status: "processing", control_state: "cancel_requested" });
    // A requested cancel is not terminal: the job reads processing (and streams no `done`) until the run ends.
    const lingering = await jobs.getJobStatus(first.applied!.job!.id, "u1", { apiKey: null });
    expect(lingering).toMatchObject({ status: "processing" });
    expect(jobs.isJobTerminal(lingering!)).toBe(false);
    // Unfinished documents of the cancelled job are cancelled, not left to compete.
    expect((await sql<{ n: number }[]>`select count(*)::int n from documents where run_id = ${first.applied!.job!.id} and status = 'cancelled'`)[0]!.n).toBe(2);

    // Every live document (the B-indexed d0 replacement and the still-A d1, d2) is queued for C.
    const live = await sql<{ id: string; h: string | null }[]>`select id, index_config_hash h from documents where superseded_at is null and status = 'completed' order by id`;
    expect(live.map((r) => r.h).sort()).toEqual([hashes.A, hashes.A, hashes.B].sort());
    const queued = await sql<{ previous_version_id: string }[]>`select previous_version_id from documents where run_id in (select id from workspace_runs where job_id = ${second.applied!.job!.id})`;
    expect(queued.map((r) => r.previous_version_id).sort()).toEqual(["d1", "d2", kid!.id].sort());
    const [ws] = await sql<{ index_configs: Record<string, unknown> }[]>`select index_configs from workspaces where id = 'w'`;
    expect(Object.keys(ws!.index_configs).sort()).toEqual(Object.values(hashes).sort());

    // The C job finishes: each replacement completes on C and supersedes its source.
    for (const row of queued) {
      const [replacement] = await sql<{ id: string }[]>`select id from documents where previous_version_id = ${row.previous_version_id} and run_id in (select id from workspace_runs where job_id = ${second.applied!.job!.id})`;
      await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values (${`vc-${replacement!.id}`}, ${replacement!.id}, 'lancedb', 'b', 'p', 'm3', 1024)`;
      await sql`update documents set status = 'completed', index_config_hash = ${hashes.C} where id = ${replacement!.id}`;
    }
    const done = await sql<{ h: string }[]>`select index_config_hash h from documents where superseded_at is null and status = 'completed'`;
    expect(done.map((r) => r.h)).toEqual([hashes.C, hashes.C, hashes.C]);
    const serving = await import("../search/index-serving.js");
    await serving.pruneDrainedIndexConfigs(sql as never);
    const [pruned] = await sql<{ index_configs: Record<string, unknown> }[]>`select index_configs from workspaces where id = 'w'`;
    expect(Object.keys(pruned!.index_configs)).toEqual([hashes.C]);
  });

  it("a cancelled blocked job never resumes; a paused blocked run waits for its resume", async () => {
    await seed({ credits: 0, documents: 2, vectorized: true });
    const first = await patch(embeddingChange());
    expect(first.applied!.job).toMatchObject({ status: "blocked" });
    const second = await patch({ pipeline: pipeline({ embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/all-MiniLM-L6-v2" as never } }) });
    expect(second.applied!.job).toMatchObject({ status: "blocked" });
    const [cancelled] = await sql<{ status: string; control_state: string }[]>`select status, control_state from workspace_runs where id = ${first.applied!.job!.id}`;
    expect(cancelled).toEqual({ status: "failed", control_state: "cancelled" });

    await sql`update organizations set credit_balance_cents = 10000 where id = 'o1'`;
    await sql`update workspace_runs set control_state = 'paused' where id = ${second.applied!.job!.id}`;
    expect((await blocked.resumeBlockedRuns({ sql: sql as never })).resumed).toBe(0);
    await sql`update workspace_runs set control_state = null where id = ${second.applied!.job!.id}`;
    await sql`update workspaces set archived_at = now() where id = 'w'`;
    expect((await blocked.resumeBlockedRuns({ sql: sql as never })).resumed).toBe(0);
    await sql`update workspaces set archived_at = null where id = 'w'`;
    expect((await blocked.resumeBlockedRuns({ sql: sql as never })).resumed).toBe(1);
    const [stale] = await sql<{ status: string }[]>`select status from workspace_runs where id = ${first.applied!.job!.id}`;
    expect(stale!.status).toBe("failed");
  });

  it("treats a blocked run like a queued one when cancelling or pausing", async () => {
    const { planRunControlUpdate } = await import("../services/run-lifecycle.js");
    const blockedRun = { status: "blocked" as const, priority: 0, controlState: null };
    expect(planRunControlUpdate(blockedRun, { action: "cancel" })).toMatchObject({ immediate: true, status: "failed", controlState: "cancelled" });
    expect(planRunControlUpdate(blockedRun, { action: "pause" })).toMatchObject({ immediate: true, controlState: "paused" });
    // Resuming a paused blocked run leaves it blocked: spend admission starts it.
    expect(planRunControlUpdate({ ...blockedRun, controlState: "paused" }, { action: "resume" })).toMatchObject({ status: "blocked", controlState: null });
  });

  it("finds a job's runs by job_id", async () => {
    await seed({ credits: 10_000 });
    const { applied } = await patch(embeddingChange());
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, job_id)
      values ('second-run', 'o1', 'u1', 'w', 'reindex', 'queued', 'queued', '{}', 1, ${applied!.job!.id})`;
    const status = await jobs.getJobStatus(applied!.job!.id, "u1");
    expect(status!.runIds.sort()).toEqual([applied!.job!.id, "second-run"].sort());
    // The lookup uses the job_id index (a seq scan on a tiny table is disabled for the plan check).
    await sql`set enable_seqscan = off`;
    const plan = await sql<Record<string, string>[]>`explain select r.id from workspace_runs r where r.id = ${applied!.job!.id} or r.job_id = ${applied!.job!.id}`;
    await sql`set enable_seqscan = on`;
    expect(plan.map((row) => Object.values(row)[0]).join("\n")).toContain("workspace_runs_job_id_idx");
  });

  const stagesOf = async (jobId: string) =>
    (await sql<{ s: string[] | null }[]>`select pipeline -> 'stageSubset' as s from workspace_runs where job_id = ${jobId} order by created_at`)
      .flatMap((row) => row.s ?? []);
  const MINILM = "llm://transformers.js/Xenova/all-MiniLM-L6-v2" as never;
  const embeddingTo = (pl: PipelineFeatures) => ({ pipeline: { ...pl, embedding: { ...pl.embedding, target: "local" as const, modelUri: MINILM } } });

  it("keeps a cancelled PII re-index's stages when an embedding change supersedes it", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const pii = { ...pipeline(), piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true, action: "block_indexing" as const } };
    const first = await patch({ pipeline: pii });
    expect(first.plan.impact.kind).toBe("reindex-required");
    const firstStages = await stagesOf(first.applied!.job!.id);
    expect(firstStages).toContain("pii-detect");

    const second = await patch(embeddingTo(pii));
    expect(second.applied!.cancelledRunIds).toEqual(first.applied!.job!.runIds);
    const secondStages = await stagesOf(second.applied!.job!.id);
    expect(secondStages).toEqual(expect.arrayContaining(["pii-detect", ...second.plan.impact.stages]));
    expect(second.plan.impact.stages).toContain("embed");
  });

  it("prices the carried-over stages: estimate covers PII plus embed and equals job.estimate", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const pii = { ...pipeline(), piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true, action: "block_indexing" as const } };
    const first = await patch({ pipeline: pii });
    expect(first.applied!.job).not.toBeNull();

    const body = embeddingTo(pii);
    const twin = await change.estimateWorkspaceChange({ workspaceId: "w", userId: "u1", input: body as never });
    const embedOnly = await change.estimateWork({
      features: twin ? (await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: body as never }))!.nextPipeline : pii,
      stages: twin!.impact.stages, documents: 2, pages: 10, orgId: "o1",
    });
    // The in-flight PII work is owed again; the compiled embed subset already includes it, so it is priced once.
    expect(twin!.estimate).toMatchObject({ documents: 2, pages: 10 });
    expect(twin!.impact.stages).toContain("pii-detect");
    expect(twin!.estimate!.seconds!.high).toBeGreaterThanOrEqual(embedOnly.seconds!.high);

    const second = await patch(body);
    expect(second.applied!.cancelledRunIds).toEqual(first.applied!.job!.runIds);
    expect(await stagesOf(second.applied!.job!.id)).toEqual(expect.arrayContaining(["pii-detect", "embed"]));
    expect(second.applied!.job!.estimate).toEqual(twin!.estimate);
  });

  it("keeps a cancelled summaries re-index's stages when an embedding change supersedes it", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const withSummaries = pipeline({ summarize: true });
    const first = await patch({ pipeline: withSummaries, apply: "reindex" });
    expect(await stagesOf(first.applied!.job!.id)).toContain("document-summary");
    const second = await patch(embeddingTo(withSummaries));
    const secondStages = await stagesOf(second.applied!.job!.id);
    expect(secondStages).toEqual(expect.arrayContaining(["document-summary", "embed"]));
  });

  it("re-runs everything for a document whose cancelled run had no stage subset", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const first = await patch(embeddingChange());
    await sql`update workspace_runs set pipeline = pipeline - 'stageSubset' where id = ${first.applied!.job!.id}`;
    const second = await patch(embeddingTo(embeddingChange().pipeline));
    const runs = await sql<{ s: unknown }[]>`select pipeline -> 'stageSubset' as s from workspace_runs where job_id = ${second.applied!.job!.id}`;
    expect(runs.every((run) => run.s === null)).toBe(true);
  });

  it("leaves in-flight full-index runs alone: they build the previous config, which stays served", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    // A full index (map -> full) is in flight for a deferred document; it indexes with the config current when it started.
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('fi', 'o1', 'u1', 'w', 'full-index', 'processing', 'embed', '{}', 1)`;
    const { applied } = await patch(embeddingChange());
    expect(applied!.cancelledRunIds).toEqual([]);
    const [run] = await sql<{ status: string; control_state: string | null }[]>`select status, control_state from workspace_runs where id = 'fi'`;
    expect(run).toEqual({ status: "processing", control_state: null });
    // Its result is stamped with the previous config, which the map still records, so it stays searchable.
    const [ws] = await sql<{ index_configs: Record<string, unknown> }[]>`select index_configs from workspaces where id = 'w'`;
    expect(Object.keys(ws!.index_configs)).toContain(indexConfigHash(indexConfigOf(pipeline())));
  });
});

describe("concurrent PATCHes do not lose updates", () => {
  const plan = async (input: Record<string, unknown>) => (await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: input as never }))!;
  const modelOf = async () => ((await sql`select pipeline from workspaces where id = 'w'`)[0]!.pipeline as PipelineFeatures).embedding.modelUri;

  it("an embedding change planned before a budget change keeps the budget (and the job matches the final index)", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const embedding = await plan(embeddingChange());
    const budget = await plan({ monthlyBudgetCents: 4321 });
    await change.applyWorkspaceChange({ plan: budget, userId: "u1" });
    const applied = await change.applyWorkspaceChange({ plan: embedding, userId: "u1" });
    const [row] = await sql`select monthly_budget_cents, pipeline, index_configs from workspaces where id = 'w'`;
    expect(row!.monthly_budget_cents).toBe(4321);
    expect(await modelOf()).toBe("llm://transformers.js/Xenova/gte-small");
    const finalHash = indexConfigHash(indexConfigOf(row!.pipeline as PipelineFeatures));
    expect(Object.keys(row!.index_configs as object)).toContain(finalHash);
    expect(applied!.job).toMatchObject({ kind: "reindex" });
    const [run] = await sql`select pipeline from workspace_runs where id = ${applied!.job!.id}`;
    expect((run!.pipeline as PipelineFeatures).embedding.modelUri).toBe("llm://transformers.js/Xenova/gte-small");
  });
});

describe("re-index version numbers", () => {
  it("does not reuse the number of an upload that is still in flight", async () => {
    await seed({ credits: 10_000, documents: 1, vectorized: true });
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id, version_number, previous_version_id)
      values ('up2', 'o1', 'u1', 'w', 'src', 'f0.pdf', 'application/pdf', 'k0', 'processing', 5, 'c0', 2, 'd0')`;
    await patch(embeddingChange());
    const children = await sql<{ version_number: number }[]>`select version_number from documents where reindex_of = 'd0'`;
    expect(children).toEqual([{ version_number: 3 }]);
  });
});

describe("re-plan exhaustion", () => {
  it("throws a retryable 409 config_conflict and changes nothing", async () => {
    await seed({ credits: 10_000, documents: 1, vectorized: true });
    const stale = { ...(await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: { monthlyBudgetCents: 777 } as never }))!, rowVersion: "not-the-row-version" };
    await expect(change.applyWorkspaceChange({ plan: stale, userId: "u1", maxAttempts: 1 })).rejects.toMatchObject({ status: 409, code: "config_conflict" });
    expect((await sql`select monthly_budget_cents from workspaces where id = 'w'`)[0]!.monthly_budget_cents).toBeNull();
  });
});

describe("estimator prices the compiled plan the run will execute", () => {
  const fields: Array<[string, Partial<PipelineFeatures>]> = [
    ["embedding model", { embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/gte-small" as never } }],
    ["summarize", { summarize: true }],
    ["pii policy", { piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true, action: "block_indexing" as const } }],
    ["structured extraction", { structuredExtraction: { ...defaultPipelineFeatures.structuredExtraction, supportingPrompt: "Extract totals." } }],
    ["vision", { vision: { ...defaultPipelineFeatures.vision, forceAllPages: true } }],
    ["document extraction", { documentExtraction: { ...defaultPipelineFeatures.documentExtraction, forceOcr: true } }],
    ["parser playbook", { parserPlaybook: "agentic" as never }],
    ["preserve tables", { preserveTables: !defaultPipelineFeatures.preserveTables }],
    ["propositions", { propositionIndex: true as never }],
  ];

  it.each(fields)("%s: priced and displayed stages equal the compiled stageOrder", async (_name, patchFields) => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const plan = await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: { pipeline: pipeline(patchFields), apply: "reindex" } as never });
    if (!plan || !plan.reindex || plan.impact.stages.length === 0) return; // field has no re-index effect in this config
    const compiled = compilePipelinePlan({ ...withoutStageSelection(plan.nextPipeline), stageSubset: [...plan.impact.stages] } as PipelineFeatures).stageOrder;
    expect(plan.impact.stages).toEqual(compiled);
    const priced = estimatePipelineWork({ features: plan.nextPipeline, stages: compiled, documents: 2, pages: 10, workerSlots: 50, env: process.env });
    expect(plan.estimate).toEqual(priced);
  });

  it("at least the embedding change is a priced re-index (guards the table above)", async () => {
    await seed({ credits: 10_000, documents: 2, vectorized: true });
    const plan = await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: embeddingChange() as never });
    expect(plan!.impact.stages.length).toBeGreaterThan(0);
    expect(plan!.estimate).not.toBeNull();
  });
});

describe("estimates equal the mutation's job estimate", () => {
  it("workspace estimate route payload matches job.estimate", async () => {
    await seed({ credits: 10_000 });
    const body = embeddingChange();
    const estimated = await change.estimateWorkspaceChange({ workspaceId: "w", userId: "u1", input: body as never });
    expect(estimated!.impact.kind).toBe("reindex-required");
    expect(estimated!.estimate).toMatchObject({ documents: 2, pages: 10 });
    const { applied } = await patch(body);
    expect(applied!.job!.estimate).toEqual(estimated!.estimate);
  });

  it("reports billing disabled with null credits when the deployment does not bill", async () => {
    await seed({ credits: 10_000 });
    const estimated = await change.estimateWorkspaceChange({ workspaceId: "w", userId: "u1", input: embeddingChange() as never, env: {} });
    expect(estimated!.estimate).toMatchObject({ billing: "disabled", credits: null });
    expect(change.billingState({})).toBe("disabled");
    expect(change.billingState({ STRIPE_SECRET_KEY: "sk_test" })).toBe("enforced");
  });
});

describe("job resource", () => {
  it("serves the job status shape and SSE events", async () => {
    await seed({ credits: 10_000 });
    const { applied } = await patch(embeddingChange());
    const app = withTestSession(new Hono(), { id: "u1" }).route("/v1/jobs", jobsRoutes);

    const res = await app.request(`/v1/jobs/${applied!.job!.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: applied!.job!.id, kind: "reindex", status: "queued", runIds: applied!.job!.runIds,
      queue: { position: 1, ahead: 0 }, statusUrl: `/v1/jobs/${applied!.job!.id}`,
      progress: { documentsTotal: 2, pagesTotal: 10 },
    });
    expect((await app.request("/v1/jobs/nope")).status).toBe(404);

    await sql`update workspace_runs set status = 'completed' where id = ${applied!.job!.id}`;
    const events = await (await app.request(`/v1/jobs/${applied!.job!.id}/events`)).text();
    expect(events).toContain("event: status");
    expect(events).toContain("event: progress");
    expect(events).toContain("event: done");
    expect(jobs.isJobTerminal({ status: "completed" })).toBe(true);
  });

  it("folds run states", () => {
    expect(jobs.foldRunStates([{ status: "processing", control_state: "cancel_requested" }])).toBe("processing");
    expect(jobs.foldRunStates([{ status: "completed", control_state: "cancel_requested" }])).toBe("completed");
    expect(jobs.foldRunStates([{ status: "failed", control_state: "cancelled" }])).toBe("cancelled");
    expect(jobs.foldRunStates([{ status: "blocked", control_state: null }])).toBe("blocked");
    expect(jobs.foldRunStates([{ status: "blocked", control_state: null }, { status: "processing", control_state: null }])).toBe("processing");
    expect(jobs.foldRunStates([{ status: "completed", control_state: null }, { status: "failed", control_state: null }])).toBe("failed");
  });
});

describe("inline estimate budget", () => {
  it("drops the inline estimate for a slow computation and points at the estimate route", async () => {
    const estimate = { pages: 1, documents: 1, billing: "disabled" as const, credits: null, seconds: null, basis: "x" };
    expect(await jobs.inlineEstimate(() => estimate, "/est")).toEqual({ estimate });
    const slow = await jobs.inlineEstimate(async () => { await new Promise((r) => setTimeout(r, 20)); return estimate; }, "/est", 5);
    expect(slow).toEqual({ estimate: null, estimateUrl: "/est" });
  });

  it("a workspace change whose planning exceeds the budget returns job.estimate null with estimateUrl", async () => {
    await seed({ credits: 10_000 });
    const plan = await change.planWorkspaceChange({ workspaceId: "w", userId: "u1", input: embeddingChange() as never, budgetMs: -1 });
    expect(plan!.estimateWithinBudget).toBe(false);
    const applied = await change.applyWorkspaceChange({ plan: plan!, userId: "u1" });
    expect(applied!.job).toMatchObject({ estimate: null, estimateUrl: "/v1/workspaces/w/estimate" });
    // The estimate route still answers in full.
    const full = await change.estimateWorkspaceChange({ workspaceId: "w", userId: "u1", input: { monthlyBudgetCents: 1 } as never });
    expect(full!.estimate).toBeNull();
  });
});

describe("index config hash", () => {
  it("differs when the embedding model changes", () => {
    expect(indexConfigHash(indexConfigOf(pipeline()))).not.toBe(indexConfigHash(indexConfigOf(embeddingChange().pipeline)));
  });
});
