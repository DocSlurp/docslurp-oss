import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, INDEX_IDENTITY_SETTINGS, normalizePipelineFeatures } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Index-identity settings lock once a project has indexed documents (owner, 2026-11-18). Against a migrated database
 * with real API keys:
 * - a plain PATCH changing the embedding is 409 `reindex_required`, names the locked settings and the re-index work,
 *   and saves nothing (not even the other fields in the same body); `autoConfirmReindex` does not unlock it;
 * - the same PATCH on a project without documents applies; a non-identity PATCH is unaffected;
 * - `POST /reindex` (or PATCH `apply: "reindex"`) applies the change and queues the re-index; a plain rebuild works;
 *   a stale `confirmEstimate` is refused;
 * - another organization's project (session or key), a key without `projects:manage`, a browser key and a viewer are
 *   refused on the new routes, and nothing is queued.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");
let app: Hono;
const SECRET = "cd".repeat(32);
const embedding = (profile: "fastest-local" | "cheapest-local") =>
  normalizePipelineFeatures({ ...defaultPipelineFeatures, embedding: { profile } } as never).embedding;

beforeAll(async () => {
  vi.stubEnv("FILE_TOKEN_SECRET", SECRET);
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", async (load) => ({
    ...(await load<typeof import("../lib/temporal.js")>()),
    startPipelineWorkflow: vi.fn(async () => undefined), signalPipelineCancel: vi.fn(), signalPipelinePause: vi.fn(),
    signalPipelineResume: vi.fn(), isTemporalClientConnected: () => true, onTemporalClientConnected: vi.fn(), warmTemporalClient: vi.fn(),
  }));
  vi.doMock("../services/run-lifecycle.js", () => ({ runLifecycle: {
    start: vi.fn(async () => ({ status: "started" })), control: vi.fn(async (run: { id: string }) => run.id), signalResume: vi.fn(async () => undefined),
  } }));
  await sql`insert into "user"(id, name, email) values
    ('ua', 'Admin', 'reindex-admin@example.com'), ('uv', 'Viewer', 'reindex-viewer@example.com'), ('ub', 'Other', 'reindex-other@example.com')`;

  keys = await import("../services/api-keys.js");
  const { projectsRoutes } = await import("../routes/projects.js");
  const { syntheticApiKeySessionUser } = await import("../lib/request-actor.js");
  const context = await import("../lib/request-context.js");
  app = new Hono();
  app.use("*", context.requestContextMiddleware);
  app.use("*", async (c, next) => {
    const auth = c.req.header("authorization");
    if (auth?.startsWith("Bearer ")) {
      const key = await keys.validateApiKey(auth.slice(7), { origin: c.req.header("origin") ?? null });
      if (!key) return c.json({ error: "invalid key" }, 401);
      c.set("apiKey", key);
      c.set("sessionUser", syntheticApiKeySessionUser(key));
      context.setCurrentRequestUserId(key.userId);
      context.setCurrentRequestApiKeyId(key.keyId);
    } else {
      const user = c.req.header("x-test-user") ?? "nobody";
      c.set("sessionUser", { id: user, email: `${user}@example.com`, name: user } as never);
      c.set("requestActor", { type: "session", userId: user, sessionId: `session-${user}`, user: { id: user } } as never);
      context.setCurrentRequestUserId(user);
      context.setCurrentRequestSessionId(`session-${user}`);
    }
    await next();
  });
  app.route("/v1/projects", projectsRoutes);
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  vi.stubEnv("FILE_TOKEN_SECRET", SECRET);
  vi.stubEnv("WORKER_CREDIT_LEASES", "off");
  await sql`delete from documents`;
  await sql`delete from project_runs`;
  await sql`delete from api_keys`;
  await sql`delete from audit_log`;
  await sql`delete from project_members`;
  await sql`delete from project_search_settings`;
  await sql`delete from projects`;
  await sql`delete from org_memberships`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at) values
    ('org-a', 'A', 'a', 'ua', 100000, now()), ('org-b', 'B', 'b', 'ub', 100000, now())`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('org-a', 'ua', 'admin'), ('org-a', 'uv', 'member'), ('org-b', 'ub', 'owner')`;
  // Slugs equal the ids: a key names a project by reference, and these test ids are not UUIDs.
  await sql`insert into projects(id, org_id, user_id, name, slug, pipeline) values
    ('proj-a', 'org-a', 'ua', 'A', 'proj-a', ${sql.json(defaultPipelineFeatures as never)}),
    ('proj-empty', 'org-a', 'ua', 'Empty', 'proj-empty', ${sql.json(defaultPipelineFeatures as never)}),
    ('proj-b', 'org-b', 'ub', 'B', 'proj-b', ${sql.json(defaultPipelineFeatures as never)})`;
  await sql`insert into project_members (project_id, user_id, role) values ('proj-a', 'uv', 'viewer')`;
  for (const [project, org, user] of [["proj-a", "org-a", "ua"], ["proj-b", "org-b", "ub"]] as const) {
    await sql`insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents, artifacts)
      values (100, ${`src-${project}`}, ${org}, ${user}, ${project}, 'upload', 'completed', 'index', ${sql.json(defaultPipelineFeatures as never)}, 2,
        ${sql.json({ [`${project}-d0:markdown`]: "s3://b/d0.md", [`${project}-d1:markdown`]: "s3://b/d1.md" })})`;
    for (const i of [0, 1]) {
      await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
        values (${`${project}-d${i}`}, ${org}, ${user}, ${project}, ${`src-${project}`}, ${`f${i}.pdf`}, 'application/pdf', ${`k${i}`}, 'completed', 5, ${`c-${project}-${i}`})`;
      await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
        values (${`v-${project}-${i}`}, ${`${project}-d${i}`}, 'lancedb', 'b', 'p', 'm', 384)`;
    }
  }
});

const asUser = (user: string) => ({ "x-test-user": user, "content-type": "application/json" });
const asKey = (raw: string) => ({ authorization: `Bearer ${raw}`, "content-type": "application/json" });
const send = (method: string, path: string, headers: Record<string, string>, body: unknown) =>
  app.request(path, { method, headers, body: JSON.stringify(body) });
const stored = async (id: string) => {
  const [row] = await sql<{ name: string; pipeline: { embedding: { profile: string } } }[]>`select name, pipeline from projects where id = ${id}`;
  return row!;
};
const reindexRuns = async (project: string) => (await sql`select id from project_runs where project_id = ${project} and kind = 'reindex'`).length;
const embeddingPatch = { pipeline: { ...defaultPipelineFeatures, embedding: embedding("fastest-local") } };

describe("locked index-identity settings", () => {
  it("names every indexConfigOf input", () => {
    expect([...INDEX_IDENTITY_SETTINGS]).toEqual(["embedding", "chunkOverlap", "contextualChunkPreambles", "vectorBackends"]);
  });

  it("refuses a plain PATCH changing the embedding of a project with documents: 409, named settings and estimate, nothing saved", async () => {
    const before = await stored("proj-a");
    const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { ...embeddingPatch, name: "Renamed" });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string; details: { reindex: Record<string, unknown> } } };
    expect(body.error.code).toBe("reindex_required");
    expect(body.error.message).toContain("embedding");
    expect(body.error.details.reindex).toMatchObject({
      lockedSettings: ["embedding"], documents: 2, pages: 10, reindexUrl: "/v1/projects/proj-a/reindex",
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    // Atomic: the unrelated rename in the same body is not applied either.
    expect(await stored("proj-a")).toEqual(before);
    expect(await reindexRuns("proj-a")).toBe(0);
  });

  it("autoConfirmReindex and apply new-uploads never unlock an identity change", async () => {
    await sql`update projects set auto_confirm_reindex = true where id = 'proj-a'`;
    for (const body of [embeddingPatch, { ...embeddingPatch, autoConfirmReindex: true }, { ...embeddingPatch, apply: "new-uploads" }]) {
      const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), body);
      expect(response.status).toBe(409);
      expect((await response.json() as { error: { code: string } }).error.code).toBe("reindex_required");
    }
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
  });

  it("applies the same PATCH on a project without documents", async () => {
    const response = await send("PATCH", "/v1/projects/proj-empty", asUser("ua"), embeddingPatch);
    expect(response.status).toBe(200);
    expect((await stored("proj-empty")).pipeline.embedding.profile).toBe("fastest-local");
    expect(await reindexRuns("proj-empty")).toBe(0);
  });

  it("leaves non-identity PATCHes alone", async () => {
    const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { name: "Renamed", pipeline: { ...defaultPipelineFeatures, summarize: true }, apply: "new-uploads" });
    expect(response.status).toBe(200);
    expect((await stored("proj-a")).name).toBe("Renamed");
    expect(await reindexRuns("proj-a")).toBe(0);
  });

  it("PATCH apply reindex is the explicit confirmation: saves and queues the re-index", async () => {
    const estimate = await send("POST", "/v1/projects/proj-a/estimate", asUser("ua"), embeddingPatch);
    const priced = await estimate.json() as { lockedSettings: string[]; signature: string };
    expect(priced.lockedSettings).toEqual(["embedding"]);
    const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { ...embeddingPatch, apply: "reindex", confirmEstimate: priced.signature });
    expect(response.status).toBe(200);
    expect((await response.json() as { job?: { runIds: string[] } }).job?.runIds.length).toBeGreaterThan(0);
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe("fastest-local");
    expect(await reindexRuns("proj-a")).toBeGreaterThan(0);
  });
});

describe("POST /v1/projects/:id/reindex", () => {
  it("estimates, then applies the index change and queues the re-index in one step", async () => {
    const body = { pipeline: { embedding: { profile: "fastest-local" } } };
    const estimate = await send("POST", "/v1/projects/proj-a/reindex/estimate", asUser("ua"), body);
    expect(estimate.status).toBe(200);
    const priced = await estimate.json() as { lockedSettings: string[]; signature: string; estimate: { documents: number } };
    expect(priced.lockedSettings).toEqual(["embedding"]);
    expect(priced.estimate.documents).toBe(2);
    // The estimate changed nothing.
    expect(await reindexRuns("proj-a")).toBe(0);
    // The refusal's signature and the estimate's agree, so a client can confirm either.
    const refusal = await (await send("PATCH", "/v1/projects/proj-a", asUser("ua"), embeddingPatch)).json() as { error: { details: { reindex: { signature: string } } } };
    expect(refusal.error.details.reindex.signature).toBe(priced.signature);

    const response = await send("POST", "/v1/projects/proj-a/reindex", asUser("ua"), { ...body, confirmEstimate: priced.signature });
    expect(response.status).toBe(200);
    const result = await response.json() as { runIds: string[]; changedSettings: string[]; job: { kind: string } | null; project: { id: string } };
    expect(result.changedSettings).toEqual(["embedding"]);
    expect(result.runIds.length).toBeGreaterThan(0);
    expect(result.job?.kind).toBe("reindex");
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe("fastest-local");
    const queued = await sql`select count(*)::int as n from documents where run_id = any(${result.runIds})`;
    expect(queued[0]!.n).toBe(2);
  });

  it("rebuilds the index with no settings change", async () => {
    const response = await send("POST", "/v1/projects/proj-a/reindex", asUser("ua"), {});
    expect(response.status).toBe(200);
    const result = await response.json() as { runIds: string[]; changedSettings: string[] };
    expect(result.changedSettings).toEqual([]);
    expect(result.runIds.length).toBeGreaterThan(0);
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
  });

  it("refuses a stale estimate and saves nothing", async () => {
    const body = { pipeline: { embedding: { profile: "fastest-local" } } };
    const priced = await (await send("POST", "/v1/projects/proj-a/reindex/estimate", asUser("ua"), body)).json() as { signature: string };
    // A document lands after the estimate: the work (and its price) changed.
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values ('proj-a-d2', 'org-a', 'ua', 'proj-a', 'src-proj-a', 'f2.pdf', 'application/pdf', 'k2', 'completed', 7, 'c-proj-a-2')`;
    const response = await send("POST", "/v1/projects/proj-a/reindex", asUser("ua"), { ...body, confirmEstimate: priced.signature });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("estimate_stale");
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
    expect(await reindexRuns("proj-a")).toBe(0);
  });

  it("takes only index settings", async () => {
    const response = await send("POST", "/v1/projects/proj-a/reindex", asUser("ua"), { pipeline: { summarize: true } });
    expect(response.status).toBe(400);
    expect(await reindexRuns("proj-a")).toBe(0);
  });

  it("refuses another organization's project, wrong-scope and browser keys, and viewers; nothing is queued", async () => {
    const body = { pipeline: { embedding: { profile: "fastest-local" } } };
    const { rawKey: foreign } = await keys.createApiKey("ub", `foreign-${randomUUID()}`, { orgId: "org-b", scopes: ["projects:manage", "ingest"] });
    const { rawKey: noManage } = await keys.createApiKey("ua", `no-manage-${randomUUID()}`, { orgId: "org-a", scopes: ["ingest", "artifacts"] });
    // A viewer cannot hold a projects:manage key at all (organization admins only); a key bound to another project can.
    await expect(keys.createApiKey("uv", `viewer-${randomUUID()}`, { orgId: "org-a", scopes: ["projects:manage"] })).rejects.toThrow();
    const { rawKey: otherProjectKey } = await keys.createApiKey("ua", `bound-${randomUUID()}`, { orgId: "org-a", scopes: ["projects:manage"], projectIds: ["proj-empty"] });
    const { rawKey: browserKey } = await keys.createApiKey("ua", `browser-${randomUUID()}`, { orgId: "org-a", keyType: "client", scopes: ["search:keyword"], allowedDomains: ["example.com"], projectIds: ["proj-a"] });
    for (const path of ["/v1/projects/proj-a/reindex", "/v1/projects/proj-a/reindex/estimate"]) {
      expect((await send("POST", path, asUser("ub"), body)).status).toBe(404);
      expect((await send("POST", path, asKey(foreign), body)).status).toBe(404);
      expect((await send("POST", path, asKey(noManage), body)).status).toBe(403);
      expect((await send("POST", path, { ...asKey(browserKey), origin: "https://example.com" }, body)).status).toBe(403);
      expect((await send("POST", path, asUser("uv"), body)).status).toBe(403);
      expect((await send("POST", path, asKey(otherProjectKey), body)).status).toBe(404);
    }
    // And org A's session cannot reach org B's project.
    expect((await send("POST", "/v1/projects/proj-b/reindex", asUser("ua"), body)).status).toBe(404);
    expect(await reindexRuns("proj-a")).toBe(0);
    expect(await reindexRuns("proj-b")).toBe(0);
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
    expect((await stored("proj-b")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
  });

  it("a server key with projects:manage whose user may edit can re-index", async () => {
    const { rawKey } = await keys.createApiKey("ua", `manage-${randomUUID()}`, { orgId: "org-a", scopes: ["projects:manage"] });
    const response = await send("POST", "/v1/projects/proj-a/reindex", asKey(rawKey), { pipeline: { embedding: { profile: "fastest-local" } } });
    expect(response.status).toBe(200);
    expect(await reindexRuns("proj-a")).toBeGreaterThan(0);
  });
});

describe("council fixes", () => {
  const version = async (action: string, pipeline: unknown) => {
    const id = randomUUID();
    await sql`insert into audit_log (id, org_id, user_id, project_id, action, resource_type, resource_id, metadata)
      values (${id}, 'org-a', 'ua', 'proj-a', ${action}, 'project', 'proj-a',
        ${sql.json({ snapshot: { name: "A", templateKey: null, systemPrompt: null, pipeline } } as never)})`;
    return id;
  };
  const fastest = { ...defaultPipelineFeatures, embedding: embedding("fastest-local") };

  it("a version rollback that changes the embedding is locked like a PATCH, and confirmed queues the re-index", async () => {
    const id = await version("project.updated", fastest);
    const refused = await send("POST", `/v1/projects/proj-a/versions/${id}/rollback`, asUser("ua"), {});
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: { code: string } }).error.code).toBe("reindex_required");
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
    expect(await reindexRuns("proj-a")).toBe(0);
    const confirmed = await send("POST", `/v1/projects/proj-a/versions/${id}/rollback`, asUser("ua"), { apply: "reindex" });
    expect(confirmed.status).toBe(200);
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe("fastest-local");
    expect(await reindexRuns("proj-a")).toBeGreaterThan(0);
  });

  it("only version audit rows can be rolled back to", async () => {
    const id = await version("project.search-settings.updated", { ...defaultPipelineFeatures, summarize: true });
    const response = await send("POST", `/v1/projects/proj-a/versions/${id}/rollback`, asUser("ua"), {});
    expect(response.status).toBe(400);
    expect((await stored("proj-a")).pipeline).not.toMatchObject({ summarize: true });
  });

  it("locks while documents are still in flight, and for archived documents", async () => {
    await sql`delete from vector_indexes where document_id like 'proj-a-%'`;
    await sql`update documents set status = 'processing' where project_id = 'proj-a'`;
    expect((await send("PATCH", "/v1/projects/proj-a", asUser("ua"), embeddingPatch)).status).toBe(409);
    await sql`update documents set status = 'completed', archived_at = now() where project_id = 'proj-a'`;
    expect((await send("PATCH", "/v1/projects/proj-a", asUser("ua"), embeddingPatch)).status).toBe(409);
    // An upload run still queued, before any document row exists.
    await sql`delete from documents where project_id = 'proj-a'`;
    await sql`update project_runs set status = 'queued' where id = 'src-proj-a'`;
    expect((await send("PATCH", "/v1/projects/proj-a", asUser("ua"), embeddingPatch)).status).toBe(409);
    expect((await stored("proj-a")).pipeline.embedding.profile).toBe(defaultPipelineFeatures.embedding.profile);
  });

  it("a change that leaves the index hash alone is neither locked nor re-indexed", async () => {
    const two = { ...defaultPipelineFeatures, vectorBackends: ["lancedb", "orama"] };
    await sql`update projects set pipeline = ${sql.json(two as never)} where id = 'proj-a'`;
    const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { pipeline: { ...two, vectorBackends: ["orama", "lancedb"] } });
    expect(response.status).toBe(200);
    expect(await reindexRuns("proj-a")).toBe(0);
  });

  it("closes the embedding-off two-step: the change is locked while embedding is off, and re-enabling over other vectors is locked", async () => {
    const off = { ...defaultPipelineFeatures, embed: false, indexVectors: false };
    await sql`update projects set pipeline = ${sql.json(off as never)} where id = 'proj-a'`;
    const step1 = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { pipeline: { ...off, embedding: embedding("fastest-local") } });
    expect(step1.status).toBe(409);
    // Vectors stamped with another index config, embedding switched off: turning it back on is locked.
    await sql`update documents set index_config_hash = 'another-config' where project_id = 'proj-a'`;
    const step2 = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { pipeline: { ...off, embed: true, indexVectors: true } });
    expect(step2.status).toBe(409);
    const body = await step2.json() as { error: { details: { reindex: { lockedSettings: string[] } } } };
    expect(body.error.details.reindex.lockedSettings).toEqual(["embed", "indexVectors"]);
    const confirmed = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { pipeline: { ...off, embed: true, indexVectors: true }, apply: "reindex" });
    expect(confirmed.status).toBe(200);
    expect(await reindexRuns("proj-a")).toBeGreaterThan(0);
  });

  it("refuses confirmEstimate without apply reindex", async () => {
    const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { ...embeddingPatch, confirmEstimate: "a".repeat(64) });
    expect(response.status).toBe(400);
  });

  it("answers a privacy-violating embedding with 400 privacy_mode_violation", async () => {
    const local = { ...defaultPipelineFeatures, privacyMode: "local-only", embedding: embedding("fastest-local") };
    await sql`update projects set pipeline = ${sql.json(local as never)} where id = 'proj-empty'`;
    const response = await send("POST", "/v1/projects/proj-empty/reindex", asUser("ua"), { pipeline: { embedding: { profile: "cheapest-hosted" } } });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("privacy_mode_violation");
  });

  it("says when the command had nothing to re-index", async () => {
    const unchanged = await (await send("POST", "/v1/projects/proj-empty/reindex", asUser("ua"), {})).json() as { outcome: string; runIds: string[] };
    expect(unchanged).toMatchObject({ outcome: "unchanged", runIds: [] });
    const saved = await (await send("POST", "/v1/projects/proj-empty/reindex", asUser("ua"), { pipeline: { embedding: { profile: "fastest-local" } } })).json() as { outcome: string };
    expect(saved.outcome).toBe("saved");
    const queued = await (await send("POST", "/v1/projects/proj-a/reindex", asUser("ua"), {})).json() as { outcome: string };
    expect(queued.outcome).toBe("queued");
  });
});

describe("re-check fixes", () => {
  it("refuses upload overrides that change a populated project's index settings, before storing anything", async () => {
    const intake = await import("../services/project-intake.js");
    const { getProject } = await import("../services/projects.js");
    const project = (await getProject("proj-a", "ua"))!;
    const stored: string[] = [];
    const ports = {
      storage: { async put(key: string) { stored.push(key); }, async remove() {} },
      records: { ...intake.postgresIntakeRecords, async findProject() { return project; } },
    } as unknown as import("../services/project-intake.js").ProjectIntakePorts;
    const request = (pipeline: Record<string, unknown>) => ({
      userId: "ua", orgId: "org-a", project: "proj-a", kind: "bulk-upload" as const, pipeline: pipeline as never,
      items: [{ filename: "a.txt", mimeType: "text/plain", content: { bytes: Buffer.from("hello") } }, { filename: "b.txt", mimeType: "text/plain", content: { bytes: Buffer.from("again") } }],
    });
    for (const pipeline of [{ embedding: { profile: "fastest-local" } }, { chunkOverlap: true }, { vectorBackends: ["lancedb", "orama"] }]) {
      await expect(intake.intakeIntoProject(request(pipeline), ports)).rejects.toMatchObject({ statusCode: 409, code: "reindex_required" });
    }
    expect(stored).toEqual([]);
    expect((await sql`select count(*)::int as n from project_runs where project_id = 'proj-a'`)[0]!.n).toBe(1);
    // An override that leaves the index alone passes the check, and so does any override on a project without documents.
    await expect(intake.assertUploadKeepsIndexIdentity(project, { summarize: true } as never)).resolves.toBeUndefined();
    const empty = (await getProject("proj-empty", "ua"))!;
    await expect(intake.assertUploadKeepsIndexIdentity(empty, { embedding: { profile: "fastest-local" } } as never)).resolves.toBeUndefined();
    // The direct-upload session check uses the same Postgres records.
    await expect(intake.assertUploadKeepsIndexIdentity(project, { embedding: { profile: "fastest-local" } } as never)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses a managed-model change that moves a populated project's index identity", async () => {
    const managed = await import("../services/managed-models.js");
    // Allowed while the project is empty (a local profile, so a local model override fits it).
    await sql`update projects set pipeline = ${sql.json({ ...defaultPipelineFeatures, embedding: embedding("cheapest-local") } as never)} where id = 'proj-empty'`;
    await managed.setProjectManagedModels("proj-empty", { pipeline: { embedding: { modelUri: "llm://transformers.js/Xenova/gte-small" } } }, { userId: "ua" });
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id)
      values ('proj-empty-d0', 'org-a', 'ua', 'proj-empty', 'src-proj-a', 'f.pdf', 'application/pdf', 'k', 'completed', 1, 'c-empty')`;
    // Dropping the override set would change the embedding model under the stored vectors.
    await expect(managed.setProjectManagedModels("proj-empty", { pipeline: null }, { userId: "ua" })).rejects.toThrow(/re-index/);
    // A change that leaves the index alone is still allowed.
    await expect(managed.setProjectManagedModels("proj-empty", { chat: {} }, { userId: "ua" })).resolves.not.toBeNull();
  });

  it("counts legacy vectorized documents with no index stamp when vectors are switched back on", async () => {
    const off = { ...defaultPipelineFeatures, embed: false, indexVectors: false };
    await sql`update projects set pipeline = ${sql.json(off as never)} where id = 'proj-a'`;
    await sql`update documents set index_config_hash = null where project_id = 'proj-a'`;
    const response = await send("PATCH", "/v1/projects/proj-a", asUser("ua"), { pipeline: { ...off, embed: true, indexVectors: true } });
    expect(response.status).toBe(409);
  });
});
