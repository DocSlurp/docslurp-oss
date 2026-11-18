import { Hono } from "hono";
import type postgres from "postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * POST /v1/projects/:id/reindex (and its estimate) with real API keys through the real sessionAuth middleware: the
 * routes accept keys (council #500 M2), a server key with projects:manage re-indexes its own organization's project, and
 * every other credential is refused with nothing queued.
 */

const sqlConnection = vi.hoisted(() => ({ current: null as ReturnType<typeof postgres> | null }));
vi.mock("../db.js", () => ({ get sql() { return sqlConnection.current; } }));
const pool = vi.hoisted(() => ({ current: null as Pool | null }));
vi.mock("../lib/auth.js", () => ({
  auth: { api: { getSession: async () => null } },
  get appDbPool() { return pool.current; },
}));
vi.mock("../middleware/rate-limit.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../middleware/rate-limit.js")>(),
  enforceAuthenticatedApiRateLimit: async () => null,
}));

let stopDb: () => Promise<void>;
let app: Hono;
let keys: typeof import("../services/api-keys.js");
const q = async (text: string, params: unknown[] = []) => ({ rows: await sqlConnection.current!.unsafe(text, params as never[]) as Array<Record<string, unknown>> });

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stopDb = pg.stop;
  sqlConnection.current = (await import("postgres")).default(pg.url, {
    max: 4, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  } as never);
  const { Pool } = await import("pg");
  pool.current = new Pool({ connectionString: pg.url, max: 4 });
  for (const user of ["owner", "other"]) {
    await q(`insert into "user"(id, name, email) values ($1, $1, $1 || '@example.test')`, [user]);
    await q(`insert into organizations(id, name, slug, created_by_user_id) values ('org-' || $1, 'Org ' || $1, 'org-' || $1, $1)`, [user]);
    await q(`insert into org_memberships(org_id, user_id, role) values ('org-' || $1, $1, 'owner')`, [user]);
    await q(`insert into projects(id, org_id, user_id, name, slug, pipeline) values ('ws-' || $1, 'org-' || $1, $1, 'W ' || $1, 'w-' || $1, '{}'::jsonb)`, [user]);
  }
  await q(`insert into projects(id, org_id, user_id, name, slug, pipeline) values ('ws-owner-2', 'org-owner', 'owner', 'Second', 'w-owner-2', '{}'::jsonb)`);
  await q(`insert into projects(id, org_id, user_id, name, slug, pipeline, is_default) values ('ws-owner-default', 'org-owner', 'owner', 'Default', 'w-owner-default', '{}'::jsonb, true)`);
  // An org admin who can mint a projects:manage key, demoted later in one case.
  await q(`insert into "user"(id, name, email) values ('admin', 'admin', 'admin@example.test')`);
  await q(`insert into org_memberships(org_id, user_id, role) values ('org-owner', 'admin', 'admin')`);

  keys = await import("../services/api-keys.js");
  const { sessionAuth } = await import("../middleware/session-auth.js");
  const { projectsRoutes } = await import("../routes/projects.js");
  const { projectRefPath } = await import("../middleware/project-ref-path.js");
  app = new Hono();
  app.use("/v1/*", sessionAuth);
  // Slug, former-slug and `default` path forms, wired as in server.ts.
  const refs = projectRefPath([projectsRoutes]);
  app.use("/v1/projects/:projectRef", refs);
  app.use("/v1/projects/:projectRef/*", refs);
  app.route("/v1/projects", projectsRoutes);
}, 180_000);

afterAll(async () => {
  await sqlConnection.current?.end();
  await pool.current?.end();
  await stopDb?.();
});

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await q("delete from api_keys");
  await q("delete from project_runs");
  await q("update projects set pipeline = '{}'::jsonb");
});

const reindexBody = { pipeline: { embedding: { profile: "fastest-local" } } };

function send(rawKey: string, project: string, options: { estimate?: boolean; origin?: string } = {}) {
  return app.request(`/v1/projects/${project}/reindex${options.estimate ? "/estimate" : ""}`, {
    method: "POST",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json", ...(options.origin ? { origin: options.origin } : {}) },
    body: JSON.stringify(reindexBody),
  });
}

async function profileOf(project: string): Promise<unknown> {
  const { rows } = await q(`select pipeline -> 'embedding' ->> 'profile' as profile from projects where id = $1`, [project]);
  return rows[0]?.profile ?? null;
}

describe("reindex with API keys", () => {
  it("a projects:manage server key estimates and re-indexes its organization's project", async () => {
    const { rawKey } = await keys.createApiKey("owner", "reindex", { orgId: "org-owner", keyType: "server", scopes: ["projects:manage"] });
    const estimate = await send(rawKey, "ws-owner", { estimate: true });
    expect(estimate.status, await estimate.clone().text()).toBe(200);
    const response = await send(rawKey, "ws-owner");
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await profileOf("ws-owner")).toBe("fastest-local");
  });

  it("an ingest-only server key gets 403 and changes nothing", async () => {
    const { rawKey } = await keys.createApiKey("owner", "ingest", { orgId: "org-owner", keyType: "server", scopes: ["ingest", "artifacts", "search:deep"] });
    for (const estimate of [true, false]) expect((await send(rawKey, "ws-owner", { estimate })).status).toBe(403);
    expect(await profileOf("ws-owner")).toBeNull();
  });

  it("a browser key is refused and changes nothing", async () => {
    const { rawKey } = await keys.createApiKey("owner", "widget", { orgId: "org-owner", keyType: "client", allowedDomains: ["docs.example.com"], projectIds: ["ws-owner"], scopes: ["search:deep", "chat"] });
    const status = (await send(rawKey, "ws-owner", { origin: "https://docs.example.com" })).status;
    expect([401, 403]).toContain(status);
    expect(await profileOf("ws-owner")).toBeNull();
  });

  it("a key bound to another project gets 404, and another organization's key gets 404", async () => {
    const narrow = await keys.createApiKey("owner", "narrow", { orgId: "org-owner", keyType: "server", scopes: ["projects:manage"], projectIds: ["ws-owner-2"] });
    const foreign = await keys.createApiKey("other", "foreign", { orgId: "org-other", keyType: "server", scopes: ["projects:manage"] });
    for (const estimate of [true, false]) {
      expect((await send(narrow.rawKey, "ws-owner", { estimate })).status).toBe(404);
      expect((await send(foreign.rawKey, "ws-owner", { estimate })).status).toBe(404);
    }
    expect(await profileOf("ws-owner")).toBeNull();
    const { rows } = await q(`select count(*)::int as n from project_runs where kind = 'reindex'`);
    expect(rows[0]!.n).toBe(0);
  });
});
