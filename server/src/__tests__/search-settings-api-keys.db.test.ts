import { Hono } from "hono";
import type postgres from "postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * PATCH /v1/workspaces/:id/search-settings (and its estimate) with real API
 * keys: minted, validated and revoked against a migrated Postgres through the
 * real sessionAuth middleware. Only the browser session is a stand-in. A
 * server key with workspaces:manage may change its own organization's
 * workspace; every other credential is refused and nothing is written.
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
    await q(`insert into workspaces(id, org_id, user_id, name, slug, pipeline) values ('ws-' || $1, 'org-' || $1, $1, 'W ' || $1, 'w-' || $1, '{}'::jsonb)`, [user]);
  }
  await q(`insert into workspaces(id, org_id, user_id, name, slug, pipeline) values ('ws-owner-2', 'org-owner', 'owner', 'Second', 'w-owner-2', '{}'::jsonb)`);
  await q(`insert into workspaces(id, org_id, user_id, name, slug, pipeline, is_default) values ('ws-owner-default', 'org-owner', 'owner', 'Default', 'w-owner-default', '{}'::jsonb, true)`);
  // An org admin who can mint a workspaces:manage key, demoted later in one case.
  await q(`insert into "user"(id, name, email) values ('admin', 'admin', 'admin@example.test')`);
  await q(`insert into org_memberships(org_id, user_id, role) values ('org-owner', 'admin', 'admin')`);

  keys = await import("../services/api-keys.js");
  const { sessionAuth } = await import("../middleware/session-auth.js");
  const { workspacesRoutes } = await import("../routes/workspaces.js");
  const { workspaceRefPath } = await import("../middleware/workspace-ref-path.js");
  app = new Hono();
  app.use("/v1/*", sessionAuth);
  // Slug, former-slug and `default` path forms, wired as in server.ts.
  const refs = workspaceRefPath([workspacesRoutes]);
  app.use("/v1/workspaces/:workspaceRef", refs);
  app.use("/v1/workspaces/:workspaceRef/*", refs);
  app.route("/v1/workspaces", workspacesRoutes);
}, 180_000);

afterAll(async () => {
  await sqlConnection.current?.end();
  await pool.current?.end();
  await stopDb?.();
});

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test");
  await q("delete from workspace_search_settings");
  await q("delete from api_keys");
});

const body = { chat: { answerStyle: "concise", searchInstructions: "Prefer policy documents." } };

function send(rawKey: string, workspace: string, options: { estimate?: boolean; origin?: string } = {}) {
  return app.request(`/v1/workspaces/${workspace}/search-settings${options.estimate ? "/estimate" : ""}`, {
    method: options.estimate ? "POST" : "PATCH",
    headers: { authorization: `Bearer ${rawKey}`, "content-type": "application/json", ...(options.origin ? { origin: options.origin } : {}) },
    body: JSON.stringify(body),
  });
}

async function storedChat(workspace: string): Promise<unknown> {
  const { rows } = await q(`select compat_metadata -> 'workspaceUi' -> 'chat' as chat from workspace_search_settings where workspace_id = $1`, [workspace]);
  return rows[0]?.chat ?? null;
}

describe("search settings with API keys (real keys and middleware)", () => {
  it("a workspaces:manage server key updates its organization's workspace and the audit entry names the key", async () => {
    const { key, rawKey } = await keys.createApiKey("owner", "settings", { orgId: "org-owner", keyType: "server", scopes: ["workspaces:manage"] });
    const estimate = await send(rawKey, "ws-owner", { estimate: true });
    expect(estimate.status).toBe(200);
    expect(await storedChat("ws-owner")).toBeNull();
    const response = await send(rawKey, "ws-owner");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ workspaceId: "ws-owner", chat: { answerStyle: "concise" } });
    expect(await storedChat("ws-owner")).toMatchObject({ answerStyle: "concise", searchInstructions: "Prefer policy documents." });
    const { rows } = await q(`select api_key_id from audit_log where action = 'workspace.search-settings.updated' and workspace_id = 'ws-owner'`);
    expect(rows.map((row) => row.api_key_id)).toContain(key.id);
  });

  it("a search-only server key gets 403 and writes nothing", async () => {
    const { rawKey } = await keys.createApiKey("owner", "search", { orgId: "org-owner", keyType: "server", scopes: ["search", "chat", "ingest", "artifacts"] });
    expect((await send(rawKey, "ws-owner")).status).toBe(403);
    expect((await send(rawKey, "ws-owner", { estimate: true })).status).toBe(403);
    expect(await storedChat("ws-owner")).toBeNull();
  });

  it("a browser key is refused, from its own website or not, and writes nothing", async () => {
    const { rawKey } = await keys.createApiKey("owner", "widget", { orgId: "org-owner", keyType: "client", allowedDomains: ["docs.example.com"], workspaceIds: ["ws-owner"], scopes: ["search", "chat"] });
    expect(rawKey.startsWith("dslp_pub_")).toBe(true);
    expect((await send(rawKey, "ws-owner", { origin: "https://docs.example.com" })).status).toBe(403);
    expect([401, 403]).toContain((await send(rawKey, "ws-owner")).status);
    expect(await storedChat("ws-owner")).toBeNull();
  });

  it("a revoked key gets 401 and writes nothing", async () => {
    const { key, rawKey } = await keys.createApiKey("owner", "revoked", { orgId: "org-owner", keyType: "server", scopes: ["workspaces:manage"] });
    expect(await keys.revokeApiKey(key.id, "owner")).not.toBeNull();
    expect((await send(rawKey, "ws-owner")).status).toBe(401);
    expect((await send(rawKey, "ws-owner", { estimate: true })).status).toBe(401);
    expect(await storedChat("ws-owner")).toBeNull();
  });

  it("another organization's workspaces:manage key gets 404 and writes nothing", async () => {
    const { rawKey } = await keys.createApiKey("other", "foreign", { orgId: "org-other", keyType: "server", scopes: ["workspaces:manage"] });
    expect((await send(rawKey, "ws-owner")).status).toBe(404);
    expect((await send(rawKey, "ws-owner", { estimate: true })).status).toBe(404);
    expect(await storedChat("ws-owner")).toBeNull();
    // The same key still works in its own organization.
    expect((await send(rawKey, "ws-other")).status).toBe(200);
  });

  it("a key restricted to one workspace cannot change another workspace in its organization", async () => {
    const { rawKey } = await keys.createApiKey("owner", "narrow", { orgId: "org-owner", keyType: "server", scopes: ["workspaces:manage"], workspaceIds: ["ws-owner-2"] });
    expect((await send(rawKey, "ws-owner")).status).toBe(404);
    expect(await storedChat("ws-owner")).toBeNull();
    expect((await send(rawKey, "ws-owner-2")).status).toBe(200);
  });

  it("an org admin's key stops working for a workspace the admin can no longer edit after a demotion", async () => {
    const { rawKey } = await keys.createApiKey("admin", "admin key", { orgId: "org-owner", keyType: "server", scopes: ["workspaces:manage"] });
    expect((await send(rawKey, "ws-owner")).status).toBe(200);
    await q("delete from workspace_search_settings");
    await q(`update org_memberships set role = 'member' where org_id = 'org-owner' and user_id = 'admin'`);
    try {
      // The key still carries the scope; the owner's workspace role decides (404: no edit access, nothing revealed).
      expect((await send(rawKey, "ws-owner")).status).toBe(404);
      expect(await storedChat("ws-owner")).toBeNull();
    } finally {
      await q(`update org_memberships set role = 'admin' where org_id = 'org-owner' and user_id = 'admin'`);
    }
  });

  it("resolves slug and `default` path forms, and `default` never stands in for an allowlisted workspace", async () => {
    const { rawKey } = await keys.createApiKey("owner", "slug", { orgId: "org-owner", keyType: "server", scopes: ["workspaces:manage"] });
    expect((await send(rawKey, "w-owner")).status).toBe(200);
    expect(await storedChat("ws-owner")).toMatchObject({ answerStyle: "concise" });
    expect((await send(rawKey, "default")).status).toBe(200);
    expect(await storedChat("ws-owner-default")).toMatchObject({ answerStyle: "concise" });
    // Another org's slug is not found for this key.
    expect((await send(rawKey, "w-other")).status).toBe(404);
    expect(await storedChat("ws-other")).toBeNull();

    await q("delete from workspace_search_settings");
    const narrow = await keys.createApiKey("owner", "narrow default", { orgId: "org-owner", keyType: "server", scopes: ["workspaces:manage"], workspaceIds: ["ws-owner-2"] });
    expect((await send(narrow.rawKey, "default")).status).toBe(404);
    expect((await send(narrow.rawKey, "default", { estimate: true })).status).toBe(404);
    expect(await storedChat("ws-owner-2")).toBeNull();
    expect(await storedChat("ws-owner-default")).toBeNull();
  });

  it("an unknown bearer token never falls back to a session", async () => {
    expect((await send("dslp_priv_not_a_real_key", "ws-owner")).status).toBe(401);
    expect(await storedChat("ws-owner")).toBeNull();
  });
});
