import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Chat turn billing against a migrated Postgres: a turn whose answer is not
 * delivered costs no credits (pending debits cancelled, flushed ones granted
 * back once), a delivered turn is charged, and provider cost stays recorded.
 * PGlite serves one session, so "concurrent" cases interleave statements
 * rather than contend for row locks; the lock order they rely on is the one
 * apply_pending_org_debits uses.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql;
let usage: typeof import("../lib/ai-usage.js");
let billing: typeof import("../services/billing/chat-turn-billing.js");
let credits: typeof import("../services/billing/credits.js");
let context: typeof import("../lib/chat-turn-context.js");

const FREE = "o-free";
const PAID = "o-paid";
const workspaceOf = (orgId: string) => `w-${orgId}`;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.test')`;
  usage = await import("../lib/ai-usage.js");
  billing = await import("../services/billing/chat-turn-billing.js");
  credits = await import("../services/billing/credits.js");
  context = await import("../lib/chat-turn-context.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  await sql`delete from credit_debits_pending`;
  await sql`delete from credit_ledger`;
  await sql`delete from credit_grants`;
  await sql`delete from usage_events`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  // A starter org and a funded org (one prepaid balance each).
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents)
    values (${FREE}, 'Free', 'free', 'u1', 1000)`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents, funded_at)
    values (${PAID}, 'Paid', 'paid', 'u1', 5000, now())`;
  for (const orgId of [FREE, PAID]) {
    await sql`insert into workspaces(id, org_id, user_id, name) values (${workspaceOf(orgId)}, ${orgId}, 'u1', 'W')`;
  }
});

/**
 * One billable charge in the turn (a chat answer unit, 12 credits) that cost
 * us 10 cents at the provider. Provider AI events themselves bill 0 credits.
 */
function step(orgId: string, client?: typeof sql) {
  return usage.recordUnitCharge({
    userId: "u1",
    scope: { orgId, workspaceId: workspaceOf(orgId), sessionId: "chat-session" },
    charge: { id: randomUUID(), metric: "chat-answer", amount: 1, unit: "answer", credits: 12, metadata: { providerCostCents: 10 } },
    ...(client ? { client } : {}),
  });
}

async function available(orgId: string) {
  return (await credits.getAvailableCredits(orgId)).available;
}

async function pools(orgId: string) {
  const [row] = await sql<{ prepaid: string; funded: boolean }[]>`
    select credit_balance_cents::text as prepaid, funded_at is not null as funded from organizations where id = ${orgId}`;
  return { prepaid: Number(row!.prepaid), funded: row!.funded };
}

async function turnEvents(turnId: string) {
  return (await sql<{ cost_cents: string; metadata: Record<string, unknown> }[]>`
    select cost_cents::text, metadata from usage_attribution where metadata ->> 'chatTurnId' = ${turnId} order by created_at`)
    .map((row) => ({ costCents: Number(row.cost_cents), metadata: row.metadata }));
}

async function turnEventIds(turnId: string) {
  return (await sql<{ id: string }[]>`select id from usage_events where metadata ->> 'chatTurnId' = ${turnId}`).map((row) => row.id);
}

async function refundGrants() {
  return await sql<{ external_id: string; credits: string; source: string; org_id: string }[]>`
    select external_id, credits::text, source, org_id from credit_grants where source = 'refund' order by created_at`;
}

describe.each([
  { account: "starter", orgId: FREE },
  { account: "funded", orgId: PAID },
])("chat turn billing for a $account org", ({ orgId }) => {
  it("charges a delivered turn", async () => {
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); await step(orgId); });
    const delivered = turn.delivered();
    await credits.flushPendingCreditDebits();

    expect(delivered).toMatchObject({ outcome: "delivered", refunded: false, refundedCreditCents: 0, providerCostCents: 20 });
    expect(delivered.creditCents).toBeGreaterThan(0);
    expect(delivered.chargedCreditCents).toBe(delivered.creditCents);
    expect(await available(orgId)).toBeCloseTo(before - delivered.creditCents, 6);
    const events = await turnEvents(turn.id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.costCents > 0 && event.metadata.chatTurnId === turn.id)).toBe(true);
    expect(await refundGrants()).toEqual([]);
  });

  it("charges a partial-answer turn, because the partial answer was delivered", async () => {
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    // Deadline reached after a tool step: the agent answers from what it has and the route sends it.
    await turn.run(async () => { await step(orgId); });
    const usage = turn.delivered();
    // A late failure signal (e.g. a nested tool timing out afterwards) does not undo delivery.
    const after = await turn.failed("timeout");
    await credits.flushPendingCreditDebits();
    expect(after).toMatchObject({ outcome: "delivered", refunded: false });
    expect(await available(orgId)).toBeCloseTo(before - usage.creditCents, 6);
  });

  it("cancels a failed turn's pending debits without a grant", async () => {
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); await step(orgId); });
    const result = await turn.failed("error");

    expect(result).toMatchObject({ outcome: "failed", refunded: true, providerCostCents: 20, chargedCreditCents: 0 });
    expect(result.refundedCreditCents).toBe(result.creditCents);
    expect(await available(orgId)).toBeCloseTo(before, 6);
    await credits.flushPendingCreditDebits();
    expect(await available(orgId)).toBeCloseTo(before, 6);
    expect(await refundGrants()).toEqual([]);
    // Provider cost stays for our accounting; customer spend no longer counts the turn.
    const events = await turnEvents(turn.id);
    expect(events.map((event) => event.costCents)).toEqual([0, 0]);
    expect(events.map((event) => event.metadata.providerCostCents)).toEqual([10, 10]);
    expect(events.every((event) => event.metadata.billable === false)).toBe(true);
  });

  it("grants back a failed turn's already-flushed debits once, without funding the org", async () => {
    const start = await pools(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); });
    await credits.flushPendingCreditDebits();
    const charged = await available(orgId);
    // A second step lands after the flush and is still pending when the turn fails.
    await turn.run(async () => { await step(orgId); });
    const result = await turn.failed("timeout");

    expect(result.refunded).toBe(true);
    expect(charged).toBeLessThan(start.prepaid);
    expect(await pools(orgId)).toEqual(start);
    const grants = await refundGrants();
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ source: "refund", org_id: orgId });
    expect(grants[0]!.external_id).toMatch(new RegExp(`^chat-turn-refund:${turn.id}:${orgId}:[0-9a-f]{16}$`));
    expect(Number(grants[0]!.credits)).toBeCloseTo(result.creditCents / 2, 6);
  });

  it("refunds a failed turn exactly once however often it is failed", async () => {
    const start = await pools(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); await step(orgId); });
    await credits.flushPendingCreditDebits();
    const [first, second] = await Promise.all([turn.failed("error"), turn.failed("error")]);
    const again = await billing.refundChatTurn({ turnId: turn.id, eventIds: await turnEventIds(turn.id), reason: "error" });
    await credits.flushPendingCreditDebits();

    expect(first).toEqual(second);
    expect(again).toMatchObject({ credits: 0, grantedCredits: 0, pendingCancelledCredits: 0 });
    expect(await refundGrants()).toHaveLength(1);
    expect(await pools(orgId)).toEqual(start);
  });

  it("settles exactly when flushes race the refund", async () => {
    const start = await pools(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); });
    await credits.flushPendingCreditDebits();
    await turn.run(async () => { await step(orgId); await step(orgId); });
    const eventIds = await turnEventIds(turn.id);
    await Promise.all([
      credits.flushPendingCreditDebits(),
      turn.failed("error"),
      credits.flushPendingCreditDebits(),
      billing.refundChatTurn({ turnId: turn.id, eventIds, reason: "error" }),
      credits.flushPendingCreditDebits(),
    ]);
    await credits.flushPendingCreditDebits();

    expect(await pools(orgId)).toEqual(start);
    expect((await refundGrants()).length).toBeLessThanOrEqual(1);
    expect((await turnEvents(turn.id)).every((event) => event.costCents === 0)).toBe(true);
  });

  it("waits for a step still being written, and bills nothing for steps after the failure", async () => {
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    const inFlight = turn.run(() => step(orgId));
    const result = await turn.failed("aborted");
    // A tool search finishing after the error response.
    await turn.run(() => step(orgId));
    await inFlight;
    await credits.flushPendingCreditDebits();

    expect(result).toMatchObject({ refunded: true, providerCostCents: 10, chargedCreditCents: 0 });
    expect(await available(orgId)).toBeCloseTo(before, 6);
    const events = await turnEvents(turn.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.costCents)).toEqual([0, 0]);
    expect(events[1]!.metadata).toMatchObject({ billable: false, providerCostCents: 10, chatTurnRefund: { late: true } });
  });

  it("refunds a billable step whose write is still in flight when the turn fails", async () => {
    await step(orgId);
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    const inFlight = turn.run(() => step(orgId));
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    const result = await turn.failed("error");
    await inFlight;
    await credits.flushPendingCreditDebits();

    const [event] = await turnEvents(turn.id);
    expect(event!.metadata.chatTurnRefund).toMatchObject({ reason: "error" });
    expect(event!.metadata.chatTurnRefund).not.toHaveProperty("late");
    expect(result).toMatchObject({ refunded: true, chargedCreditCents: 0 });
    expect(result.refundedCreditCents).toBeGreaterThan(0);
    expect(await available(orgId)).toBeCloseTo(before, 6);
  });

  it("keeps a turn the client abandoned charged, including steps finishing after it left", async () => {
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); });
    await credits.flushPendingCreditDebits();
    const client = new AbortController();
    client.abort();
    const abortError = new DOMException("The operation was aborted", "AbortError");
    const result = await turn.failed(billing.chatTurnFailureReason(abortError, client.signal));
    await turn.run(() => step(orgId));
    await credits.flushPendingCreditDebits();

    expect(result).toMatchObject({ outcome: "failed", refunded: false, refundedCreditCents: 0 });
    expect(result.chargedCreditCents).toBe(result.creditCents);
    const events = await turnEvents(turn.id);
    expect(events).toHaveLength(2);
    expect(events.every((event) => event.costCents > 0)).toBe(true);
    expect(await available(orgId)).toBeCloseTo(before - 2 * result.creditCents, 6);
    expect(await refundGrants()).toEqual([]);
  });

  it("waits for usage written inside a still-open transaction before refunding", async () => {
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    let commit!: () => void;
    let inserted!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    const insertDone = new Promise<void>((resolve) => { inserted = resolve; });
    // A Search Session flushes its usage inside its snapshot transaction (search/session.ts).
    const write = turn.run(() => context.trackCurrentChatTurnWrite(sql.begin(async (tx) => {
      await step(orgId, tx as unknown as typeof sql);
      inserted();
      await committed;
    })));
    await insertDone;
    // The insert statement has settled but its transaction is open: the turn still counts the write in flight.
    expect(turn.run(() => context.currentChatTurn()!.inflight.size)).toBeGreaterThan(0);
    const failing = turn.failed("error");
    commit();
    const [result] = await Promise.all([failing, write]);
    await credits.flushPendingCreditDebits();

    expect(result).toMatchObject({ refunded: true, chargedCreditCents: 0 });
    expect(result.refundedCreditCents).toBeGreaterThan(0);
    expect((await turnEvents(turn.id)).map((event) => event.costCents)).toEqual([0]);
    expect(await available(orgId)).toBeCloseTo(before, 6);
  });

  it("rolls the refund back rather than voiding events without granting their flushed credits", async () => {
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); });
    await credits.flushPendingCreditDebits();
    const charged = await available(orgId);
    const eventIds = await turnEventIds(turn.id);
    const [grantId] = await sql<{ id: string }[]>`select gen_random_uuid()::text as id`;
    // Simulate a grant that already holds this refund's id (it can only come from an earlier refund of these events).
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update([...eventIds].sort().join(",")).digest("hex").slice(0, 16);
    await sql`insert into credit_grants (id, org_id, source, external_id, credits)
      values (${grantId!.id}, ${orgId}, 'refund', ${`chat-turn-refund:${turn.id}:${orgId}:${hash}`}, 0)`;

    await expect(billing.refundChatTurn({ turnId: turn.id, eventIds, reason: "error" })).rejects.toThrow(/grant already exists/);
    expect((await turnEvents(turn.id)).every((event) => event.costCents > 0)).toBe(true);
    expect(await available(orgId)).toBeCloseTo(charged, 6);
  });

  it("keeps a failed turn charged when CHAT_REFUND_UNDELIVERED_TURNS=false", async () => {
    vi.stubEnv("CHAT_REFUND_UNDELIVERED_TURNS", "false");
    const before = await available(orgId);
    const turn = billing.beginChatTurn();
    await turn.run(async () => { await step(orgId); });
    const result = await turn.failed("error");
    await turn.run(() => step(orgId));
    await credits.flushPendingCreditDebits();

    expect(result).toMatchObject({ outcome: "failed", refunded: false, refundedCreditCents: 0 });
    expect(await available(orgId)).toBeCloseTo(before - 2 * result.creditCents, 6);
    expect(await refundGrants()).toEqual([]);
  });
});

describe("nested chat turns", () => {
  it("joins the outer turn, and only the owner settles it", async () => {
    const before = await available(FREE);
    const outer = billing.beginChatTurn();
    await outer.run(async () => {
      await step(FREE);
      const nested = billing.beginChatTurn();
      expect(nested).toMatchObject({ id: outer.id, owned: false });
      await nested.run(() => step(FREE));
      // The nested grounded call failing does not refund the agent's turn.
      await nested.failed("error");
    });
    expect(await available(FREE)).toBeLessThan(before);
    const result = await outer.failed("error");
    expect(result).toMatchObject({ refunded: true, providerCostCents: 20 });
    expect(await available(FREE)).toBeCloseTo(before, 6);
  });

  it("gives the turn id to the turn's own answer and a fresh id to a nested answer", async () => {
    const outer = billing.beginChatTurn();
    const [own, nested, again] = outer.run(() => [
      context.claimChatTurnAnswerId(),
      billing.beginChatTurn().run(() => context.claimChatTurnAnswerId()),
      context.claimChatTurnAnswerId(),
    ]);
    expect(own).toBe(outer.id);
    expect(nested).not.toBe(outer.id);
    expect(again).not.toBe(outer.id);
    expect(new Set([own, nested, again]).size).toBe(3);
    expect(context.claimChatTurnAnswerId()).toBeNull();
  });
});
