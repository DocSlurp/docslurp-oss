import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  costEstimateSchema,
  defaultPipelineFeatures,
  DISTINCT_TEST_PRICING,
  installTestPricing,
  resetPricingProviderForTests,
  jobStatusSchema,
  projectSummaryTreeBackfillSchema,
  resolveEmbeddingRoute,
  summaryTreeJobSchema,
  SUMMARY_TREE_JOB_NOTES,
  SUMMARY_TREE_MIN_DOCUMENT_LEAVES,
} from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * The summary tree backfill API over a migrated database: estimate, start, status and cancel under the project's
 * summary-tree routes, and the shared job resource (`/v1/jobs/:jobId`). Nothing here runs a job or calls a model:
 * a model call from any of these routes fails the test.
 */
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));

const spend = vi.hoisted(() => ({ calls: [] as Array<[string | null | undefined, string | null | undefined]>, blocked: false }));
vi.mock("../services/billing/spend-guard.js", async (original) => {
  const actual = await original<typeof import("../services/billing/spend-guard.js")>();
  return {
    ...actual,
    assertCanSpend: async (orgId: string | null | undefined, projectId?: string | null) => {
      spend.calls.push([orgId, projectId]);
      if (spend.blocked) throw new actual.SpendBlockedError("Out of credits", "credit_exhausted", false);
    },
  };
});

let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let treeRoutes: typeof import("../routes/project-summary-tree.js").projectSummaryTreeRoutes;
let jobsRoutes: typeof import("../routes/jobs.js").jobsRoutes;
let treeJobs: typeof import("../services/project-summary-tree-jobs.js");
let apiKeys: typeof import("../services/api-keys.js");
let apiKeyAuth: typeof import("../middleware/api-key-auth.js").apiKeyAuth;

type Key = { orgId: string | null; scopes: string[]; keyType?: string; projectIds?: string[] };
const TREE = { ...defaultPipelineFeatures, embed: true, indexVectors: true, summarize: true, summaryTree: { enabled: true } };
const route = resolveEmbeddingRoute(defaultPipelineFeatures.embedding);

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    // As the server's own pool: numeric columns arrive as numbers.
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'tree-a@example.com'), ('u2', 'B', 'tree-b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'tree-org', 'u1'), ('o2', 'Other', 'tree-other', 'u2')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner'), ('o2', 'u2', 'owner')`;
  ({ projectSummaryTreeRoutes: treeRoutes } = await import("../routes/project-summary-tree.js"));
  ({ jobsRoutes } = await import("../routes/jobs.js"));
  treeJobs = await import("../services/project-summary-tree-jobs.js");
  apiKeys = await import("../services/api-keys.js");
  ({ apiKeyAuth } = await import("../middleware/api-key-auth.js"));
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
});

function appFor(userId: string, key?: Key) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: userId, email: `${userId}@example.com`, name: userId, image: null } as never);
    if (key) c.set("apiKey", { keyId: "k1", userId, projectIds: [], keyType: "server", ...key } as never);
    await next();
  });
  app.route("/v1/projects", treeRoutes);
  app.route("/v1/jobs", jobsRoutes);
  return app;
}

const post = (app: Hono, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function seedDocument(projectId: string, orgId: string, userId: string, id: string, chunks: number, options: { overlap?: number; tokens?: number } = {}) {
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
    values (${id}, ${orgId}, ${userId}, ${projectId}, ${`run-${projectId}`}, ${`${id}.pdf`}, 'application/pdf', ${`k-${id}`}, 'completed', ${Math.ceil(chunks / 3)})`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
    select ${id} || '-' || n, ${id}, ${`run-${projectId}`}, ${userId}, n, 'passage', '{}'::text[], 1, ${options.tokens ?? 100},
      jsonb_build_object('overlapIndex', case when n < ${options.overlap ?? 0} then 1 else 0 end)
    from generate_series(0, ${chunks - 1}) as n`;
}

/** An arbitrary test price for the summary tree unit: no deployment's price. */
const UNIT = 0.75;
/** A deployment that charges for work and prices the tree's unit: the default of these tests. */
const priced = () => installTestPricing({ ...DISTINCT_TEST_PRICING, summaryTreeCallCredits: () => UNIT });

async function seed() {
  spend.calls.length = 0;
  spend.blocked = false;
  priced();
  treeJobs.resetSummaryTreeBackfillEstimateCache();
  vi.unstubAllEnvs();
  vi.stubEnv("DOCSLURP_SUMMARY_TREE_BUILD", "on");
  await sql`delete from summary_tree_jobs`;
  await sql`delete from projects`;
  for (const [id, org, user] of [["w", "o1", "u1"], ["w2", "o1", "u1"], ["x", "o2", "u2"]] as const) {
    await sql`insert into projects(id, org_id, user_id, name, slug, pipeline) values (${id}, ${org}, ${user}, ${id}, ${`${id}-slug`}, ${sql.json(JSON.parse(JSON.stringify(TREE)))})`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (${`run-${id}`}, ${org}, ${user}, ${id}, 'bulk-upload', 'completed', 'completed', '{}')`;
  }
  // Project w: two long documents, one short one, one with a servable tree, one marked skipped.
  await seedDocument("w", "o1", "u1", "long-a", 96);
  // Forty of these chunks are overlap chunks: they are not leaves.
  await seedDocument("w", "o1", "u1", "long-b", 120, { overlap: 40 });
  await seedDocument("w", "o1", "u1", "short", SUMMARY_TREE_MIN_DOCUMENT_LEAVES - 1);
  await seedDocument("w", "o1", "u1", "ready", 96);
  await seedDocument("w", "o1", "u1", "skipped", 96);
  await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, built_at)
    values ('ready', 'o1', 'w', 'run-w', 'ready', ${route.model}, ${route.dimensions}, now())`;
  await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, skip_reason)
    values ('skipped', 'o1', 'w', 'run-w', 'skipped', 'tables')`;
  // Other tenants' documents, which no estimate or job of w may count.
  await seedDocument("w2", "o1", "u1", "other-project", 96);
  await seedDocument("x", "o2", "u2", "other-org", 96);
}

beforeEach(seed);

describe("estimate", () => {
  it("counts the project's documents without a servable tree, from Postgres alone", async () => {
    const app = appFor("u1");
    const status = await app.request("/v1/projects/w/summary-tree/backfill");
    expect(status.status).toBe(200);
    const body = projectSummaryTreeBackfillSchema.parse(await status.json());
    // long-a (96 leaves), long-b (80 leaves once its overlap chunks are left out) and the short document.
    expect(body).toMatchObject({ projectId: "w", activeJob: null, lastJob: null, estimate: { documents: 3, documentsToBuild: 2, leaves: 176, basis: "default" } });
    const planned = body.estimate!;
    expect(planned.nodes).toBeGreaterThan(176 / 12);
    expect(planned.modelCalls).toBeGreaterThanOrEqual(planned.nodes);
    // Every leaf is read once: the input estimate is at least the stored tokens of the leaves.
    expect(planned.inputTokens).toBeGreaterThan(176 * 100);
    expect(planned.costCentsLow).toBeLessThanOrEqual(planned.costCents);
    expect(planned.costCentsHigh).toBeGreaterThanOrEqual(planned.costCents);
    // The cost is what the organization would be billed: one unit per expected model call, the basis of a job's cap.
    expect(planned.costBasis).toBe("billed");
    expect(planned.costCents).toBeCloseTo(planned.modelCalls * UNIT, 9);

    const twin = await post(app, "/v1/projects/w/summary-tree/backfill/estimate");
    expect(twin.status).toBe(200);
    const estimate = costEstimateSchema.parse((await twin.json() as { estimate: unknown }).estimate);
    expect(estimate).toMatchObject({ documents: 2, pages: 32 + 40 });
    expect(estimate.basis).not.toMatch(/\$|cent/i);
    // Estimating is not spending: no job row, no spend check.
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(0);
  });

  it("calibrates from finished builds of the same organization only", async () => {
    const stats = (nodes: number, ms: number) => sql.json({ summaryTreeStatus: "ready", nodes, generatedNodes: nodes, leaves: nodes * 10, modelCalls: nodes, inputTokens: nodes * 2_000, outputTokens: nodes * 200, durationMs: ms });
    // Another organization's builds: fast and tiny. They must not shape this project's estimate.
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats, completed_at)
      values ('run-x', 'other-org', 'summary-tree', 'completed', 1, ${stats(1_000, 1_000)}, now())`;
    const app = appFor("u1");
    const before = projectSummaryTreeBackfillSchema.parse(await (await app.request("/v1/projects/w/summary-tree/backfill")).json());
    expect(before.estimate!.basis).toBe("default");
    // The status read keeps its estimate for a minute; the next read here must plan again.
    treeJobs.resetSummaryTreeBackfillEstimateCache();
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats, completed_at)
      values ('run-w', 'ready', 'summary-tree', 'completed', 1, ${stats(40, 80_000)}, now())`;
    const after = projectSummaryTreeBackfillSchema.parse(await (await app.request("/v1/projects/w/summary-tree/backfill")).json());
    expect(after.estimate).toMatchObject({ basis: "observed", nodes: 18, modelCalls: 18, inputTokens: 36_000, outputTokens: 3_600, seconds: 36 });
  });
});

describe("billing", () => {
  it("quotes billed credits where billing is enforced, and the model's own cost only where nothing is charged", async () => {
    const app = appFor("u1");
    vi.stubEnv("DOCSLURP_BILL_INGEST", "true");
    const enforced = await (await post(app, "/v1/projects/w/summary-tree/backfill/estimate")).json() as { estimate: { billing: string; credits: { low: number; high: number } } };
    const status = projectSummaryTreeBackfillSchema.parse(await (await app.request("/v1/projects/w/summary-tree/backfill")).json());
    expect(enforced.estimate.billing).toBe("enforced");
    expect(enforced.estimate.credits).toEqual({ low: status.estimate!.costCentsLow, high: status.estimate!.costCentsHigh });
    expect(status.estimate!.costCentsLow).toBeCloseTo(status.estimate!.modelCalls * UNIT * 0.5, 9);
    vi.unstubAllEnvs();
    vi.stubEnv("DOCSLURP_SUMMARY_TREE_BUILD", "on");

    // A deployment that does not charge (no provider, no billing): the estimate is the model's cost, and says so.
    resetPricingProviderForTests();
    treeJobs.resetSummaryTreeBackfillEstimateCache();
    const free = projectSummaryTreeBackfillSchema.parse(await (await app.request("/v1/projects/w/summary-tree/backfill")).json());
    expect(free.estimate).toMatchObject({ costBasis: "provider", documents: 3 });
    const quote = await (await post(app, "/v1/projects/w/summary-tree/backfill/estimate")).json() as { estimate: { billing: string; credits: unknown } };
    expect(quote.estimate).toMatchObject({ billing: "disabled", credits: null });
    const started = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ costBasis: "provider", estimate: { costBasis: "provider" } });
  });

  it("refuses the estimate and the start, and quotes nothing, while the deployment has no price for the tree", async () => {
    const app = appFor("u1");
    const unpriced: Array<() => void> = [
      () => { installTestPricing(DISTINCT_TEST_PRICING); },
      () => { resetPricingProviderForTests(); vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x"); },
      () => { installTestPricing({ ...DISTINCT_TEST_PRICING, summaryTreeCallCredits: () => 0 }); },
    ];
    for (const install of unpriced) {
      install();
      treeJobs.resetSummaryTreeBackfillEstimateCache();
      for (const response of [
        await post(app, "/v1/projects/w/summary-tree/backfill/estimate"),
        await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 }),
      ]) {
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "summary_tree_unpriced" } });
      }
      // The status still answers, with no estimate: nothing is priced from a default.
      const status = await app.request("/v1/projects/w/summary-tree/backfill");
      expect(status.status).toBe(200);
      expect(projectSummaryTreeBackfillSchema.parse(await status.json())).toMatchObject({ estimate: null, activeJob: null });
    }
    expect(spend.calls).toEqual([]);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(0);
  });

  it("holds a job's cap under the operator's ceiling and above a cap that would round to nothing", async () => {
    const app = appFor("u1");
    // Below one hundredth of a cent: refused by the request schema, never a constraint violation from the database.
    for (const maxCostCents of [0.00001, 0.001, 0.0099]) {
      const response = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents });
      expect(response.status, String(maxCostCents)).toBe(400);
    }
    // Above the default ceiling: refused with a named error that states the limit.
    const high = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 10_000.01 });
    expect(high.status).toBe(400);
    expect(await high.json()).toMatchObject({ error: { code: "summary_tree_backfill_cap_too_high" } });
    expect(spend.calls).toEqual([]);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(0);

    // The operator's own ceiling replaces the default, lower or higher; a value that is not a ceiling does not lift it.
    vi.stubEnv("DOCSLURP_SUMMARY_TREE_BACKFILL_MAX_COST_CENTS", "200");
    expect((await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 201 })).status).toBe(400);
    for (const bad of ["", "0", "-5", "lots", "Infinity"]) {
      vi.stubEnv("DOCSLURP_SUMMARY_TREE_BACKFILL_MAX_COST_CENTS", bad);
      expect((await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 10_001 })).status, bad).toBe(400);
    }
    vi.stubEnv("DOCSLURP_SUMMARY_TREE_BACKFILL_MAX_COST_CENTS", "200");
    const started = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 200 });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ maxCostCents: 200, costBasis: "billed" });
    // The smallest cap is stored as given.
    await sql`delete from summary_tree_jobs`;
    expect((await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 0.01 })).status).toBe(202);
    expect((await sql`select max_cost_cents::float8 as cap from summary_tree_jobs`)[0]).toEqual({ cap: 0.01 });
  });
});

describe("status estimate", () => {
  it("is planned at most once a minute per project, however often the status is read", async () => {
    const app = appFor("u1");
    const read = async () => projectSummaryTreeBackfillSchema.parse(await (await app.request("/v1/projects/w/summary-tree/backfill")).json());
    const first = await read();
    expect(first.estimate).toMatchObject({ documents: 3 });
    // A document arrives: the cached estimate is what every reader gets until it expires.
    await seedDocument("w", "o1", "u1", "long-c", 96);
    for (let i = 0; i < 5; i++) expect((await read()).estimate).toEqual(first.estimate);
    // The estimate route and a job's start always plan afresh.
    const fresh = await treeJobs.estimateSummaryTreeBackfill("w", "u1");
    expect(fresh.documents).toBe(3);
    // Another project of the same organization has its own entry, and never another project's numbers.
    expect((projectSummaryTreeBackfillSchema.parse(await (await app.request("/v1/projects/w2/summary-tree/backfill")).json())).estimate).toMatchObject({ documents: 1 });
    // Past the window, the status plans again.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + treeJobs.SUMMARY_TREE_BACKFILL_STATUS_ESTIMATE_TTL_MS + 1);
      expect((await read()).estimate).toMatchObject({ documents: 4 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("start", () => {
  it("needs a cap, the build switch, the tree turned on and an organization that may spend", async () => {
    const app = appFor("u1");
    for (const body of [{}, { maxCostCents: 0 }, { maxCostCents: -5 }, { maxCostCents: "100" }, { maxCostCents: 100, mode: "full" }, { maxCostCents: 1e12 }]) {
      expect((await post(app, "/v1/projects/w/summary-tree/backfill", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(spend.calls).toEqual([]);

    vi.stubEnv("DOCSLURP_SUMMARY_TREE_BUILD", "off");
    const off = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 });
    expect(off.status).toBe(400);
    expect(await off.json()).toMatchObject({ error: { code: "summary_tree_unavailable" } });
    expect((await post(app, "/v1/projects/w/summary-tree/backfill/estimate")).status).toBe(400);
    vi.stubEnv("DOCSLURP_SUMMARY_TREE_BUILD", "on");

    await sql`update projects set pipeline = ${sql.json(JSON.parse(JSON.stringify({ ...TREE, summaryTree: { enabled: false } })))} where id = 'w2'`;
    expect((await post(app, "/v1/projects/w2/summary-tree/backfill", { maxCostCents: 500 })).status).toBe(409);
    expect(spend.calls).toEqual([]);

    spend.blocked = true;
    const blocked = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ code: "credit_exhausted" });
    expect(spend.calls).toEqual([["o1", "w"]]);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(0);
  });

  it("queues one capped job per project and reports it through the shared job resource", async () => {
    const app = appFor("u1");
    const twin = (await (await post(app, "/v1/projects/w/summary-tree/backfill/estimate")).json() as { estimate: unknown }).estimate;
    const started = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 750 });
    expect(started.status).toBe(202);
    const body = await started.json() as Record<string, unknown> & { id: string; job: Record<string, unknown> };
    const job = summaryTreeJobSchema.parse((({ job: _job, ...rest }) => rest)(body));
    expect(job).toMatchObject({ projectId: "w", status: "queued", blockedReason: null, maxCostCents: 750, documentsTotal: 3, costCents: 0, modelCalls: 0, cancelRequested: false });
    expect(job.estimate).toMatchObject({ documents: 3, documentsToBuild: 2 });
    expect(jobStatusSchema.parse(body.job)).toMatchObject({ id: job.id, kind: "summary-tree-backfill", status: "queued", statusUrl: `/v1/jobs/${job.id}` });
    expect(body.job.estimate).toEqual(twin);
    expect(spend.calls).toEqual([["o1", "w"]]);
    const [row] = await sql<Array<Record<string, unknown>>>`select org_id, project_id, user_id, max_cost_cents::float8 as cap, cursor from summary_tree_jobs where id = ${job.id}`;
    expect(row).toEqual({ org_id: "o1", project_id: "w", user_id: "u1", cap: 750, cursor: null });

    // One active job per project; the refusal names it.
    const again = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 100 });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { details: { activeJob: { id: job.id } } } });
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(1);

    // Status under the project, and the shared job resource (polling and server-sent events).
    expect(await (await app.request(`/v1/projects/w/summary-tree/backfill/${job.id}`)).json()).toMatchObject({ id: job.id, status: "queued" });
    expect((await (await app.request("/v1/projects/w/summary-tree/backfill")).json() as { activeJob: { id: string } }).activeJob.id).toBe(job.id);
    const shared = await (await app.request(`/v1/jobs/${job.id}`)).json() as Record<string, unknown>;
    expect(shared).toMatchObject({ id: job.id, kind: "summary-tree-backfill", status: "queued", progress: { documents: 0, documentsTotal: 3 } });
    expect(shared.estimate).toEqual(twin);

    // A parked job is `blocked` with a reason in the shared vocabulary; no backend is named.
    for (const [stored, reason] of [["build-off", "unavailable"], ["balance", "capacity"], ["credits", "credits"], ["policy", "policy"]] as const) {
      await sql`update summary_tree_jobs set status = 'blocked', blocked_reason = ${stored} where id = ${job.id}`;
      expect(await (await app.request(`/v1/jobs/${job.id}`)).json()).toMatchObject({ status: "blocked", reason });
      expect(await (await app.request(`/v1/projects/w/summary-tree/backfill/${job.id}`)).json()).toMatchObject({ status: "blocked", blockedReason: stored });
    }
    await sql`update summary_tree_jobs set status = 'running', blocked_reason = null, documents_ready = 1, documents_skipped = 1 where id = ${job.id}`;
    // The shared event stream accepts the job: its first frame is the job's status.
    const events = await app.request(`/v1/jobs/${job.id}/events`);
    expect(events.status).toBe(200);
    const reader = events.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: status");
    expect(first).toContain("summary-tree-backfill");
    await reader.cancel();
    expect(await (await app.request(`/v1/jobs/${job.id}`)).json()).toMatchObject({ status: "processing", progress: { documents: 2, documentsTotal: 3 } });

    // The worker's failure text never reaches a caller.
    await sql`update summary_tree_jobs set status = 'failed', error = 'TypeError: x at /app/worker/dist/job.js:12' where id = ${job.id}`;
    const failed = await (await app.request(`/v1/projects/w/summary-tree/backfill/${job.id}`)).json() as { error: string };
    expect(failed.error).not.toMatch(/TypeError|worker/);
    expect(failed.error).toMatch(/backfill failed/);
  });

  it("refuses when every document already has a tree or needs none", async () => {
    await sql`delete from documents where id in ('long-a', 'long-b', 'short')`;
    const response = await post(appFor("u1"), "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 });
    expect(response.status).toBe(409);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("cancels a queued or parked job at once and asks a running one to stop", async () => {
    const app = appFor("u1");
    const start = async () => (await (await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 })).json() as { id: string }).id;
    const queued = await start();
    expect(await (await post(app, `/v1/projects/w/summary-tree/backfill/${queued}/cancel`)).json()).toMatchObject({ status: "cancelled", error: SUMMARY_TREE_JOB_NOTES.cancelled, cancelRequested: true });

    const parked = await start();
    await sql`update summary_tree_jobs set status = 'blocked', blocked_reason = 'balance', resume_after = now() where id = ${parked}`;
    expect(await (await post(app, `/v1/projects/w/summary-tree/backfill/${parked}/cancel`)).json()).toMatchObject({ status: "cancelled", blockedReason: null });
    expect((await sql`select resume_after from summary_tree_jobs where id = ${parked}`)[0]).toEqual({ resume_after: null });

    const running = await start();
    await sql`update summary_tree_jobs set status = 'running', lease_owner = 'worker-a', lease_expires_at = now() + interval '5 minutes' where id = ${running}`;
    expect(await (await post(app, `/v1/projects/w/summary-tree/backfill/${running}/cancel`)).json()).toMatchObject({ status: "running", cancelRequested: true });
    expect(await (await app.request(`/v1/jobs/${running}`)).json()).toMatchObject({ status: "processing" });
    // A finished job stays as it ended.
    await sql`update summary_tree_jobs set status = 'completed', cancel_requested_at = null where id = ${running}`;
    expect(await (await post(app, `/v1/projects/w/summary-tree/backfill/${running}/cancel`)).json()).toMatchObject({ status: "completed", cancelRequested: false });
  });
});

describe("authorization", () => {
  async function startedJob(): Promise<string> {
    return (await (await post(appFor("u1"), "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 })).json() as { id: string }).id;
  }
  const unchanged = async (jobId: string) => expect((await sql`select status, cancel_requested_at from summary_tree_jobs where id = ${jobId}`)[0]).toEqual({ status: "queued", cancel_requested_at: null });

  it("gives another organization's user nothing: no estimate, start, status or cancel", async () => {
    const jobId = await startedJob();
    const stranger = appFor("u2");
    expect((await stranger.request("/v1/projects/w/summary-tree/backfill")).status).toBe(404);
    expect((await post(stranger, "/v1/projects/w/summary-tree/backfill/estimate")).status).toBe(404);
    expect((await post(stranger, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 })).status).toBe(404);
    expect((await stranger.request(`/v1/projects/w/summary-tree/backfill/${jobId}`)).status).toBe(404);
    expect((await post(stranger, `/v1/projects/w/summary-tree/backfill/${jobId}/cancel`)).status).toBe(404);
    expect((await stranger.request(`/v1/jobs/${jobId}`)).status).toBe(404);
    expect((await stranger.request(`/v1/jobs/${jobId}/events`)).status).toBe(404);
    // The job id of project w through the stranger's own project: not found, and not cancelled.
    expect((await stranger.request(`/v1/projects/x/summary-tree/backfill/${jobId}`)).status).toBe(404);
    expect((await post(stranger, `/v1/projects/x/summary-tree/backfill/${jobId}/cancel`)).status).toBe(404);
    // Nor through another project of the same organization.
    expect((await appFor("u1").request(`/v1/projects/w2/summary-tree/backfill/${jobId}`)).status).toBe(404);
    expect((await post(appFor("u1"), `/v1/projects/w2/summary-tree/backfill/${jobId}/cancel`)).status).toBe(404);
    await unchanged(jobId);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(1);
  });

  it("gives a member or viewer without edit rights the status, and 403 for estimate, start and cancel", async () => {
    // Signed-in users of the project's own organization (no API key): the real services and their access check.
    await sql`insert into "user"(id, name, email) values ('m1', 'M', 'tree-m@example.com'), ('v1', 'V', 'tree-v@example.com') on conflict (id) do nothing`;
    await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'm1', 'member'), ('o1', 'v1', 'member') on conflict do nothing`;
    await sql`insert into project_members(project_id, user_id, role) values ('w', 'm1', 'viewer'), ('w', 'v1', 'viewer')`;
    const jobId = await startedJob();
    for (const userId of ["m1", "v1"]) {
      const app = appFor(userId);
      // Reading is allowed: they are members of the project.
      expect((await app.request("/v1/projects/w/summary-tree/backfill")).status, userId).toBe(200);
      expect((await app.request(`/v1/projects/w/summary-tree/backfill/${jobId}`)).status).toBe(200);
      // Everything that spends or stops spending is the editors'.
      for (const response of [
        await post(app, "/v1/projects/w/summary-tree/backfill/estimate"),
        await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 }),
        await post(app, `/v1/projects/w/summary-tree/backfill/${jobId}/cancel`),
      ]) {
        expect(response.status, userId).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: "editor_required" } });
      }
    }
    await unchanged(jobId);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(1);
    // The service itself, without a route in front of it.
    const jobs = await import("../services/project-summary-tree-jobs.js");
    await expect(jobs.startSummaryTreeBackfill("w", "v1", { maxCostCents: 500 })).rejects.toMatchObject({ status: 403 });
    await expect(jobs.estimateSummaryTreeBackfill("w", "v1")).rejects.toMatchObject({ status: 403 });
    await expect(jobs.cancelSummaryTreeJob("w", "v1", jobId)).rejects.toMatchObject({ status: 403 });
    await unchanged(jobId);
    // No spend admission was asked on their behalf.
    expect(spend.calls.filter(([, project]) => project === "w")).toHaveLength(1);
  });

  it("lets only a managing server key start, estimate and cancel; other keys read or get nothing", async () => {
    const jobId = await startedJob();
    await sql`delete from summary_tree_jobs`;
    const manage = appFor("u1", { orgId: "o1", scopes: ["projects:manage"] });
    const started = await post(manage, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 });
    expect(started.status).toBe(202);
    const id = (await started.json() as { id: string }).id;
    expect(id).not.toBe(jobId);

    // A search-scoped server key reads, and changes nothing.
    const reader = appFor("u1", { orgId: "o1", scopes: ["search:deep"] });
    expect((await reader.request("/v1/projects/w/summary-tree/backfill")).status).toBe(200);
    expect((await reader.request(`/v1/projects/w/summary-tree/backfill/${id}`)).status).toBe(200);
    expect((await reader.request(`/v1/jobs/${id}`)).status).toBe(200);
    expect((await post(reader, "/v1/projects/w/summary-tree/backfill/estimate")).status).toBe(403);
    expect((await post(reader, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 })).status).toBe(403);
    expect((await post(reader, `/v1/projects/w/summary-tree/backfill/${id}/cancel`)).status).toBe(403);

    // No relevant scope, and a browser key even with the managing scope: nothing.
    for (const key of [{ orgId: "o1", scopes: [] }, { orgId: "o1", scopes: ["chat"] }, { orgId: "o1", scopes: ["projects:manage"], keyType: "client" }] satisfies Key[]) {
      const app = appFor("u1", key);
      expect((await app.request("/v1/projects/w/summary-tree/backfill")).status, JSON.stringify(key)).toBe(403);
      expect((await app.request(`/v1/projects/w/summary-tree/backfill/${id}`)).status).toBe(403);
      expect((await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 })).status).toBe(403);
      expect((await post(app, `/v1/projects/w/summary-tree/backfill/${id}/cancel`)).status).toBe(403);
    }
    expect((await appFor("u1", { orgId: "o1", scopes: [] }).request(`/v1/jobs/${id}`)).status).toBe(403);

    // A managing key restricted to another project, and one bound to another organization: the project is not theirs.
    for (const key of [{ orgId: "o1", scopes: ["projects:manage"], projectIds: ["w2"] }, { orgId: "o2", scopes: ["projects:manage"] }] satisfies Key[]) {
      const app = appFor("u1", key);
      expect((await app.request("/v1/projects/w/summary-tree/backfill")).status, JSON.stringify(key)).toBe(404);
      expect((await app.request(`/v1/projects/w/summary-tree/backfill/${id}`)).status).toBe(404);
      expect((await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 })).status).toBe(404);
      expect((await post(app, `/v1/projects/w/summary-tree/backfill/${id}/cancel`)).status).toBe(404);
      expect((await app.request(`/v1/jobs/${id}`)).status).toBe(404);
    }
    await unchanged(id);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(1);
  });

  it("refuses a revoked key before any route runs", async () => {
    const { key, rawKey } = await apiKeys.createApiKey("u1", "backfill", { orgId: "o1", scopes: ["projects:manage"], keyType: "server" });
    const app = new Hono();
    app.use("*", apiKeyAuth);
    app.route("/v1/projects", treeRoutes);
    app.route("/v1/jobs", jobsRoutes);
    const auth = { Authorization: `Bearer ${rawKey}` };

    const started = await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 }, auth);
    expect(started.status).toBe(202);
    const id = (await started.json() as { id: string }).id;
    expect((await app.request(`/v1/jobs/${id}`, { headers: auth })).status).toBe(200);

    expect(await apiKeys.revokeApiKey(key.id, "u1")).not.toBeNull();
    for (const response of [
      await app.request("/v1/projects/w/summary-tree/backfill", { headers: auth }),
      await app.request(`/v1/projects/w/summary-tree/backfill/${id}`, { headers: auth }),
      await app.request(`/v1/jobs/${id}`, { headers: auth }),
      await post(app, "/v1/projects/w/summary-tree/backfill/estimate", undefined, auth),
      await post(app, "/v1/projects/w/summary-tree/backfill", { maxCostCents: 500 }, auth),
      await post(app, `/v1/projects/w/summary-tree/backfill/${id}/cancel`, undefined, auth),
    ]) {
      expect(response.status).toBe(403);
    }
    await unchanged(id);
    expect(await sql`select 1 from summary_tree_jobs`).toHaveLength(1);
  });
});
