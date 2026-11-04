import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Webhooks belong to an organization (and optionally one of its workspaces). A
 * run's events reach them whoever started the run, only while the webhook's
 * creator can still read the workspace, and never another organization's.
 */
const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
vi.mock("../lib/network-security.js", () => ({
  assertSafeExternalUrl: vi.fn(async (url: string) => url),
  safeExternalFetch: vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("ok", { status: 200 });
  }),
}));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let webhooks: typeof import("../services/webhooks.js");

const dispatched = async (id: string) => (await sql<{ dispatched_at: string | null; last_error: string | null }[]>`
  select dispatched_at::text, last_error from webhook_outbox where id = ${id}`)[0]!;
const outbox = (id: string, userId: string, eventType: string, payload: Record<string, unknown>) =>
  sql`insert into webhook_outbox (id, user_id, event_type, payload) values (${id}, ${userId}, ${eventType}, ${sql.json(payload as never)})`;
const urls = () => requests.map((request) => request.url).sort();

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql, apiPool: undefined }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  await sql`insert into "user"(id, name, email) values
    ('admin', 'Admin', 'admin@example.test'), ('mate', 'Mate', 'mate@example.test'),
    ('removed', 'Removed', 'removed@example.test'), ('bob', 'Bob', 'bob@example.test')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values
    ('team', 'Team', 'team', 'admin'), ('other', 'Other', 'other', 'bob')`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('team', 'admin', 'owner'), ('team', 'mate', 'member'), ('other', 'bob', 'owner')`;
  await sql`insert into workspaces(id, org_id, user_id, name, is_default) values
    ('ws-a', 'team', 'admin', 'A', true), ('ws-b', 'team', 'admin', 'B', false), ('ws-other', 'other', 'bob', 'O', true)`;
  webhooks = await import("../services/webhooks.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

beforeEach(async () => {
  requests.length = 0;
  await sql`delete from webhook_outbox`;
  await sql`delete from webhooks`;
});

const hook = (id: string, userId: string, orgId: string, workspaceId: string | null, url: string) =>
  sql`insert into webhooks (id, user_id, org_id, workspace_id, url, secret, events)
    values (${id}, ${userId}, ${orgId}, ${workspaceId}, ${url}, 'whsec_plain', ${sql.array(["run.completed", "document.replaced"])})`;

describe("org-keyed webhooks", () => {
  it("fires for a run a teammate started, signed with the standard signature", async () => {
    await hook("team-hook", "admin", "team", null, "https://hooks.example/team");
    await outbox("ob-1", "mate", "run.completed", { workspaceId: "ws-a", runId: "r1" });
    expect(await webhooks.drainWebhookOutbox()).toBe(1);
    expect(urls()).toEqual(["https://hooks.example/team"]);
    const [request] = requests;
    const timestamp = request!.headers["X-DocSlurp-Timestamp"];
    const deliveryId = request!.headers["X-DocSlurp-Delivery"];
    const expected = createHmac("sha256", "whsec_plain").update(`${timestamp}.${deliveryId}.${request!.body}`).digest("hex");
    expect(request!.headers["X-DocSlurp-Signature"]).toBe(`t=${timestamp},id=${deliveryId},v1=${expected}`);
    expect(await dispatched("ob-1")).toMatchObject({ last_error: null });
    expect(await webhooks.drainWebhookOutbox()).toBe(0);
  });

  it("never delivers another organization's events, in either direction", async () => {
    await hook("team-hook", "admin", "team", null, "https://hooks.example/team");
    await hook("other-hook", "bob", "other", null, "https://hooks.example/other");
    await outbox("ob-team", "mate", "run.completed", { workspaceId: "ws-a" });
    await outbox("ob-other", "bob", "run.completed", { workspaceId: "ws-other" });
    await webhooks.drainWebhookOutbox();
    // One delivery each, to its own organization's webhook only.
    expect(urls()).toEqual(["https://hooks.example/other", "https://hooks.example/team"]);
    const byUrl = Object.fromEntries(requests.map((request) => [request.url, JSON.parse(request.body).workspaceId]));
    expect(byUrl).toEqual({ "https://hooks.example/team": "ws-a", "https://hooks.example/other": "ws-other" });
  });

  it("does not let an outbox row claim a user in one org and a workspace in another", async () => {
    // The starter's id says "bob" (other org); the workspace says team. The workspace decides.
    await hook("other-hook", "bob", "other", null, "https://hooks.example/other");
    await outbox("ob-mixed", "bob", "run.completed", { workspaceId: "ws-a" });
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    expect(await dispatched("ob-mixed")).toMatchObject({ last_error: null });
  });

  it("narrows a workspace-scoped webhook to that workspace", async () => {
    await hook("only-b", "admin", "team", "ws-b", "https://hooks.example/b");
    await outbox("ob-a", "mate", "run.completed", { workspaceId: "ws-a" });
    await outbox("ob-b", "mate", "run.completed", { workspaceId: "ws-b" });
    await webhooks.drainWebhookOutbox();
    expect(urls()).toEqual(["https://hooks.example/b"]);
    expect(JSON.parse(requests[0]!.body).workspaceId).toBe("ws-b");
  });

  it("stops delivering a workspace's events once the webhook's creator lost access to it (G-06)", async () => {
    await sql`insert into org_memberships(org_id, user_id, role) values ('team', 'removed', 'member')`;
    await hook("removed-a", "removed", "team", "ws-a", "https://hooks.example/removed");
    await hook("removed-b", "removed", "team", "ws-b", "https://hooks.example/removed-private");
    // The default workspace is readable to every member; ws-b is not.
    await outbox("ob-default", "admin", "run.completed", { workspaceId: "ws-a" });
    await outbox("ob-private", "admin", "run.completed", { workspaceId: "ws-b" });
    await webhooks.drainWebhookOutbox();
    expect(urls()).toEqual(["https://hooks.example/removed"]);
    expect(await dispatched("ob-private")).toMatchObject({ last_error: "Skipped: subscriber no longer has access to this workspace" });
    requests.length = 0;
    await sql`delete from org_memberships where org_id = 'team' and user_id = 'removed'`;
    await outbox("ob-after-leaving", "admin", "run.completed", { workspaceId: "ws-a" });
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
  });

  it("refuses events with no workspace instead of guessing an organization", async () => {
    await hook("team-hook", "admin", "team", null, "https://hooks.example/team");
    await outbox("ob-none", "admin", "run.completed", { runId: "r" });
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    expect(await dispatched("ob-none")).toMatchObject({ last_error: expect.stringContaining("no workspace") });
  });

  it("skips events from a workspace that turned webhook notifications off or did not select them", async () => {
    await hook("team-hook", "admin", "team", null, "https://hooks.example/team");
    await sql`update workspaces set pipeline = ${sql.json({ webhooks: { enabled: false, events: [] } } as never)} where id = 'ws-a'`;
    await outbox("ob-off", "admin", "document.replaced", { workspaceId: "ws-a" });
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    expect(await dispatched("ob-off")).toMatchObject({ last_error: "Skipped: webhook notifications are off for this workspace" });
    await sql`update workspaces set pipeline = ${sql.json({ webhooks: { enabled: true, events: ["run.failed"] } } as never)} where id = 'ws-a'`;
    await outbox("ob-narrow", "admin", "document.replaced", { workspaceId: "ws-a" });
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    await sql`update workspaces set pipeline = '{}'::jsonb where id = 'ws-a'`;
  });
});

describe("creating a webhook", () => {
  it("only for an organization the creator belongs to, and a workspace they can read there", async () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "ab".repeat(32));
    const base = { userId: "mate", url: "https://hooks.example/x", secret: "s".repeat(16) };
    await expect(webhooks.createWebhook({ ...base, orgId: "other" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    // Any member may watch a workspace they can read; the whole organization's events are for owners and admins.
    await expect(webhooks.createWebhook({ ...base, orgId: "team" })).rejects.toBeInstanceOf(webhooks.WebhookForbiddenError);
    await expect(webhooks.createWebhook({ ...base, orgId: "team", workspaceId: "ws-b" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    await expect(webhooks.createWebhook({ ...base, orgId: "team", workspaceId: "ws-other" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    const created = await webhooks.createWebhook({ ...base, orgId: "team", workspaceId: "ws-a" });
    expect(created).toMatchObject({ orgId: "team", workspaceId: "ws-a", userId: "mate" });
    expect(await sql`select count(*)::int as count from webhooks`).toEqual([{ count: 1 }]);
    vi.unstubAllEnvs();
  });

  it("lets an owner or admin register an organization-wide webhook", async () => {
    vi.stubEnv("SECRETS_ENCRYPTION_KEY", "ab".repeat(32));
    const base = { url: "https://hooks.example/x", secret: "s".repeat(16), orgId: "team" };
    expect(await webhooks.createWebhook({ ...base, userId: "admin" })).toMatchObject({ orgId: "team", workspaceId: null, userId: "admin" });
    await sql`insert into org_memberships(org_id, user_id, role) values ('team', 'removed', 'admin') on conflict (org_id, user_id) do update set role = 'admin'`;
    try {
      expect(await webhooks.createWebhook({ ...base, userId: "removed" })).toMatchObject({ workspaceId: null });
    } finally {
      await sql`delete from org_memberships where org_id = 'team' and user_id = 'removed'`;
      vi.unstubAllEnvs();
    }
  });

  it("deliverWebhook reaches org webhooks for a run its creator did not start, but not other organizations'", async () => {
    await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, job_id) values ('run-x', 'team', 'mate', 'ws-a', 'upload', 'completed', 'completed', 'j')`;
    await hook("team-hook", "admin", "team", null, "https://hooks.example/team");
    await hook("other-hook", "bob", "other", null, "https://hooks.example/other");
    await webhooks.deliverWebhook("run-x", "run.completed");
    expect(urls()).toEqual(["https://hooks.example/team"]);
  });
});


describe("organization-wide webhooks need an owner or admin creator", () => {
  it("stops an organization-wide webhook once its creator is demoted to member, but keeps a workspace-scoped one", async () => {
    await sql`insert into org_memberships(org_id, user_id, role) values ('team', 'removed', 'admin') on conflict (org_id, user_id) do update set role = 'admin'`;
    await hook("org-wide", "removed", "team", null, "https://hooks.example/org");
    await hook("scoped", "removed", "team", "ws-a", "https://hooks.example/scoped");
    await outbox("ob-1", "admin", "run.completed", { workspaceId: "ws-a" });
    await webhooks.drainWebhookOutbox();
    expect(urls()).toEqual(["https://hooks.example/org", "https://hooks.example/scoped"]);
    requests.length = 0;
    await sql`update org_memberships set role = 'member' where org_id = 'team' and user_id = 'removed'`;
    await outbox("ob-2", "admin", "run.completed", { workspaceId: "ws-a" });
    await webhooks.drainWebhookOutbox();
    expect(urls()).toEqual(["https://hooks.example/scoped"]);
    await sql`delete from org_memberships where org_id = 'team' and user_id = 'removed'`;
  });

  it("does not deliver a run's event to an organization-wide webhook whose creator is only a member (deliverWebhook)", async () => {
    await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, job_id) values ('run-m', 'team', 'mate', 'ws-a', 'upload', 'completed', 'completed', 'j2')`;
    await hook("member-org-wide", "mate", "team", null, "https://hooks.example/member");
    await webhooks.deliverWebhook("run-m", "run.completed");
    expect(requests).toEqual([]);
  });
});
