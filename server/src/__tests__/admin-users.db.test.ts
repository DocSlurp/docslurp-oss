import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import postgres from "postgres";
import { createMigratedDatabase, serveOnRandomPort } from "@docslurp/worker/testing";

let sql: ReturnType<typeof postgres>;
let pool: Pool;
let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let app: Hono;
let recorder: InstanceType<typeof import("../services/client-surface.js").ClientSurfaceRecorder>;
let accountKinds: typeof import("../services/account-kind.js");
let recordSignupAttribution: typeof import("../services/signup-attribution.js").recordSignupAttribution;

beforeAll(async () => {
  database = await createMigratedDatabase();
  const serving = await serveOnRandomPort(database, { maxConnections: 6 }); server = serving.server;
  const url = `postgres://postgres@127.0.0.1:${serving.port}/postgres`;
  sql = postgres(url, { max: 3, prepare: false });
  pool = new Pool({ connectionString: url, max: 1 });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/request-actor.js", () => ({ getRequestActor: (c: { get: (key: string) => unknown }) => c.get("requestActor") }));
  const { adminUsersRoutes } = await import("../routes/admin-users.js");
  const { ClientSurfaceRecorder } = await import("../services/client-surface.js");
  ({ recordSignupAttribution } = await import("../services/signup-attribution.js"));
  accountKinds = await import("../services/account-kind.js");
  recorder = new ClientSurfaceRecorder(() => sql as never, 60_000);
  app = new Hono();
  app.use("*", async (c, next) => { c.set("requestActor", { type: "session", userId: "admin", user: { isAdmin: true } } as never); await next(); });
  app.route("/admin/users", adminUsersRoutes);

  await sql`insert into "user" (id, name, email, "emailVerified") values
    ('u-active', 'Active Builder', 'active@acme.dev', true),
    ('u-idle', 'Idle Visitor', 'idle@initech.io', false),
    ('u-gone', 'Gone User', 'gone@globex.com', true)`;
  await sql`update "user" set deleted_at = now() where id = 'u-gone'`;
  await sql`insert into account (id, "accountId", "providerId", "userId") values
    ('a1', 'gh-1', 'github', 'u-active'), ('a2', 'u-active', 'credential', 'u-active'), ('a3', 'g-2', 'google', 'u-idle')`;
  await sql`insert into workspaces (id, user_id, name) values ('w1', 'u-active', 'Contracts')`;
  await sql`insert into documents (id, user_id, workspace_id, filename, mime_type, source_key, status, page_count) values
    ('d1', 'u-active', 'w1', 'a.pdf', 'application/pdf', 'k1', 'completed', 12),
    ('d2', 'u-active', 'w1', 'b.pdf', 'application/pdf', 'k2', 'completed', 3)`;
  await sql`insert into search_sessions (id, user_id, query) values ('s1', 'u-active', 'termination clause')`;
  await sql`insert into api_keys (id, user_id, key_hash, name, key_type) values
    ('k1', 'u-active', 'hash-1', 'server', 'server'), ('k2', 'u-active', 'hash-2', 'widget', 'client')`;
  await sql`insert into api_keys (id, user_id, key_hash, name, key_type, revoked_at) values ('k3', 'u-idle', 'hash-3', 'old', 'server', now())`;
}, 120_000);

afterAll(async () => { await pool?.end(); await sql?.end(); await server?.stop(); await database?.close(); });

describe("admin user directory against migrated Postgres", () => {
  it("stores attribution once and flushes coalesced surfaces", async () => {
    const consent = "docslurp_analytics=granted; ";
    expect(await recordSignupAttribution(pool, "u-active", `ds_attr=${encodeURIComponent(JSON.stringify({ us: "no-consent" }))}`)).toBe(false);
    const cookie = `${consent}ds_attr=${encodeURIComponent(JSON.stringify({ r: "https://news.example/thread?x=1", us: "newsletter", l: "/pricing" }))}`;
    expect(await recordSignupAttribution(pool, "u-active", cookie)).toBe(true);
    expect(await recordSignupAttribution(pool, "u-active", `${consent}ds_attr=${encodeURIComponent(JSON.stringify({ us: "overwrite" }))}`)).toBe(false);
    recorder.record("u-active", "sdk", "sdk"); recorder.record("u-active", "sdk", null); recorder.record("u-active", "mcp", null);
    recorder.record("no-such-user", "api", null);
    await recorder.flush();
    recorder.record("u-active", "sdk", null);
    await recorder.flush();
    const rows = await sql`select user_id, surface, request_count::int as n, last_client from user_client_surfaces order by surface`;
    expect(rows.map(row => ({ ...row }))).toEqual([
      { user_id: "u-active", surface: "mcp", n: 1, last_client: null },
      { user_id: "u-active", surface: "sdk", n: 3, last_client: "sdk" },
    ]);
  });

  it("lists live users with per-user signals and hides tombstoned ones", async () => {
    const body = await (await app.request("/admin/users?sort=documents")).json();
    expect(body.total).toBe(2);
    const [active, idle] = body.users;
    expect(active).toMatchObject({
      id: "u-active", email_verified: true, providers: ["credential", "github"], workspaces: 1, documents: 2, pages: 15,
      searches: 1, api_keys: 1, browser_keys: 1, spend_cents: 0,
      attribution: { referrer_host: "news.example", referrer_url: "https://news.example/thread", utm_source: "newsletter", landing_path: "/pricing" },
    });
    expect(active.surfaces.map((s: { surface: string }) => s.surface).sort()).toEqual(["mcp", "sdk"]);
    expect(active.avatar_url).toMatch(/^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}\?s=64&d=404$/);
    expect(active).not.toHaveProperty("image");
    expect(idle).toMatchObject({ id: "u-idle", email_verified: false, providers: ["google"], documents: 0, api_keys: 0, attribution: null, surfaces: [] });
    expect(JSON.stringify(body)).not.toMatch(/hash-|password|accessToken/i);
  });

  it("filters by provider, activation, surface, search text and tombstone", async () => {
    const ids = async (query: string) => (await (await app.request(`/admin/users?${query}`)).json()).users.map((u: { id: string }) => u.id);
    expect(await ids("filter=github")).toEqual(["u-active"]);
    expect(await ids("filter=google")).toEqual(["u-idle"]);
    expect(await ids("filter=unverified")).toEqual(["u-idle"]);
    expect(await ids("filter=never_uploaded")).toEqual(["u-idle"]);
    expect(await ids("filter=api_key")).toEqual(["u-active"]);
    expect(await ids("surface=mcp")).toEqual(["u-active"]);
    expect(await ids("q=idle@")).toEqual(["u-idle"]);
    expect(await ids("q=%25")).toEqual([]);
    expect(await ids("filter=deleted")).toEqual(["u-gone"]);
    expect(await ids("sort=searches&limit=1")).toEqual(["u-active"]);
    expect(await ids("sort=oldest&limit=1&offset=1")).toHaveLength(1);
    const past = await (await app.request("/admin/users?offset=50")).json();
    expect(past).toMatchObject({ total: 2, users: [] });
  });

  it("marks fake, agent-created and staff accounts and keeps manual choices", async () => {
    await sql`insert into "user" (id, name, email, "emailVerified") values
      ('u-agent', 'Pressure Test 1', 'pressure-1@docslurp.invalid', true), ('u-staff', 'Staff Person', 'dan@docslurp.io', true)`;
    const kinds = async () => Object.fromEntries((await sql`select id, account_kind as k, account_kind_source as s from "user"`).map(r => [r.id, `${r.k}/${r.s}`]));
    // The insert trigger catches reserved domains even for raw SQL inserts.
    expect(await kinds()).toMatchObject({ "u-active": "customer/default", "u-agent": "test/rule", "u-staff": "customer/default" });
    vi.stubEnv("STAFF_EMAIL_DOMAINS", "docslurp.io");
    vi.stubEnv("TEST_ACCOUNT_EMAIL_PATTERNS", "idle@*");
    expect(await accountKinds.applyAccountKindRules(pool)).toBe(2);
    expect(await kinds()).toMatchObject({ "u-staff": "staff/rule", "u-idle": "test/rule", "u-active": "customer/default", "u-gone": "customer/default" });
    // An admin override survives the rules; clearing it hands the account back.
    await sql`insert into "user" (id, name, email, "emailVerified") values ('admin', 'Seed Admin', 'admin@docslurp.local', true)`;
    const set = await app.request("/admin/users/u-idle/kind", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "customer", reason: "real prospect" }) });
    expect(await set.json()).toEqual({ account_kind: "customer", account_kind_source: "admin", account_kind_reason: "real prospect" });
    expect(await accountKinds.applyAccountKindRules(pool)).toBe(0);
    expect((await sql`select action, metadata from audit_log where resource_id = 'u-idle'`)[0]).toMatchObject({ action: "admin.account_kind.set", metadata: { kind: "customer", reason: "real prospect" } });
    await app.request("/admin/users/u-idle/kind", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: null }) });
    expect((await kinds())["u-idle"]).toBe("test/rule");
    vi.stubEnv("TEST_ACCOUNT_EMAIL_PATTERNS", "");
    expect((await (await app.request("/admin/users/reclassify", { method: "POST" })).json()).changed).toBe(1);
    expect((await kinds())["u-idle"]).toBe("customer/default");
    expect((await app.request("/admin/users/nobody/kind", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "test" }) })).status).toBe(404);
    const ids = async (query: string) => (await (await app.request(`/admin/users?${query}`)).json()).users.map((u: { id: string }) => u.id).sort();
    expect(await ids("kind=test")).toEqual(["admin", "u-agent"]);
    expect(await ids("kind=staff")).toEqual(["u-staff"]);
    vi.unstubAllEnvs();
  });

  it("summarizes signups, funnel, surfaces and sources", async () => {
    const all = await (await app.request("/admin/users/summary?days=7&audience=all")).json();
    expect(all).toMatchObject({ audience: "all", kinds: { customer: 2, staff: 1, test: 2 }, totals: { users: 5 } });
    const body = await (await app.request("/admin/users/summary?days=7")).json();
    expect(body.audience).toBe("customers");
    expect(body.totals).toMatchObject({ users: 2, verified: 1, google: 1, github: 1, password: 1, uploaded: 1, searched: 1, api_key: 1, programmatic: 1 });
    expect(body.signupsByDay).toHaveLength(7);
    expect(body.signupsByDay.at(-1)).toMatchObject({ signups: 2, verified: 1 });
    expect(body.surfaces).toEqual(expect.arrayContaining([expect.objectContaining({ surface: "sdk", users: 1, requests: 3 })]));
    expect(body.referrers).toEqual(expect.arrayContaining([{ source: "newsletter", users: 1 }, { source: "(direct)", users: 1 }]));
  });
});
