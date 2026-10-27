import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import type { FeedbackAlertSender, FeedbackSummarySender } from "../services/feedback-reports.js";

/**
 * POST/GET /v1/feedback against a migrated database, behind the real
 * sessionAuth middleware: tenant scope, authentication, rate limits and the
 * high-severity paging decision.
 */
const users: Record<string, { id: string; email: string; name: string }> = {
  "sess-a": { id: "ua", email: "a@example.test", name: "A" },
  "sess-b": { id: "ub", email: "b@example.test", name: "B" },
};
vi.mock("../lib/better-auth.js", () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const user = users[headers.get("x-test-session") ?? ""];
        return { headers: new Headers(), response: user ? { session: { id: `s-${user.id}`, userId: user.id }, user: { ...user } } : null };
      },
    },
  },
  appDbPool: { query: async () => ({ rows: [] }) },
}));
vi.mock("../lib/admin-emails.js", () => ({ isConfiguredAdminUser: async () => false }));
vi.mock("../services/api-keys.js", async (original) => ({
  ...await original<typeof import("../services/api-keys.js")>(),
  validateApiKey: async () => ({ keyId: "k", userId: "ua", orgId: "oa", scopes: ["ingest", "search"], workspaceIds: null, type: "server" }),
}));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let app: Hono;
const sendAlert = vi.fn<FeedbackAlertSender>(async () => "sent");
const sendSummary = vi.fn<FeedbackSummarySender>(async () => "sent");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  const { numericType } = await import("../lib/api-pool.js");
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: numericType } });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('ua', 'A', 'a@example.test'), ('ub', 'B', 'b@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id)
    values ('oa', 'Org A', 'org-a', 'ua', true, 'ua'), ('ob', 'Org *B* <!channel>', 'org-b', 'ub', true, 'ub')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('oa', 'ua', 'owner'), ('ob', 'ub', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('00000000-0000-4000-8000-0000000000aa', 'oa', 'ua', 'A docs'), ('00000000-0000-4000-8000-0000000000bb', 'ob', 'ub', 'B secrets')`;
  const { sessionAuth } = await import("../middleware/session-auth.js");
  const { createFeedbackRoutes } = await import("../routes/feedback.js");
  app = new Hono();
  app.onError((error, c) => { console.error("[feedback test] unhandled", error); return c.text("Internal Server Error", 500); });
  app.use("/v1/*", sessionAuth);
  app.route("/v1/feedback", createFeedbackRoutes({ sql: sql as never, sendAlert, sendSummary, env: { FEEDBACK_PAGES_PER_HOUR: "5" } }));
}, 180_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(async () => {
  sendAlert.mockReset();
  sendAlert.mockResolvedValue("sent");
  sendSummary.mockReset();
  sendSummary.mockResolvedValue("sent");
  await sql`delete from feedback_reports`;
});

function post(body: Record<string, unknown>, session: string | null = "sess-a", headers: Record<string, string> = {}) {
  return app.request("/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", ...(session ? { "x-test-session": session } : {}), ...headers },
    body: JSON.stringify(body),
  });
}

const WA = "00000000-0000-4000-8000-0000000000aa";
const WB = "00000000-0000-4000-8000-0000000000bb";
const base = { category: "bug", severity: "normal", message: "The upload spinner never stops." };

describe("POST /v1/feedback", () => {
  it("refuses unauthenticated requests and API keys, storing nothing", async () => {
    expect((await post(base, null)).status).toBe(401);
    expect((await post(base, null, { authorization: "Bearer dslp_priv_test" })).status).toBe(401);
    expect((await app.request("/v1/feedback")).status).toBe(401);
    expect(await sql`select 1 from feedback_reports`).toHaveLength(0);
  });

  it("stores the report with the reporter's tenant scope and metadata", async () => {
    const response = await post({
      ...base, workspaceId: WA, route: "/app/workspaces/wa?token=secret#x", screen: "Workspace chat",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736", requestId: "req-123", errorCode: "internal",
      occurredAt: new Date().toISOString(), timezone: "Europe/Berlin",
    }, "sess-a", { "user-agent": "TestAgent/1.0" });
    expect(response.status).toBe(201);
    const body = await response.json() as { report: { reference: string }; alert: string };
    expect(body.report.reference).toMatch(/^FB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.alert).toBe("none");
    const [row] = await sql`select * from feedback_reports`;
    expect(row).toMatchObject({
      org_id: "oa", workspace_id: WA, user_id: "ua", category: "bug", severity: "normal",
      route: "/app/workspaces/wa", screen: "Workspace chat", trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      request_id: "req-123", error_code: "internal", client_timezone: "Europe/Berlin",
      user_agent: "TestAgent/1.0", alert_status: "not_applicable", reference: body.report.reference,
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("never attributes a report to another tenant's workspace or org", async () => {
    expect((await post({ ...base, workspaceId: WB })).status).toBe(201);
    expect((await post({ ...base, message: "second", orgId: "ob" })).status).toBe(201);
    const rows = await sql`select org_id, workspace_id from feedback_reports order by created_at`;
    expect(rows.map((row) => ({ ...row }))).toEqual([{ org_id: "oa", workspace_id: null }, { org_id: "oa", workspace_id: null }]);
  });

  it("lists only the caller's own reports", async () => {
    await post(base, "sess-a");
    await post({ ...base, message: "from b" }, "sess-b");
    const response = await app.request("/v1/feedback", { headers: { "x-test-session": "sess-b" } });
    const { reports } = await response.json() as { reports: Array<{ messageExcerpt: string }> };
    expect(reports.map((report) => report.messageExcerpt)).toEqual(["from b"]);
  });

  it("stores route templates, never invite tokens", async () => {
    await post({ ...base, route: "/app/invites/inv_abcdefghijklmnopqrstuvwxyz/accept?x=1" });
    await post({ ...base, message: "two", route: "/app/workspaces/3bd4b650-4442-4e00-8c84-a6ce1f2156f8" });
    const rows = await sql`select route from feedback_reports order by created_at`;
    expect(rows.map((row) => row.route)).toEqual(["/app/invites/:token/accept", "/app/workspaces/:id"]);
  });

  it("validates input and caps the message length", async () => {
    expect((await post({ ...base, category: "nonsense" })).status).toBe(400);
    expect((await post({ ...base, message: "   " })).status).toBe(400);
    expect((await post({ ...base, message: "x".repeat(4001) })).status).toBe(400);
    // Malformed optional metadata is dropped, not stored.
    expect((await post({ ...base, traceId: "<script>", requestId: "a b", errorCode: "bad code!" })).status).toBe(201);
    const [row] = await sql`select trace_id, request_id, error_code from feedback_reports`;
    expect({ ...row }).toEqual({ trace_id: null, request_id: null, error_code: null });
  });

  it("rate-limits each user per hour", async () => {
    await sql`insert into feedback_reports (id, reference, org_id, user_id, category, severity, message, message_hash)
      select 'seed-' || n, 'FB-SEED-' || n, 'oa', 'ua', 'bug', 'normal', 'm', 'h' from generate_series(1, 20) as n`;
    const response = await post(base);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await response.json() as { error: { code: string } }).error.code).toBe("rate_limited");
    expect(await sql`select 1 from feedback_reports`).toHaveLength(20);
    // Another user is unaffected.
    expect((await post(base, "sess-b")).status).toBe(201);
  });

  it("pages the team for high severity, and not for normal", async () => {
    await post(base);
    expect(sendAlert).not.toHaveBeenCalled();
    const response = await post({ ...base, severity: "high", message: "Billing charged me twice", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ alert: "sent" });
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0]![0]).toMatchObject({ orgId: "oa", orgName: "Org A", userEmail: "a@example.test", category: "bug", traceId: "4bf92f3577b34da6a3ce929d0e0e4736" });
    const [row] = await sql`select alert_status from feedback_reports where severity = 'high'`;
    expect(row!.alert_status).toBe("sent");
  });

  it("stores over-limit and duplicate high-severity reports without paging again", async () => {
    const first = await post({ ...base, severity: "high", message: "Search is down" });
    expect(await first.json()).toMatchObject({ alert: "sent" });
    const duplicate = await post({ ...base, severity: "high", message: "  search IS down " });
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ alert: "already_reported", message: expect.stringContaining("already has your high-priority report") });
    expect(sendAlert).toHaveBeenCalledTimes(1);

    await post({ ...base, severity: "high", message: "two" });
    await post({ ...base, severity: "high", message: "three" });
    expect(sendAlert).toHaveBeenCalledTimes(3);
    const capped = await post({ ...base, severity: "high", message: "four" });
    expect(await capped.json()).toMatchObject({ alert: "capped", message: "Saved to the support queue; no new live alert because several were sent this hour." });
    expect(sendAlert).toHaveBeenCalledTimes(3);
    const rows = await sql`select alert_status, alert_suppressed_reason from feedback_reports order by created_at`;
    expect(rows.map((row) => [row.alert_status, row.alert_suppressed_reason])).toEqual([
      ["sent", null], ["suppressed", "duplicate"], ["sent", null], ["sent", null], ["suppressed", "user_hourly_cap"],
    ]);
  });

  it("lets the same text page again after a failed page", async () => {
    sendAlert.mockResolvedValueOnce("failed");
    expect(await (await post({ ...base, severity: "high", message: "Uploads hang" })).json()).toMatchObject({ alert: "queued" });
    expect(await (await post({ ...base, severity: "high", message: "Uploads hang" })).json()).toMatchObject({ alert: "sent" });
    expect(sendAlert).toHaveBeenCalledTimes(2);
  });

  it("caps pages deployment-wide and sends one summary page instead of going silent", async () => {
    // Five pages in the last hour from another tenant fill the (test) cap of 5.
    await sql`insert into feedback_reports (id, reference, org_id, user_id, category, severity, message, message_hash, alert_status)
      select 'g-' || n, 'FB-GLOB-' || n, 'ob', 'ub', 'bug', 'high', 'm' || n, 'h' || n, 'sent' from generate_series(1, 5) as n`;
    const first = await post({ ...base, severity: "high", message: "Everything is down" });
    expect(await first.json()).toMatchObject({ alert: "capped" });
    const second = await post({ ...base, severity: "high", message: "Still down" }, "sess-a");
    expect(await second.json()).toMatchObject({ alert: "capped" });
    expect(sendAlert).not.toHaveBeenCalled();
    expect(sendSummary).toHaveBeenCalledTimes(1);
    expect(sendSummary.mock.calls[0]![0]).toMatchObject({ suppressedThisHour: 1, capPerHour: 5 });
    const rows = await sql`select alert_suppressed_reason, summary_paged from feedback_reports where user_id = 'ua' order by created_at`;
    expect(rows.map((row) => [row.alert_suppressed_reason, row.summary_paged])).toEqual([["global_hourly_cap", true], ["global_hourly_cap", false]]);
  });

  it("purges reports past retention and beyond the per-org cap", async () => {
    const { purgeFeedbackReports } = await import("../services/feedback-reports.js");
    await sql`insert into feedback_reports (id, reference, org_id, user_id, category, severity, message, message_hash, created_at)
      values ('old', 'FB-OLD', 'oa', 'ua', 'bug', 'normal', 'm', 'h', now() - interval '200 days'),
        ('a1', 'FB-A1', 'oa', 'ua', 'bug', 'normal', 'm', 'h', now() - interval '3 hours'),
        ('a2', 'FB-A2', 'oa', 'ua', 'bug', 'normal', 'm', 'h', now() - interval '2 hours'),
        ('a3', 'FB-A3', 'oa', 'ua', 'bug', 'normal', 'm', 'h', now() - interval '1 hour'),
        ('b1', 'FB-B1', 'ob', 'ub', 'bug', 'normal', 'm', 'h', now() - interval '3 hours')`;
    expect(await purgeFeedbackReports({ sql: sql as never, env: { FEEDBACK_MAX_REPORTS_PER_ORG: "2" } })).toEqual({ expired: 1, overCap: 1 });
    const rows = await sql`select id from feedback_reports order by id`;
    expect(rows.map((row) => row.id)).toEqual(["a2", "a3", "b1"]);
  });

  it("tells the user honestly when the live alert could not be delivered", async () => {
    sendAlert.mockResolvedValue("failed");
    const response = await post({ ...base, severity: "high" });
    expect(await response.json()).toMatchObject({ alert: "queued" });
    const [row] = await sql`select alert_status from feedback_reports`;
    expect(row!.alert_status).toBe("failed");
  });
});
