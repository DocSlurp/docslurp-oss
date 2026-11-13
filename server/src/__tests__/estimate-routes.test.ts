import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, projectTemplates } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

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
let projectsRoutes: typeof import("../routes/projects.js").projectsRoutes;
let graphRoutes: typeof import("../routes/project-graph.js").projectGraphRoutes;
let uploadEstimateRoutes: typeof import("../routes/uploads.js").uploadEstimateRoutes;
let jobsRoutes: typeof import("../routes/jobs.js").jobsRoutes;

type Key = { orgId: string | null; scopes: string[]; keyType?: string; projectIds?: string[]; userId?: string; keyId?: string };

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  await pg.db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
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
  ({ projectsRoutes } = await import("../routes/projects.js"));
  ({ projectGraphRoutes: graphRoutes } = await import("../routes/project-graph.js"));
  ({ uploadEstimateRoutes } = await import("../routes/uploads.js"));
  ({ jobsRoutes } = await import("../routes/jobs.js"));
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
});

function appFor(userId: string, key?: Key, options: { session?: boolean } = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionUser", { id: userId, email: `${userId}@x`, name: userId, image: null } as never);
    if (key) c.set("apiKey", { keyId: "k1", userId, projectIds: [], ...key } as never);
    // A first-party app cookie session (the only `app` run origin).
    if (options.session) c.set("requestActor", { type: "session", userId, sessionId: `s-${userId}`, user: { id: userId, email: `${userId}@x`, name: userId } } as never);
    await next();
  });
  app.route("/v1/runs", runsRoutes);
  app.route("/v1/documents", documentsRoutes);
  app.route("/v1/projects", projectsRoutes);
  app.route("/v1/projects", graphRoutes);
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
  await sql`delete from project_runs`;
  await sql`delete from project_members`;
  await sql`delete from projects`;
  await sql`delete from org_memberships`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values ('o1', 'Org', 'org', 'u1', 100000, now()), ('o2', 'Other', 'other', 'u2', 100000, now())`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('o1', 'u1', 'owner'), ('o1', 'u2', 'member'), ('o2', 'u2', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name, slug, pipeline, is_default)
    values ('w', 'o1', 'u1', 'W', 'w-slug', ${sql.json(JSON.parse(JSON.stringify(graphPipeline)))}, false),
           ('wd', 'o1', 'u1', 'Default', 'default-slug', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))}, true)`;
  await sql`update organizations set is_personal = true, personal_owner_user_id = 'u1' where id = 'o1'`;
  await sql`insert into project_search_settings(project_id, user_id) values ('w', 'u1') on conflict do nothing`.catch(() => undefined);
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total, artifacts)
    values ('run', 'o1', 'u1', 'w', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(graphPipeline)))}, 2, 9, '{}')`;
  // Completed PDFs: the worker counted their page trees.
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, canonical_id, indexing_mode)
    values ('d1', 'o1', 'u1', 'w', 'run', 'a.pdf', 'application/pdf', 'k1', 'completed', 4, 'counted', 'c1', 'map'),
           ('d2', 'o1', 'u1', 'w', 'run', 'b.pdf', 'application/pdf', 'k2', 'completed', 5, 'counted', 'c2', 'map')`;
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

  it("project full index", async () => {
    const app = appFor("u1");
    const twin = await (await post(app, "/v1/projects/w/full-index/estimate")).json() as { estimate: { pages: number } };
    expect(twin.estimate.pages).toBe(9);
    const res = await post(app, "/v1/projects/w/full-index");
    expect(res.status).toBe(202);
    expect((await res.json() as { job: { estimate: unknown } }).job.estimate).toEqual(twin.estimate);
  });

  it("bulk document reprocess", async () => {
    const app = appFor("u1");
    const body = { action: "reprocess", documentIds: ["d1", "d2"] };
    const twin = await (await post(app, "/v1/projects/w/documents/bulk/estimate", body)).json() as { estimate: unknown };
    expect(twin.estimate).toMatchObject({ documents: 2, pages: 9 });
    const res = await post(app, "/v1/documents/bulk", body);
    expect(res.status).toBe(201);
    const out = await res.json() as { runs: unknown[]; job: { estimate: unknown; kind: string } };
    expect(out.runs.length).toBeGreaterThan(0);
    expect(out.job).toMatchObject({ kind: "reprocess" });
    expect(out.job.estimate).toEqual(twin.estimate);
  });

  it("bulk reprocess selects one project like its twin and names it in estimateUrl", async () => {
    const work = await import("../services/work-estimates.js");
    expect(await work.singleProjectOf(["d1", "d2"], "u1")).toBe("w");
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values ('d3', 'o1', 'u1', 'wd', 'run', 'c.pdf', 'application/pdf', 'k3', 'completed', 2, 'c3')`;
    expect(await work.singleProjectOf(["d1", "d3"], "u1")).toBeNull();
  });

  it("graph rebuild", async () => {
    const app = appFor("u1");
    const twin = await (await post(app, "/v1/projects/w/graph/jobs/estimate", { mode: "full" })).json() as { estimate: unknown };
    expect(twin.estimate).toMatchObject({ documents: expect.any(Number), billing: "enforced" });
    const res = await post(app, "/v1/projects/w/graph/rebuild", { mode: "full" });
    expect(res.status).toBe(202);
    const body = await res.json() as { job: { estimate: unknown; kind: string } };
    expect(body.job.kind).toBe("graph-rebuild");
    expect(body.job.estimate).toEqual(twin.estimate);
  });

  it("project PATCH", async () => {
    const app = appFor("u1");
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values ('v1', 'd1', 'lancedb', 'b', 'p', 'm', 384)`;
    await sql`update documents set indexing_mode = 'full'`;
    const body = { pipeline: { ...graphPipeline, embedding: { ...graphPipeline.embedding, target: "local" as const, modelUri: "llm://transformers.js/Xenova/gte-small" } } };
    const twin = await (await post(app, "/v1/projects/w/estimate", body)).json() as { impact: { kind: string }; estimate: unknown };
    expect(twin.impact.kind).toBe("reindex-required");
    const res = await app.request("/v1/projects/w", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const out = await res.json() as { job: { estimate: unknown; kind: string } };
    expect(out.job.kind).toBe("reindex");
    expect(out.job.estimate).toEqual(twin.estimate);
  });
});

describe("estimate twins answer the unified quote from measured documents", () => {
  beforeEach(seed);

  type Quote = { kind: string; pricingVersion: string; pages: { low: number; high: number }; ingest: { credits: { low: number; high: number } | null }; hosting: { bytes: { low: number } }; settings: { indexing: string } };

  it("each work estimate carries a quote whose ingest is the work's own estimate", async () => {
    const app = appFor("u1");
    for (const [path, body] of [
      ["/v1/runs/run/reprocess/estimate", {}],
      ["/v1/projects/w/documents/bulk/estimate", { action: "reprocess", documentIds: ["d1", "d2"] }],
      ["/v1/projects/w/full-index/estimate", {}],
    ] as const) {
      const out = await (await post(app, path, body)).json() as { estimate: { credits: { low: number; high: number } }; quote: Quote };
      expect(out.quote, path).toMatchObject({ kind: "estimate", pricingVersion: expect.any(String), pages: { low: 9, high: 9 } });
      expect(out.quote.ingest.credits).toEqual({ low: Math.round(out.estimate.credits.low * 100) / 100, high: Math.round(out.estimate.credits.high * 100) / 100 });
    }
    const one = await (await post(app, "/v1/documents/d1/full-index/estimate")).json() as { quote: Quote };
    expect(one.quote).toMatchObject({ pages: { low: 4, high: 4 }, settings: { indexing: "full" } });
  });

  it("a config change that reprocesses nothing quotes no ingest, only hosting under the new settings", async () => {
    const out = await (await post(appFor("u1"), "/v1/projects/w/estimate", { name: "Renamed" })).json() as { estimate: unknown; quote: Quote };
    expect(out.estimate).toBeNull();
    expect(out.quote.ingest.credits).toEqual({ low: 0, high: 0 });
    expect(out.quote.pages).toEqual({ low: 9, high: 9 });
  });

  it("the stored scope never reaches another organization's or project's documents", async () => {
    const { storedQuoteFiles } = await import("../services/stored-quote.js");
    await sql`insert into projects(id, org_id, user_id, name, slug, pipeline, is_default) values ('w2', 'o2', 'u2', 'Theirs', 'theirs', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))}, true)`;
    await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, pages_total, artifacts)
      values ('run2', 'o2', 'u2', 'w2', 'upload', 'completed', 'index', ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))}, 1, 50, '{}')`;
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, canonical_id)
      values ('x1', 'o2', 'u2', 'w2', 'run2', 'x.pdf', 'application/pdf', 'kx', 'completed', 50, 'counted', 'cx')`;
    // Another org's document ids, project or run under this org's scope: nothing.
    expect(await storedQuoteFiles({ orgId: "o1", documentIds: ["x1"] })).toEqual([]);
    expect(await storedQuoteFiles({ orgId: "o1", projectId: "w2" })).toEqual([]);
    expect(await storedQuoteFiles({ orgId: "o1", runId: "run2" })).toEqual([]);
    expect(await storedQuoteFiles({ orgId: "o1", documentIds: [] })).toEqual([]);
    // Mixed ids keep only this org's own.
    const own = await storedQuoteFiles({ orgId: "o1", documentIds: ["d1", "x1"] });
    expect(own.map((file) => file.pages)).toEqual([4]);
    // The bulk twin cannot quote another org's document through this project either.
    const out = await (await post(appFor("u1"), "/v1/projects/w/documents/bulk/estimate", { action: "reprocess", documentIds: ["x1"] })).json() as { quote: Quote | null };
    expect(out.quote?.pages.high ?? 0).toBe(0);
  });

  it("pages a model read are the measured mix", async () => {
    const { storedQuoteFiles } = await import("../services/stored-quote.js");
    await sql`insert into document_page_facts (document_id, page_number, vision_status) values ('d1', 1, 'extracted'), ('d1', 2, 'not-selected'), ('d2', 1, 'extracted')`;
    const [file] = await storedQuoteFiles({ orgId: "o1", projectId: "w" });
    expect(file).toMatchObject({ pages: 9, measured: { pages: 9, readPages: 2 }, type: "application/pdf" });
  });

  it("keeps measured, assumed and measured-empty documents apart (council F #3)", async () => {
    const { storedQuoteFiles } = await import("../services/stored-quote.js");
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, page_count_source, billing_pages, file_size, canonical_id)
      values ('m1', 'o1', 'u1', 'w', 'run', 'measured.docx', ${docx}, 'km1', 'completed', 1, 'assumed', 7, 40000, 'cm1'),
             ('a1', 'o1', 'u1', 'w', 'run', 'assumed.docx', ${docx}, 'ka1', 'completed', 30, 'assumed', null, 900000, 'ca1'),
             ('e1', 'o1', 'u1', 'w', 'run', 'empty.docx', ${docx}, 'ke1', 'completed', 1, 'assumed', 0, 5000, 'ce1')`;
    const files = await storedQuoteFiles({ orgId: "o1", documentIds: ["m1", "a1", "e1"] });
    const byName = (word: string) => files.find((file) => file.name.includes(word))!;
    // Measured: billing_pages, as measured pages.
    expect(byName("(measured)")).toMatchObject({ pages: 7, measured: { pages: 7, readPages: 0 }, size: 40000 });
    // Assumed: intake's 30 is never passed as pages, measured or otherwise; the quote prices the size as a range.
    const assumed = byName("pages not measured");
    expect(assumed).toEqual({ name: expect.any(String), size: 900000, type: docx });
    // Measured empty: 0 kept, not dropped and not priced as one page.
    expect(byName("no pages")).toMatchObject({ measured: { pages: 0, readPages: 0 }, size: 5000 });
    expect(byName("no pages").pages).toBeUndefined();

    const { quoteFilePageRange } = await import("@docslurp/shared");
    expect(quoteFilePageRange(byName("no pages"))).toEqual({ low: 0, central: 0, high: 0, measured: true });
    expect(quoteFilePageRange(byName("(measured)"))).toEqual({ low: 7, central: 7, high: 7, measured: true });
    expect(quoteFilePageRange(assumed).measured).toBe(false);
    // The empty document alone quotes no pages through the twin.
    const out = await (await post(appFor("u1"), "/v1/projects/w/documents/bulk/estimate", { action: "reprocess", documentIds: ["e1"] })).json() as { quote: Quote | null };
    expect(out.quote?.pages.high ?? 0).toBe(0);
  });
});

describe("estimate twins enforce the mutation's authorization", () => {
  beforeEach(seed);

  const server = (patch: Partial<Key> = {}): Key => ({ orgId: "o1", scopes: ["projects:manage", "ingest"], keyType: "server", ...patch });

  it("project estimate needs a server key with projects:manage inside its organization", async () => {
    const body = { name: "x" };
    expect((await post(appFor("u1", server({ keyType: "client" })), "/v1/projects/w/estimate", body)).status).toBe(403);
    expect((await post(appFor("u1", server({ scopes: ["ingest"] })), "/v1/projects/w/estimate", body)).status).toBe(403);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/projects/w/estimate", body)).status).toBe(404);
    expect((await post(appFor("u1", server({ projectIds: ["other"] })), "/v1/projects/w/estimate", body)).status).toBe(404);
    // A member without edit rights cannot PATCH, so cannot estimate either.
    expect((await post(appFor("u2"), "/v1/projects/w/estimate", body)).status).toBe(404);
    expect((await post(appFor("u1", server()), "/v1/projects/w/estimate", body)).status).toBe(200);
  });

  it("search-settings estimate needs edit access", async () => {
    expect((await post(appFor("u2"), "/v1/projects/w/search-settings/estimate", {})).status).toBe(404);
    expect((await post(appFor("u1"), "/v1/projects/w/search-settings/estimate", {})).status).toBe(200);
  });

  it("full-index estimates need ingest and project access", async () => {
    expect((await post(appFor("u1", server({ scopes: ["search"] })), "/v1/projects/w/full-index/estimate")).status).toBe(403);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/projects/w/full-index/estimate")).status).toBe(404);
    expect((await post(appFor("u1", server({ scopes: ["search"] })), "/v1/documents/d1/full-index/estimate")).status).toBe(403);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/documents/d1/full-index/estimate")).status).toBe(404);
    expect((await post(appFor("u2"), "/v1/projects/w/full-index/estimate")).status).toBe(404);
    expect((await post(appFor("u1", server()), "/v1/projects/w/full-index/estimate")).status).toBe(200);
  });

  it("upload estimate needs ingest, respects the key's projects and never creates a default project", async () => {
    const files = { files: [{ name: "a.pdf", size: 1000 }] };
    expect((await post(appFor("u1", server({ scopes: ["search"] })), "/v1/uploads/estimate", files)).status).toBe(403);
    expect((await post(appFor("u1", server({ projectIds: ["other"] })), "/v1/uploads/estimate", { ...files, project: "w" })).status).toBe(404);
    expect((await post(appFor("u1", server({ orgId: "o2" })), "/v1/uploads/estimate", { ...files, project: "w" })).status).toBe(404);
    expect((await post(appFor("u1", server()), "/v1/uploads/estimate", { ...files, project: "w" })).status).toBe(200);
    const defaultEstimate = await post(appFor("u1"), "/v1/uploads/estimate", files);
    expect(defaultEstimate.status).toBe(200);
    expect(await defaultEstimate.json()).toMatchObject({ media: null, orgId: expect.any(String), billingExempt: false });

    // u2's personal org has no default project: 404, and nothing is created.
    await sql`delete from projects where org_id = 'o2'`;
    await sql`update organizations set is_personal = true, personal_owner_user_id = 'u2' where id = 'o2'`;
    const before = (await sql<{ n: number }[]>`select count(*)::int n from projects`)[0]!.n;
    expect((await post(appFor("u2"), "/v1/uploads/estimate", files)).status).toBe(404);
    expect((await sql<{ n: number }[]>`select count(*)::int n from projects`)[0]!.n).toBe(before);
  });

  it("upload estimate is labelled an estimate, names its pricing version, and uses a file profile's counted pages", async () => {
    const pdf = { name: "a.pdf", size: 100_000 };
    const unknown = await (await post(appFor("u1"), "/v1/uploads/estimate", { files: [pdf] })).json() as {
      kind: string; estimate: { pages: number; pagesRange?: unknown }; profile: { quality: string; pricingVersion: string }; pricingVersion: string;
    };
    expect(unknown).toMatchObject({ kind: "estimate", pricingVersion: expect.any(String), profile: { quality: expect.any(String), pricingVersion: expect.any(String) } });
    expect(unknown.estimate.pagesRange).toBeDefined();
    const profile = { schema: 1, profiler: "test", kind: "pdf", format: "pdf", bytes: 100_000, pages: 12 };
    const profiled = await (await post(appFor("u1"), "/v1/uploads/estimate", { files: [{ ...pdf, profile }] })).json() as { estimate: { pages: number; pagesRange?: unknown } };
    expect(profiled.estimate.pages).toBe(12);
    expect(profiled.estimate.pagesRange).toBeUndefined();
    // A profile measured on another file size is dropped, never trusted.
    const mismatched = await (await post(appFor("u1"), "/v1/uploads/estimate", { files: [{ ...pdf, profile: { ...profile, bytes: 5 } }] })).json() as { estimate: { pages: number } };
    expect(mismatched.estimate.pages).toBe(unknown.estimate.pages);
    // A hostile profile (unknown fields, pricing hints) is refused outright.
    expect((await post(appFor("u1"), "/v1/uploads/estimate", { files: [{ ...pdf, profile: { ...profile, credits: 0 } }] })).status).toBe(400);
  });


  it("a project-restricted key cannot read another project through any estimate or job route", async () => {
    const created = await (await post(appFor("u1"), "/v1/runs/run/reprocess", {})).json() as { job: { id: string } };
    // Allowed only project "wd"; every target below lives in project "w".
    const key = appFor("u1", server({ projectIds: ["wd"] }));
    const denied: Array<[string, string, unknown]> = [
      ["run reprocess estimate", "/v1/runs/run/reprocess/estimate", {}],
      ["project update estimate", "/v1/projects/w/estimate", { name: "x" }],
      ["search-settings estimate", "/v1/projects/w/search-settings/estimate", {}],
      ["indexing-mode estimate", "/v1/projects/w/indexing-mode/estimate", { mode: "map" }],
      ["project full-index estimate", "/v1/projects/w/full-index/estimate", {}],
      ["document full-index estimate", "/v1/documents/d1/full-index/estimate", {}],
      ["graph rebuild estimate", "/v1/projects/w/graph/jobs/estimate", {}],
      ["upload estimate", "/v1/uploads/estimate", { files: [{ name: "a.pdf", size: 1 }], project: "w" }],
    ];
    for (const [name, path, body] of denied) {
      const res = await post(key, path, body);
      expect(res.status, name).toBe(404);
    }
    expect((await key.request(`/v1/jobs/${created.job.id}`)).status).toBe(404);
    // The same key can estimate inside its allowlist.
    expect((await post(key, "/v1/projects/wd/full-index/estimate")).status).toBe(200);
  });

  it("indexing-mode estimate needs the PATCH's server key with projects:manage", async () => {
    expect((await post(appFor("u1", server({ scopes: ["ingest"] })), "/v1/projects/w/indexing-mode/estimate", { mode: "map" })).status).toBe(403);
    expect((await post(appFor("u1", server({ keyType: "client" })), "/v1/projects/w/indexing-mode/estimate", { mode: "map" })).status).toBe(403);
    expect((await post(appFor("u1", server()), "/v1/projects/w/indexing-mode/estimate", { mode: "map" })).status).toBe(200);
  });

  it("job status honours the key's organization and project allowlist", async () => {
    const created = await (await post(appFor("u1"), "/v1/runs/run/reprocess", {})).json() as { job: { id: string } };
    const path = `/v1/jobs/${created.job.id}`;
    expect((await appFor("u1", server()).request(path)).status).toBe(200);
    expect((await appFor("u1", server({ orgId: "o2" })).request(path)).status).toBe(404);
    expect((await appFor("u1", server({ projectIds: ["other"] })).request(path)).status).toBe(404);
    expect((await appFor("u1", server({ scopes: ["billing"] })).request(path)).status).toBe(403);
  });
});

describe("PATCH /v1/projects/:id through the real route stays non-breaking", () => {
  beforeEach(seed);

  const templateKey = (projectTemplates as Array<{ key: string }>)[0]!.key;
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
    const res = await app.request("/v1/projects/w", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "w" });
  });

  it("accepts a retention override for a starter org while billing is enforced (no plan gate)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await sql`update organizations set funded_at = null where id = 'o1'`;
    const app = appFor("u1");
    const patch = (body: unknown) => app.request("/v1/projects/w", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await patch({ retainDocumentVersions: 3 })).status).toBe(200);
    expect((await patch({ retainDocumentVersions: null })).status).toBe(200);
    vi.unstubAllEnvs();
  });
});

describe("chart export tier: origin defaults, per-request override and its guards", () => {
  beforeEach(async () => {
    await seed();
    // The audit log references the key that made the change.
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type) values ('k1', 'u1', 'o1', 'hash-chart-k1', 'chart', 'server') on conflict (id) do nothing`;
  });
  afterAll(() => { vi.unstubAllEnvs(); });
  const server = (patch: Partial<Key> = {}): Key => ({ orgId: "o1", scopes: ["projects:manage", "ingest"], keyType: "server", ...patch });
  const latestRun = async () => (await sql<{ pipeline: { chartExport?: { tier?: string } }; origin: string }[]>`
    select pipeline, origin from project_runs where id <> 'run' order by created_at desc limit 1`)[0];
  const runCount = async () => Number((await sql<{ n: number }[]>`select count(*)::int as n from project_runs`)[0]!.n);

  it("stamps the resolved tier and origin on the run: app session free, API key off", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    expect((await post(appFor("u1", undefined, { session: true }), "/v1/runs/run/reprocess", {})).status).toBe(201);
    expect(await latestRun()).toMatchObject({ origin: "app", pipeline: { chartExport: { tier: "free" } } });
    expect((await post(appFor("u1", server()), "/v1/runs/run/reprocess", {})).status).toBe(201);
    expect(await latestRun()).toMatchObject({ origin: "machine", pipeline: { chartExport: { tier: "off" } } });
    // The deploy-wide machine default flips API callers to free without a code change.
    vi.stubEnv("DOCSLURP_CHART_EXPORT_API_DEFAULT", "free");
    expect((await post(appFor("u1", server()), "/v1/runs/run/reprocess", {})).status).toBe(201);
    expect(await latestRun()).toMatchObject({ origin: "machine", pipeline: { chartExport: { tier: "free" } } });
    vi.stubEnv("DOCSLURP_CHART_EXPORT_API_DEFAULT", "");
  });

  it("a request field cannot claim the app origin", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    expect((await post(appFor("u1", server()), "/v1/runs/run/reprocess", { origin: "app", runOrigin: "app" })).status).toBe(201);
    expect(await latestRun()).toMatchObject({ origin: "machine", pipeline: { chartExport: { tier: "off" } } });
  });

  it("the per-request override wins over the run's and the origin's tier", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    expect((await post(appFor("u1", server()), "/v1/runs/run/reprocess", { chartExport: { tier: "free" } })).status).toBe(201);
    expect(await latestRun()).toMatchObject({ origin: "machine", pipeline: { chartExport: { tier: "free" } } });
    expect((await post(appFor("u1", undefined, { session: true }), "/v1/runs/run/reprocess", { chartExport: { tier: "off" } })).status).toBe(201);
    expect(await latestRun()).toMatchObject({ origin: "app", pipeline: { chartExport: { tier: "off" } } });
    expect((await post(appFor("u1", server()), "/v1/runs/run/reprocess", { chartExport: { tier: "models" } })).status).toBe(201);
    expect(await latestRun()).toMatchObject({ pipeline: { chartExport: { tier: "models" } } });
  });

  it("refuses invalid values, model names, and models where the deploy switch is not on (no run created)", async () => {
    const before = await runCount();
    const key = appFor("u1", server());
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    for (const body of [{ chartExport: { tier: "turbo" } }, { chartExport: { tier: "models", generatorModel: "llm://x/y" } }, { chartExport: "models" }]) {
      expect((await post(key, "/v1/runs/run/reprocess", body)).status).toBe(400);
      expect((await post(key, "/v1/runs/run/reprocess/estimate", body)).status).toBe(400);
    }
    for (const flag of ["free", "off"]) {
      vi.stubEnv("DOCSLURP_CHART_EXPORT", flag);
      const res = await post(key, "/v1/runs/run/reprocess", { chartExport: { tier: "models" } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "chart_export_models_unavailable", message: expect.stringMatching(/not available/), details: { field: "chartExport.tier" } } });
      expect(await (await post(key, "/v1/runs/run/reprocess/estimate", { chartExport: { tier: "models" } })).json()).toMatchObject({ error: { code: "chart_export_models_unavailable" } });
      const estimate = await post(key, "/v1/runs/run/reprocess/estimate", { chartExport: { tier: "models" } });
      expect(estimate.status).toBe(400);
      // Free is always allowed (it never calls a model).
      expect((await post(key, "/v1/runs/run/reprocess/estimate", { chartExport: { tier: "free" } })).status).toBe(200);
    }
    expect(await runCount()).toBe(before);
  });

  it("models needs spend allowance like any model-calling work", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    await sql`update organizations set credit_balance_cents = 0 where id = 'o1'`;
    const before = await runCount();
    const res = await post(appFor("u1", server()), "/v1/runs/run/reprocess", { chartExport: { tier: "models" } });
    expect(res.status).toBe(402);
    expect(await runCount()).toBe(before);
  });

  it("wrong-scope keys and other organizations cannot reprocess with an override", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const before = await runCount();
    const body = { chartExport: { tier: "models" } };
    expect((await post(appFor("u1", server({ scopes: ["search:keyword"] })), "/v1/runs/run/reprocess", body)).status).toBe(403);
    expect((await post(appFor("u1", server({ keyType: "client" })), "/v1/runs/run/reprocess", body)).status).toBe(403);
    expect((await post(appFor("u2", server({ orgId: "o2", userId: "u2" })), "/v1/runs/run/reprocess", body)).status).toBe(404);
    expect((await post(appFor("u1", server({ projectIds: ["wd"] })), "/v1/runs/run/reprocess", body)).status).toBe(404);
    expect((await post(appFor("u2", server({ orgId: "o2", userId: "u2" })), "/v1/runs/run/reprocess/estimate", body)).status).toBe(404);
    expect(await runCount()).toBe(before);
  });

  it("upload estimates resolve the tier for the caller and price only models", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const files = [{ name: "a.pdf", size: 400_000, pages: 40, type: "application/pdf" }];
    type Out = { estimate: { credits: { high: number } | null }; chartExport: { tier: string; source: string; credits: { high: number } | null } };
    const api = await (await post(appFor("u1", server()), "/v1/uploads/estimate", { files, project: "w" })).json() as Out;
    expect(api.chartExport).toMatchObject({ tier: "off", source: "default", credits: { high: 0 } });
    const app = await (await post(appFor("u1", undefined, { session: true }), "/v1/uploads/estimate", { files, project: "w" })).json() as Out;
    expect(app.chartExport).toMatchObject({ tier: "free", source: "default", credits: { high: 0 } });
    expect(app.estimate.credits!.high).toBe(api.estimate.credits!.high);
    const models = await (await post(appFor("u1", server()), "/v1/uploads/estimate", { files, project: "w", chartExport: { tier: "models" } })).json() as Out;
    expect(models.chartExport).toMatchObject({ tier: "models", source: "request" });
    expect(models.chartExport.credits!.high).toBeGreaterThan(0);
    expect(models.estimate.credits!.high).toBeGreaterThan(api.estimate.credits!.high);
    // An explicit project tier wins over both origin defaults.
    for (const tier of ["off", "models"]) {
      await sql`update projects set pipeline = jsonb_set(pipeline, '{chartExport}', ${sql.json({ tier, formats: ["description", "mermaid"], diagrams: true })}) where id = 'w'`;
      for (const app of [appFor("u1", server()), appFor("u1", undefined, { session: true })]) {
        const out = await (await post(app, "/v1/uploads/estimate", { files, project: "w" })).json() as Out;
        expect(out.chartExport).toMatchObject({ tier, source: "project" });
      }
    }
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "free");
    expect((await post(appFor("u1", server()), "/v1/uploads/estimate", { files, project: "w", chartExport: { tier: "models" } })).status).toBe(400);
    expect((await post(appFor("u1", server()), "/v1/uploads/estimate", { files, project: "w", chartExport: { tier: "nope" } })).status).toBe(400);
  });
});

