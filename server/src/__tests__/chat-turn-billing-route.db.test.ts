import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * /v1/chat settles the chat turn's bill: a delivered answer (partial ones
 * included) and a turn the client abandoned are charged, a server-side error
 * or timeout is refunded, and error bodies carry the turn's usage.
 */
const { chatWorkspace } = vi.hoisted(() => ({ chatWorkspace: vi.fn() }));
vi.mock("../services/workspace-chat.js", async (original) => ({
  ...await original<typeof import("../services/workspace-chat.js")>(),
  chatWorkspace,
  workspaceChatDisabledBody: async () => null,
}));
vi.mock("../lib/request-actor.js", async (original) => ({
  ...await original<typeof import("../lib/request-actor.js")>(),
  assertApiKeyWorkspaceAccess: async () => null,
  getRequestActor: () => ({ type: "session", userId: "u1" }),
  resolveActorWorkspaceId: async () => "w1",
}));

let stop: () => Promise<void>;
let sql: postgres.Sql;
let routes: typeof import("../routes/search.js");
let usage: typeof import("../lib/ai-usage.js");
let credits: typeof import("../services/billing/credits.js");
let billing: typeof import("../services/billing/chat-turn-billing.js");
let publicErrors: typeof import("../lib/public-errors.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.test')`;
  routes = await import("../routes/search.js");
  usage = await import("../lib/ai-usage.js");
  credits = await import("../services/billing/credits.js");
  billing = await import("../services/billing/chat-turn-billing.js");
  publicErrors = await import("../lib/public-errors.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  chatWorkspace.mockReset();
  await sql`delete from credit_debits_pending`;
  await sql`delete from credit_ledger`;
  await sql`delete from credit_grants`;
  await sql`delete from usage_events`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 1000)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W')`;
});

/** A chat turn that billed its answer (and flushed it), then answered or failed. */
function turnThat(outcome: (turnId: string) => unknown) {
  chatWorkspace.mockImplementation(async () => {
    const turnId = billing.currentChatTurnHandle()!.id;
    await usage.recordUnitCharge({
      userId: "u1",
      scope: { orgId: "o1", workspaceId: "w1", sessionId: "s1" },
      charge: { id: `chat-answer:${turnId}`, metric: "chat-answer", amount: 1, unit: "answer", credits: 12, metadata: { providerCostCents: 10 } },
    });
    await credits.flushPendingCreditDebits();
    return outcome(billing.currentChatTurnHandle()!.id);
  });
}

function post(init: RequestInit = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("requestId", "req-1"); await next(); });
  app.use("*", publicErrors.publicErrorMiddleware);
  app.use("*", async (c, next) => { c.set("sessionUser", { id: "u1", email: "", name: "" }); await next(); });
  app.onError((_error, c) => c.json({ error: "internal" }, 500));
  app.route("/v1/chat", routes.workspaceChatRoutes);
  return app.request("/v1/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: "What changed?" }), ...init,
  });
}

const available = async () => (await credits.getAvailableCredits("o1")).available;

describe("/v1/chat chat turn billing", () => {
  it("charges a delivered partial answer", async () => {
    turnThat((id) => ({ id, sessionId: "s1", answer: "Partial answer from the evidence so far.", finishReason: "length", usage: {} }));
    const response = await post();
    expect(response.status).toBe(200);
    expect(await available()).toBeLessThan(1000);
    expect(await sql`select 1 from credit_grants`).toHaveLength(0);
  });

  it("refunds a turn that ends in an HTTP error and reports its usage", async () => {
    turnThat(() => { throw new Error("provider exploded"); });
    const response = await post();
    expect(response.status).toBe(500);
    const body = await response.json() as { error: { code: string; details?: { usage?: Record<string, unknown> } } };
    expect(body.error.code).toBe("internal");
    expect(body.error.details?.usage).toMatchObject({ outcome: "failed", refunded: true, providerCostCents: 10, chargedCreditCents: 0 });
    expect(Number(body.error.details?.usage?.refundedCreditCents)).toBeGreaterThan(0);
    expect(await available()).toBeCloseTo(1000, 6);
    expect(await sql`select 1 from credit_grants where source = 'refund'`).toHaveLength(1);
  });

  it("charges a turn whose client disconnected after the answer was generated", async () => {
    const abort = new AbortController();
    turnThat((id) => {
      abort.abort();
      return { id, sessionId: "s1", answer: "Generated, then the client left.", finishReason: "stop", usage: {} };
    });
    await Promise.resolve(post({ signal: abort.signal })).catch(() => undefined);
    await credits.flushPendingCreditDebits();
    expect(await available()).toBeLessThan(1000);
    expect(await sql`select 1 from credit_grants`).toHaveLength(0);
  });

  it("charges a turn the client aborted mid-generation", async () => {
    const abort = new AbortController();
    turnThat(() => {
      abort.abort();
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const response = await Promise.resolve(post({ signal: abort.signal })).catch(() => undefined);
    if (response) {
      const body = await response.json() as { error: { details?: { usage?: Record<string, unknown> } } };
      expect(body.error.details?.usage).toMatchObject({ outcome: "failed", refunded: false, refundedCreditCents: 0 });
    }
    await credits.flushPendingCreditDebits();
    expect(await available()).toBeLessThan(1000);
    expect(await sql`select 1 from credit_grants`).toHaveLength(0);
  });

  it("refunds a server-side timeout", async () => {
    turnThat(() => { throw new DOMException("The operation timed out", "TimeoutError"); });
    const response = await post();
    expect(response.status).toBeGreaterThanOrEqual(500);
    const body = await response.json() as { error: { details?: { usage?: Record<string, unknown> } } };
    expect(body.error.details?.usage).toMatchObject({ outcome: "failed", refunded: true, chargedCreditCents: 0 });
    expect(await available()).toBeCloseTo(1000, 6);
  });
  it("refunds a turn that hit the agent deadline (424 chat_deadline_exceeded)", async () => {
    const { ChatTurnDeadlineError } = await import("../services/chat-turn-deadline.js");
    turnThat(() => { throw new ChatTurnDeadlineError(100_000); });
    const response = await post();
    expect(response.status).toBe(424);
    const body = await response.json() as { error: { code?: string; details?: { usage?: Record<string, unknown> } } };
    expect(body.error.details?.usage).toMatchObject({ outcome: "failed", refunded: true, chargedCreditCents: 0 });
    expect(await available()).toBeCloseTo(1000, 6);
  });
});
