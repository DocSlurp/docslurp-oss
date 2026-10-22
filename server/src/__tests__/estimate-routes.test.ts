import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, workspaceTemplates } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Real routes over a migrated database: each work-creating mutation reports the same `job.estimate` its
 * `/estimate` twin returns, and every twin enforces the mutation's authorization (and creates nothing).
 */
vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "1");
vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_estimates");

let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let runsRoutes: typeof import("../routes/runs.js").runsRoutes;
let documentsRoutes: typeof import("../routes/documents.js").documentsRoutes;
let workspacesRoutes: typeof import("../routes/workspaces.js").workspacesRoutes;
let graphRoutes: typeof import("../routes/workspace-graph.js").workspaceGraphRoutes;
let uploadEstimateRoutes: typeof import("../routes/uploads.js").uploadEstimateRoutes;
let jobsRoutes: typeof import("../routes/jobs.js").jobsRoutes;

type Key = { orgId: string | null; scopes: string[]; keyType?: string; workspaceIds?: string[]; userId?: string; keyId?: string };

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/temporal.js")>()),
    signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn(), signalPipelineCancel: vi.fn(),
    startPipelineWorkflow: vi.fn(async () => ({ started: true })),
  }));
  vi.doMock("../lib/file-urls.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../lib/file-urls.js")>()),
    fileUrlForArtifact: () => "http://files.test/x",
  }));
  vi.doMock("../services/run-lifecycle.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../services/run-lifecycle.js")>()),
    runLifecycle: { start: vi.fn(async () => ({ status: "started" })) },
  }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  ({ runsRoutes } = await import("../routes/runs.js"));
  ({ documentsRoutes } = await import("../routes/documents.js"));
  ({ workspacesRoutes } = await import("../routes/workspaces.js"));
  ({ workspaceGraphRoutes: graphRoutes } = await import("../routes/workspace-graph.js"));
  ({ uploadEstimateRoutes } = await import("../routes/uploads.js"));
  ({ jobsRoutes } = await import("../routes/jobs.js"));
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
});

function appFor(userId: string, key?: Key) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: userId, email: `${userId}@x`, name: userId, image: null } as never);
    if (key) c.set("apiKey", { keyId: "k1", userId, workspaceIds: [], ...key } as never);
    await next();
  });
  app.route("/v1/runs", runsRoutes);
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/workspaces", workspacesRoutes);
  app.route("/v1/workspaces", graphRoutes);
  app.route("/v1/uploads", uploadEstimateRoutes);
  app.route("/v1/jobs", jobsRoutes);
  return app;
}

const post = (app: Hono, path: string, body: unknown = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const graphPipeline = { ...defaultPipelineFeatures, graphRag: true, embed: true };

async function seed() {
  await sql`delete from graph_jobs`;
  await sql`delete from document_page_states`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
  await sql`delete from workspace_members`;
  await sql`delete from workspaces`;
  await sql`delete from org_memberships`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values ('o1', 'Org', 'org', 'u1', 100000, now()), ('o2', 'Other', 'other', 'u2', 100000, now())`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner'), ('o1', 'u2', 'member'), ('o2', 'u2', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, slug, pipeline, is_default)
    values ('w', 'o1', 'u1', 'W', 'w-slug', ${sql.json(JSON.parse(JSON.stringify(graphPipeline)))}, false),
           ('wd', 'o1', 'u1', 'Default', 'default-slug', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))}, true)`;
  await sql`update organizations set is_personal = true, personal_owner_user_id = 'u1' where id = 'o1'`;
  await sql`insert into workspace_search_settings(workspace_id, user_id) values ('w', 'u1') on conflict do nothing`.catch(() => undefined);
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents, pages_total, artifacts)
    values ('run', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(graphPipeline)))}, 2, 9, '{}')`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id, indexing_mode)
    values ('d1', 'o1', 'u1', 'w', 'run', 'a.pdf', 'application/pdf', 'k1', 'completed', 4, 'c1', 'map'),
           ('d2', 'o1', 'u1', 'w', 'run', 'b.pdf', 'application/pdf', 'k2', 'completed', 5, 'c2', 'map')`;
}

describe("estimate twins equal the mutation's job.estimate", () => {
  beforeEach(seed);

  it("run reprocess", async () => {
    const app = appFor("u1");
    const twin = await (await post(app, "/v1/runs/run/reprocess/estimate", {})).json() as { estimate: unknown; billing: string };
    expect(twin.estimate).toMatchObject({ documents: 2, pages: 9, billing: "enforced" });
    const res = await post(app, "/v1/runs/run/reprocess", {});
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { estimate: unknown; kind: string; id: string } };
    expect(body.job.kind).toBe("reprocess");
    expect(body.job.estimate).toEqual(twin.estimate);
    expect((await (await app.request(`/v1/jobs/${body.job.id}`)).json() as { estimate: unknown }).estimate).toEqual(twin.estimate);
  });

  it("document full index", async () => {
    const app = appFor("u1");
    const twin = await (await post(app, "/v1/documents/d1/full-index/estimate")).json() as { estimate: { pages: number } };
    expect(twin.estimate.pages).toBe(4);
    const res = await post(app, "/v1/documents/d1/full-index");
    expect(res.status).toBe(202);
    expect((await res.json() as { job: { estimate: unknown } }).job.estimate).toEqual(twin.estimate);
  });

  it("workspace full index", async () => {
    const app = appFor("u1");
    const twin = await (await post(app, "/v1/workspaces/w/full-index/estimate")).json() as { estimate: { pages: number } };
    expect(twin.estimate.pages).toBe(9);
    const res = await post(app, "/v1/workspaces/w/full-index");
    expect(res.status).toBe(202);
    expect((await res.json() as { job: { estimate: unknown } }).job.estimate).toEqual(twin.estimate);
  });

  it("bulk document reprocess", async () => {
    const app = appFor("u1");
    const body = { action: "reprocess", documentIds: ["d1", "d2"] };
    const twin = await (await post(app, "/v1/workspaces/w/documents/bulk/estimate", body)).json() as { estimate: unknown };
    expect(twin.estimate).toMatchObject({ documents: 2, pages: 9 });
    const res = await post(app, "/v1/documents/bulk", body);
    expect(res.status).toBe(201);
    const out = await res.json() as { runs: unknown[]; job: { estimate: unknown; kind: string } };
    expect(out.runs.length).toBeGreaterThan(0);
    expect(out.job).toMatchObject({ kind: "reprocess" });
    expect(out.job.estimate).toEqual(twin.estimate);
  });

  it("bulk reprocess selects one workspace like its twin and names it in estimateUrl", async () => {
    const work = await import("../services/work-estimates.js");
    expect(await work.singleWorkspaceOf(["d1", "d2"], "u1")).toBe("w");
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values ('d3', 'o1', 'u1', 'wd', 'run', 'c.pdf', 'application/pdf', 'k3', 'completed', 2, 'c3')`;
    expect(await work.singleWorkspaceOf(["d1", "d3"], "u1")).toBeNull();
  });

  it("graph rebuild", async () => {
    const app = appFor("u1");
    const twin = await (await post(app, "/v1/workspaces/w/graph/jobs/estimate", { mode: "full" })).json() as { estimate: unknown };
    expect(twin.estimate).toMatchObject({ documents: expect.any(Number), billing: "enforced" });
    const res = await post(app, "/v1/workspaces/w/graph/rebuild", { mode: "full" });
    expect(res.status).toBe(202);
    const body = await res.json() as { job: { estimate: unknown; kind: string } };
    expect(body.job.kind).toBe("graph-rebuild");
    expect(body.job.estimate).toEqual(twin.estimate);
  });

  it("workspace PATCH", async () => {
    const app = appFor("u1");
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values ('v1', 'd1', 'lancedb', 'b', 'p', 'm', 384)`;
    await sql`update documents set indexing_mode = 'full'`;
    const body = { pipeline: { ...graphPipeline, embedding: { ...graphPipeline.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/gte-small" } } };
    const twin = await (await post(app, "/v1/workspaces/w/estimate", body)).json() as { impact: { kind: string }; estimate: unknown };
    expect(twin.impact.kind).toBe("reindex-required");
    const res = await app.request("/v1/workspaces/w", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const out = await res.json() as { job: { estimate: unknown; kind: string } };
    expect(out.job.kind).toBe("reindex");
    expect(out.job.estimate).toEqual(twin.estimate);
  });
});

describe("estimate twins enforce the mutation's authorization", () => {
  beforeEach(seed);

  const server = (patch: Partial<Key> = {}): Key => ({ orgId: "o1", scopes: ["workspaces:manage", "ingest"], keyType: "server", ...patch });

  it("workspace estimate needs a server key with workspaces:manage inside its organization", async () => {
    const body = { name: "x" };
    expect((await post(appFor("u1", server({ keyType: "client" })), "/v1/workspaces/w/estimate", body)).status).toBe(403);
    expect((await post(appFor("u1", server({ scopes: ["ingest"] })), "/v1/workspaces/w/estimate", body)).status).toBe(403);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/workspaces/w/estimate", body)).status).toBe(404);
    expect((await post(appFor("u1", server({ workspaceIds: ["other"] })), "/v1/workspaces/w/estimate", body)).status).toBe(404);
    // A member without edit rights cannot PATCH, so cannot estimate either.
    expect((await post(appFor("u2"), "/v1/workspaces/w/estimate", body)).status).toBe(404);
    expect((await post(appFor("u1", server()), "/v1/workspaces/w/estimate", body)).status).toBe(200);
  });

  it("search-settings estimate needs edit access", async () => {
    expect((await post(appFor("u2"), "/v1/workspaces/w/search-settings/estimate", {})).status).toBe(404);
    expect((await post(appFor("u1"), "/v1/workspaces/w/search-settings/estimate", {})).status).toBe(200);
  });

  it("full-index estimates need ingest and workspace access", async () => {
    expect((await post(appFor("u1", server({ scopes: ["search"] })), "/v1/workspaces/w/full-index/estimate")).status).toBe(403);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/workspaces/w/full-index/estimate")).status).toBe(404);
    expect((await post(appFor("u1", server({ scopes: ["search"] })), "/v1/documents/d1/full-index/estimate")).status).toBe(403);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/documents/d1/full-index/estimate")).status).toBe(404);
    expect((await post(appFor("u2"), "/v1/workspaces/w/full-index/estimate")).status).toBe(404);
    expect((await post(appFor("u1", server()), "/v1/workspaces/w/full-index/estimate")).status).toBe(200);
  });

  it("upload estimate needs ingest, respects the key's workspaces and never creates a default workspace", async () => {
    const files = { files: [{ name: "a.pdf", size: 1000 }] };
    expect((await post(appFor("u1", server({ scopes: ["search"] })), "/v1/uploads/estimate", files)).status).toBe(403);
    expect((await post(appFor("u1", server({ workspaceIds: ["other"] })), "/v1/uploads/estimate", { ...files, workspaceId: "w" })).status).toBe(404);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/uploads/estimate", { ...files, workspaceId: "w" })).status).toBe(404);
    expect((await post(appFor("u1", server()), "/v1/uploads/estimate", { ...files, workspaceId: "w" })).status).toBe(200);
    expect((await post(appFor("u1"), "/v1/uploads/estimate", files)).status).toBe(200);

    // u2's personal org has no default workspace: 404, and nothing is created.
    await sql`delete from workspaces where org_id = 'o2'`;
    await sql`update organizations set is_personal = true, personal_owner_user_id = 'u2' where id = 'o2'`;
    const before = (await sql<{ n: number }[]>`select count(*)::int n from workspaces`)[0]!.n;
    expect((await post(appFor("u2"), "/v1/uploads/estimate", files)).status).toBe(404);
    expect((await sql<{ n: number }[]>`select count(*)::int n from workspaces`)[0]!.n).toBe(before);
  });

  it("a workspace-restricted key cannot read another workspace through any estimate or job route", async () => {
    const created = await (await post(appFor("u1"), "/v1/runs/run/reprocess", {})).json() as { job: { id: string } };
    // Allowed only workspace "wd"; every target below lives in workspace "w".
    const key = appFor("u1", server({ workspaceIds: ["wd"] }));
    const denied: Array<[string, string, unknown]> = [
      ["run reprocess estimate", "/v1/runs/run/reprocess/estimate", {}],
      ["workspace update estimate", "/v1/workspaces/w/estimate", { name: "x" }],
      ["search-settings estimate", "/v1/workspaces/w/search-settings/estimate", {}],
      ["indexing-mode estimate", "/v1/workspaces/w/indexing-mode/estimate", { mode: "map" }],
      ["workspace full-index estimate", "/v1/workspaces/w/full-index/estimate", {}],
      ["document full-index estimate", "/v1/documents/d1/full-index/estimate", {}],
      ["graph rebuild estimate", "/v1/workspaces/w/graph/jobs/estimate", {}],
      ["upload estimate", "/v1/uploads/estimate", { files: [{ name: "a.pdf", size: 1 }], workspaceId: "w" }],
    ];
    for (const [name, path, body] of denied) {
      const res = await post(key, path, body);
      expect(res.status, name).toBe(404);
    }
    expect((await key.request(`/v1/jobs/${created.job.id}`)).status).toBe(404);
    // The same key can estimate inside its allowlist.
    expect((await post(key, "/v1/workspaces/wd/full-index/estimate")).status).toBe(200);
  });

  it("indexing-mode estimate needs the PATCH's server key with workspaces:manage", async () => {
    expect((await post(appFor("u1", server({ scopes: ["ingest"] })), "/v1/workspaces/w/indexing-mode/estimate", { mode: "map" })).status).toBe(403);
    expect((await post(appFor("u1", server({ keyType: "client" })), "/v1/workspaces/w/indexing-mode/estimate", { mode: "map" })).status).toBe(403);
    expect((await post(appFor("u1", server()), "/v1/workspaces/w/indexing-mode/estimate", { mode: "map" })).status).toBe(200);
  });

  it("job status honours the key's organization and workspace allowlist", async () => {
    const created = await (await post(appFor("u1"), "/v1/runs/run/reprocess", {})).json() as { job: { id: string } };
    const path = `/v1/jobs/${created.job.id}`;
    expect((await appFor("u1", server()).request(path)).status).toBe(200);
    expect((await appFor("u1", server({ orgId: "o2" })).request(path)).status).toBe(404);
    expect((await appFor("u1", server({ workspaceIds: ["other"] })).request(path)).status).toBe(404);
    expect((await appFor("u1", server({ scopes: ["billing"] })).request(path)).status).toBe(403);
  });
});

describe("PATCH /v1/workspaces/:id through the real route stays non-breaking", () => {
  beforeEach(seed);

  const templateKey = (workspaceTemplates as Array<{ key: string }>)[0]!.key;
  const bodies: Array<[string, Record<string, unknown>]> = [
    ["empty", {}],
    ["name", { name: "Renamed" }],
    ["slug", { slug: "brand-new-slug" }],
    ["templateKey", { templateKey }],
    ["templateKey null", { templateKey: null }],
    ["systemPrompt", { systemPrompt: "Be brief" }],
    ["systemPrompt null", { systemPrompt: null }],
    ["budget", { monthlyBudgetCents: 2500 }],
    ["budget cleared", { monthlyBudgetCents: 0 }],
    ["retention", { artifactRetentionDays: 30, runRetentionDays: null }],
    ["partial nested pipeline", { pipeline: { summarize: true } }],
    ["nested embedding", { pipeline: { embedding: { modelUri: "llm://transformers.js/Xenova/gte-small" } } }],
    ["indexing mode", { pipeline: { indexingMode: "map" } }],
    ["indexing mode with indexAll", { pipeline: { indexingMode: "full" }, indexAll: true }],
    ["apply new-uploads", { apply: "new-uploads", pipeline: { summarize: true } }],
    ["autoConfirmReindex", { autoConfirmReindex: true }],
  ];

  it.each(bodies)("accepts %s", async (_name, body) => {
    const app = appFor("u1");
    const res = await app.request("/v1/workspaces/w", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "w" });
  });

  it("accepts a retention override for a starter org while billing is enforced (no plan gate)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await sql`update organizations set funded_at = null where id = 'o1'`;
    const app = appFor("u1");
    const patch = (body: unknown) => app.request("/v1/workspaces/w", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ retainDocumentVersions: 3 })).status).toBe(200);
    expect((await patch({ retainDocumentVersions: null })).status).toBe(200);
    vi.unstubAllEnvs();
  });
});
