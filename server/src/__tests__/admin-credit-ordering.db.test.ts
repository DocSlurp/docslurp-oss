import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import postgres from "postgres";
import type Stripe from "stripe";
import { createMigratedDatabase } from "../../../worker/src/test/migrated-db.js";
import { serveOnRandomPort } from "../../../worker/src/test/migrated-postgres.js";

let sql: ReturnType<typeof postgres>;
let database: Awaited<ReturnType<typeof createMigratedDatabase>>;
let server: Awaited<ReturnType<typeof serveOnRandomPort>>["server"];
let issue: typeof import("../services/billing/admin-credits.js").issueAdminCredit;
let dispatch: typeof import("../services/billing/webhooks.js").dispatchStripeEvent;
let middleware: typeof import("../lib/request-context.js").requestContextMiddleware;
const create = vi.fn();
const fakeStripe = { billing: { creditGrants: { create, retrieve: vi.fn() } } };
const actor = "admin-ordering-test";
const org = "org-ordering-test";
const request = { requestId: "d138e150-2dc7-4f37-9f99-b56a3effbf7b", orgId: org, amountCents: 10000, reason: "Ordering regression" };
const grant = (id: string, voided = false) => ({ id, object: "billing.credit_grant", customer: "cus_ordering", category: "promotional", amount: { type: "monetary", monetary: { currency: "usd", value: 10000 } }, voided_at: voided ? 12345 : null }) as unknown as Stripe.Billing.CreditGrant;
const event = (id: string, type: string, object: Stripe.Billing.CreditGrant) => ({ id, type, data: { object } }) as Stripe.Event;

beforeAll(async () => {
  database = await createMigratedDatabase();
  const serving = await serveOnRandomPort(database, { maxConnections: 4 }); server = serving.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${serving.port}/postgres`, { max: 3, prepare: false });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/billing/stripe-client.js", async () => ({ ...await vi.importActual("../services/billing/stripe-client.js"), getStripe: () => fakeStripe }));
  ({ issueAdminCredit: issue } = await import("../services/billing/admin-credits.js"));
  ({ dispatchStripeEvent: dispatch } = await import("../services/billing/webhooks.js"));
  ({ requestContextMiddleware: middleware } = await import("../lib/request-context.js"));
  await sql`insert into "user" (id, name, email) values (${actor}, 'Ordering administrator', 'ordering-admin@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, stripe_customer_id) values (${org}, 'Ordering organization', 'ordering-regression', ${actor}, 'cus_ordering')`;
}, 60000);
afterAll(async () => { await sql?.end(); await server?.stop(); await database?.close(); });

async function receipt(input: typeof request) {
  await sql`insert into admin_credit_requests(request_id, org_id, actor_user_id, amount_cents, reason, stripe_customer_id) values (${input.requestId}, ${org}, ${actor}, ${input.amountCents}, ${input.reason}, 'cus_ordering')`;
}

describe("Stripe terminal grant state across real issuer/webhook interleavings", () => {
  it("persists an early void, then rejects stale synchronous create and delayed created webhook", async () => {
    await receipt(request);
    let created!: () => void; const remoteStarted = new Promise<void>(resolve => { created = resolve; });
    let resume!: () => void; const continueIssuer = new Promise<void>(resolve => { resume = resolve; });
    create.mockImplementationOnce(async () => { created(); await continueIssuer; return grant("credgr_void_first"); });
    const issuing = issue(request, actor);
    // Attach rejection handling before deliberately pausing/resuming the issuer.
    const outcome = issuing.then(value => ({ value, error: null }), error => ({ value: null, error }));
    await remoteStarted;
    await dispatch(sql as never, fakeStripe as never, event("evt_void_first", "billing.credit_grant.updated", grant("credgr_void_first", true)));
    resume();
    expect((await outcome).error).toMatchObject({ code: "credit_reconciliation_required" });
    await dispatch(sql as never, fakeStripe as never, event("evt_delayed_create", "billing.credit_grant.created", grant("credgr_void_first")));
    const [balance] = await sql`select credit_balance_cents from organizations where id = ${org}`;
    expect(Number(balance!.credit_balance_cents)).toBe(0);
    expect(await sql`select id from credit_grants where external_id = 'credgr_void_first'`).toHaveLength(0);
    expect(await sql`select * from stripe_credit_grant_voids where stripe_grant_id = 'credgr_void_first'`).toHaveLength(1);
  });
  it("reverses a granted allocation and never resurrects it on delayed create", async () => {
    await dispatch(sql as never, fakeStripe as never, event("evt_create_second", "billing.credit_grant.created", grant("credgr_create_first")));
    await dispatch(sql as never, fakeStripe as never, event("evt_void_second", "billing.credit_grant.updated", grant("credgr_create_first", true)));
    await dispatch(sql as never, fakeStripe as never, event("evt_delayed_second", "billing.credit_grant.created", grant("credgr_create_first")));
    const [balance] = await sql`select credit_balance_cents from organizations where id = ${org}`;
    expect(Number(balance!.credit_balance_cents)).toBe(0);
  });
  it("retains durable credit correlation separately from the real HTTP request context", async () => {
    const input = { ...request, requestId: "80226020-d6a8-4a74-aaf0-d46a119c2b19" };
    await receipt(input);
    create.mockResolvedValueOnce(grant("credgr_audit_context"));
    const app = new Hono().use("*", middleware).post("/credit", async c => c.json(await issue(input, actor)));
    const response = await app.request("/credit", { method: "POST", headers: { "X-Request-ID": "http-context-regression" } });
    expect(response.status).toBe(200);
    const rows = await sql`select metadata from audit_log where metadata->>'creditRequestId' = ${input.requestId} order by created_at`;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.metadata).toMatchObject({ creditRequestId: input.requestId, requestId: "http-context-regression" });
  });
});
