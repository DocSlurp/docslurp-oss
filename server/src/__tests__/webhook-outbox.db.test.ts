import { createHmac } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

/**
 * Webhooks belong to exactly one organization. A run's events reach that organization's webhooks whoever started the
 * run, only while the webhook's creator is still an owner or admin there, and never another organization's. Only the
 * organization's owners and admins manage them.
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
  await database.db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql, apiPool: undefined }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  await sql`insert into "user"(id, name, email) values
    ('admin', 'Admin', 'admin@example.test'), ('mate', 'Mate', 'mate@example.test'),
    ('removed', 'Removed', 'removed@example.test'), ('bob', 'Bob', 'bob@example.test'), ('dual', 'Dual', 'dual@example.test')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values
    ('team', 'Team', 'team', 'admin'), ('other', 'Other', 'other', 'bob')`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('team', 'admin', 'owner'), ('team', 'mate', 'member'), ('other', 'bob', 'owner'),
    ('team', 'dual', 'admin'), ('other', 'dual', 'admin')`;
  await sql`insert into workspaces(id, org_id, user_id, name, is_default) values
    ('ws-a', 'team', 'admin', 'A', true), ('ws-b', 'team', 'admin', 'B', false), ('ws-other', 'other', 'bob', 'O', true)`;
  await sql`insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, job_id) values
    ('run-a', 'team', 'mate', 'ws-a', 'upload', 'completed', 'completed', 'j-a'),
    ('run-b', 'team', 'admin', 'ws-b', 'upload', 'completed', 'completed', 'j-b'),
    ('run-o', 'other', 'dual', 'ws-other', 'upload', 'completed', 'completed', 'j-o')`;
  webhooks = await import("../services/webhooks.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

beforeEach(async () => {
  requests.length = 0;
  await sql`delete from webhook_outbox`;
  await sql`delete from webhooks`;
  vi.stubEnv("SECRETS_ENCRYPTION_KEY", "ab".repeat(32));
});

const hook = (id: string, userId: string, orgId: string, url: string) =>
  sql`insert into webhooks (id, user_id, org_id, url, secret, events)
    values (${id}, ${userId}, ${orgId}, ${url}, 'whsec_plain', ${sql.array(["run.completed", "document.replaced"])})`;
const event = (runId: string, workspaceId: string) => ({ runId, workspaceId });

describe("org-keyed webhooks", () => {
  it("fires for a run a teammate started, signed with the standard signature", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await outbox("ob-1", "mate", "run.completed", event("run-a", "ws-a"));
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

  it("fires for every workspace of the organization: there is no workspace scope", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await outbox("ob-a", "mate", "run.completed", event("run-a", "ws-a"));
    await outbox("ob-b", "admin", "run.completed", event("run-b", "ws-b"));
    await webhooks.drainWebhookOutbox();
    expect(requests.map((request) => JSON.parse(request.body).workspaceId).sort()).toEqual(["ws-a", "ws-b"]);
  });

  it("never delivers another organization's events, in either direction", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await hook("other-hook", "bob", "other", "https://hooks.example/other");
    await outbox("ob-team", "mate", "run.completed", event("run-a", "ws-a"));
    await outbox("ob-other", "dual", "run.completed", event("run-o", "ws-other"));
    await webhooks.drainWebhookOutbox();
    // One delivery each, to its own organization's webhook only.
    expect(urls()).toEqual(["https://hooks.example/other", "https://hooks.example/team"]);
    const byUrl = Object.fromEntries(requests.map((request) => [request.url, JSON.parse(request.body).runId]));
    expect(byUrl).toEqual({ "https://hooks.example/team": "run-a", "https://hooks.example/other": "run-o" });
  });

  it("routes by the run: a payload naming another organization's workspace is refused, whoever the row names", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await hook("other-hook", "bob", "other", "https://hooks.example/other");
    // run-o is the other org's; the payload claims team's ws-a and a team user.
    await outbox("ob-mixed", "admin", "run.completed", event("run-o", "ws-a"));
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    expect(await dispatched("ob-mixed")).toMatchObject({ last_error: "Skipped: the event's workspace does not match its run" });
  });

  it("refuses events with no run, or an unknown run, instead of guessing an organization", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await outbox("ob-none", "admin", "run.completed", { workspaceId: "ws-a" });
    await outbox("ob-unknown", "admin", "run.completed", event("run-missing", "ws-a"));
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    expect(await dispatched("ob-none")).toMatchObject({ last_error: expect.stringContaining("no run") });
    expect(await dispatched("ob-unknown")).toMatchObject({ last_error: expect.stringContaining("no longer exists") });
  });

  it("skips events from a workspace that turned webhook notifications off or did not select them", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await sql`update workspaces set pipeline = ${sql.json({ webhooks: { enabled: false, events: [] } } as never)} where id = 'ws-a'`;
    await outbox("ob-off", "admin", "document.replaced", event("run-a", "ws-a"));
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    expect(await dispatched("ob-off")).toMatchObject({ last_error: "Skipped: webhook notifications are off for this workspace" });
    await sql`update workspaces set pipeline = ${sql.json({ webhooks: { enabled: true, events: ["run.failed"] } } as never)} where id = 'ws-a'`;
    await outbox("ob-narrow", "admin", "document.replaced", event("run-a", "ws-a"));
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    await sql`update workspaces set pipeline = '{}'::jsonb where id = 'ws-a'`;
  });

  it("stops delivering once the webhook's creator is demoted to member or leaves the organization", async () => {
    await sql`insert into org_memberships(org_id, user_id, role) values ('team', 'removed', 'admin')`;
    try {
      await hook("by-removed", "removed", "team", "https://hooks.example/removed");
      await outbox("ob-1", "admin", "run.completed", event("run-a", "ws-a"));
      await webhooks.drainWebhookOutbox();
      expect(urls()).toEqual(["https://hooks.example/removed"]);
      requests.length = 0;
      await sql`update org_memberships set role = 'member' where org_id = 'team' and user_id = 'removed'`;
      await outbox("ob-2", "admin", "run.completed", event("run-a", "ws-a"));
      await webhooks.drainWebhookOutbox();
      expect(requests).toEqual([]);
      expect((await dispatched("ob-2")).last_error).toContain("still an owner or admin");
      await sql`delete from org_memberships where org_id = 'team' and user_id = 'removed'`;
      await outbox("ob-3", "admin", "run.completed", event("run-a", "ws-a"));
      await webhooks.drainWebhookOutbox();
      expect(requests).toEqual([]);
    } finally {
      await sql`delete from org_memberships where org_id = 'team' and user_id = 'removed'`;
    }
  });

  it("deliverWebhook reaches the run's organization only, and only while the creator administers it", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await hook("other-hook", "bob", "other", "https://hooks.example/other");
    await hook("member-hook", "mate", "team", "https://hooks.example/member");
    await webhooks.deliverWebhook("run-a", "run.completed");
    expect(urls()).toEqual(["https://hooks.example/team"]);
  });
});

describe("a user in two organizations", () => {
  it("never triggers one organization's webhooks with the other's runs", async () => {
    // dual administers both; its team webhook must not fire for the run it started in other.
    await hook("dual-team", "dual", "team", "https://hooks.example/dual-team");
    await outbox("ob-dual", "dual", "run.completed", event("run-o", "ws-other"));
    await webhooks.drainWebhookOutbox();
    expect(requests).toEqual([]);
    await webhooks.deliverWebhook("run-o", "run.completed");
    expect(requests).toEqual([]);
  });

  it("sees and manages only the organization it names", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await hook("other-hook", "bob", "other", "https://hooks.example/other");
    expect((await webhooks.listWebhooks({ userId: "dual", orgId: "other" })).map((hook) => hook.id)).toEqual(["other-hook"]);
    expect((await webhooks.listWebhooks({ userId: "dual", orgId: "team" })).map((hook) => hook.id)).toEqual(["team-hook"]);
    // bob is in other only: team's webhooks do not exist for him.
    await expect(webhooks.listWebhooks({ userId: "bob", orgId: "team" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    expect(await webhooks.updateWebhook({ webhookId: "team-hook", userId: "bob", active: false })).toBeNull();
    expect(await webhooks.rotateWebhookSecret("team-hook", "bob")).toBeNull();
    expect(await webhooks.sendTestWebhook("team-hook", "bob", "run.completed")).toBeNull();
    expect(await webhooks.deleteWebhook("team-hook", "bob")).toBeNull();
    expect(requests).toEqual([]);
    // Deliveries are listed per organization too.
    await webhooks.deliverWebhook("run-a", "run.completed");
    await webhooks.deliverWebhook("run-o", "run.completed");
    const teamDeliveries = await webhooks.listWebhookDeliveries({ userId: "dual", orgId: "team" });
    expect(teamDeliveries.map((delivery) => delivery.webhookId)).toEqual(["team-hook"]);
    const otherDeliveries = await webhooks.listWebhookDeliveries({ userId: "bob", orgId: "other" });
    expect(otherDeliveries.map((delivery) => delivery.webhookId)).toEqual(["other-hook"]);
    expect(await webhooks.replayWebhookDelivery(teamDeliveries[0]!.id, "bob")).toBeNull();
    await expect(webhooks.listWebhookDeliveries({ userId: "bob", orgId: "team" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
  });

  it("lets a plain member neither list nor manage the organization's webhooks", async () => {
    await hook("team-hook", "admin", "team", "https://hooks.example/team");
    await expect(webhooks.listWebhooks({ userId: "mate", orgId: "team" })).rejects.toBeInstanceOf(webhooks.WebhookForbiddenError);
    expect(await webhooks.updateWebhook({ webhookId: "team-hook", userId: "mate", active: false })).toBeNull();
    expect(await webhooks.deleteWebhook("team-hook", "mate")).toBeNull();
    // Another admin of the organization can manage it.
    expect(await webhooks.updateWebhook({ webhookId: "team-hook", userId: "dual", active: false })).toMatchObject({ active: false, orgId: "team" });
    expect(await webhooks.deleteWebhook("team-hook", "dual")).toBe("team");
  });
});

describe("creating a webhook", () => {
  const base = { url: "https://hooks.example/x", secret: "s".repeat(16) };

  it("needs an owner or admin of an organization the creator belongs to", async () => {
    await expect(webhooks.createWebhook({ ...base, userId: "mate", orgId: "other" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    await expect(webhooks.createWebhook({ ...base, userId: "mate", orgId: "team" })).rejects.toBeInstanceOf(webhooks.WebhookForbiddenError);
    await expect(webhooks.createWebhook({ ...base, userId: "admin", orgId: "missing" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    expect(await sql`select count(*)::int as count from webhooks`).toEqual([{ count: 0 }]);
    const created = await webhooks.createWebhook({ ...base, userId: "admin", orgId: "team" });
    expect(created).toMatchObject({ orgId: "team", userId: "admin" });
    expect(created).not.toHaveProperty("workspaceId");
  });

  it("refuses an organization that has been deleted", async () => {
    await sql`update organizations set deleted_at = now() where id = 'other'`;
    try {
      await expect(webhooks.createWebhook({ ...base, userId: "bob", orgId: "other" })).rejects.toBeInstanceOf(webhooks.WebhookScopeError);
    } finally {
      await sql`update organizations set deleted_at = null where id = 'other'`;
    }
  });
});
