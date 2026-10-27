import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Billing SQL (migration 0068 functions + the services that call them) against
 * a real, migrated Postgres. Opt-in:
 *   BILLING_TEST_DATABASE_URL=postgres://… (a throwaway database; rows are seeded and wiped)
 */
const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const ORG = "org-billing-db";
const USER = "user-billing-db";

describe.skipIf(!databaseUrl)("billing credits (database)", () => {
  let sql: typeof import("../db.js").sql;
  let credits: typeof import("../services/billing/credits.js");
  let autoRecharge: typeof import("../services/billing/auto-recharge.js");

  const org = async () => {
    const [row] = await sql<{ prepaid: number; funded: boolean; failures: number }[]>`
      select credit_balance_cents as prepaid, funded_at is not null as funded, auto_recharge_consecutive_failures as failures
      from organizations where id = ${ORG}
    `;
    return { prepaid: Number(row!.prepaid), funded: row!.funded, failures: Number(row!.failures) };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    ({ sql } = await import("../db.js"));
    credits = await import("../services/billing/credits.js");
    autoRecharge = await import("../services/billing/auto-recharge.js");
  });

  beforeEach(async () => {
    await sql`delete from credit_debits_pending where org_id = ${ORG}`;
    await sql`delete from organizations where id = ${ORG}`;
    // Usage and ledger rows refuse a hard user delete (migration 0036).
    await sql`delete from usage_events where user_id = ${USER}`;
    await sql`delete from credit_ledger where user_id = ${USER}`;
    await sql`delete from "user" where id = ${USER}`;
    await sql`insert into "user"(id, name, email) values (${USER}, 'Billing DB', 'billing-db@example.test')`;
    // Not personal: no starter grant, so every balance below is explicit.
    await sql`insert into organizations(id, name, slug, created_by_user_id) values (${ORG}, 'Billing DB', 'billing-db', ${USER})`;
    await sql`update organizations set credit_balance_cents = 1000 where id = ${ORG}`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql`delete from organizations where id = ${ORG}`;
    // Usage and ledger rows refuse a hard user delete (migration 0036).
    await sql`delete from usage_events where user_id = ${USER}`;
    await sql`delete from credit_ledger where user_id = ${USER}`;
    await sql`delete from "user" where id = ${USER}`;
    await sql.end();
  });

  it("records API AI usage at provider cost without debiting credits, once across a ledger flush retry", async () => {
    const { createUsageLedger } = await import("../lib/ai-usage.js");
    const ledger = createUsageLedger({ userId: USER, scope: { orgId: ORG, sessionId: "billing-retry" } });
    ledger.record({ provider: "openai", model: "text-embedding-3-small", metric: "embed-query", inputTokens: 100, costCents: 10 });
    const first = await ledger.flushWithin(sql);
    // Simulate a response lost after commit; retry without advancing the cursor.
    const retry = await ledger.flushWithin(sql);
    retry.commit();
    expect(first.events[0]?.costCents).toBe(0);
    const [receipt] = await sql<{ count: number; cost: number; provider_cost: number }[]>`
      select count(*)::int as count, sum(cost_cents) as cost,
        max((metadata->>'providerCostCents')::numeric) as provider_cost
      from usage_events where user_id = ${USER} and metadata->>'sessionId' = 'billing-retry'
    `;
    expect(Number(receipt?.count)).toBe(1);
    expect(Number(receipt?.cost)).toBe(0);
    expect(Number(receipt?.provider_cost)).toBe(10);
    expect(await credits.getAvailableCredits(ORG)).toMatchObject({ pending: 0, available: 1000 });
  });

  const grant = (externalId: string, amount: number) =>
    credits.grantOrgCredits(sql, { orgId: ORG, source: "topup", externalId, credits: amount });

  it("lets the balance go negative, and the next top-up pays it down and funds the org", async () => {
    expect(await credits.debitOrgCredits(sql, { orgId: ORG, credits: 2200 })).toBe(2200);
    expect(await org()).toMatchObject({ prepaid: -1200, funded: false });
    await grant("pi_paydown", 5000);
    expect(await org()).toMatchObject({ prepaid: 3800, funded: true });
  });

  it("grants once per Stripe object", async () => {
    expect(await grant("pi_1", 2500)).toBe(true);
    expect(await grant("pi_1", 2500)).toBe(false);
    expect((await org()).prepaid).toBe(3500);
  });

  it("reverse_credit_grant is cumulative and never exceeds the grant", async () => {
    await grant("pi_topup", 2500);
    const [row] = await sql<{ id: string }[]>`select id from credit_grants where external_id = 'pi_topup'`;
    const reverse = async (target: number) => {
      const [r] = await sql<{ reversed: number }[]>`select reverse_credit_grant(${row!.id}, ${target}, 'clawback:test') as reversed`;
      return Number(r!.reversed);
    };
    expect(await reverse(1250)).toBe(1250);
    expect(await reverse(1250)).toBe(0); // redelivered charge.refunded
    expect(await reverse(9999)).toBe(1250); // lost dispute: capped at the grant
    expect((await org()).prepaid).toBe(1000);
  });

  it("a late payment_failed webhook for an older auto-recharge attempt does not count again", async () => {
    const attempt1 = new Date(Date.now() - 30 * 60_000);
    const attempt2 = new Date(Date.now() - 15 * 60_000);
    // Sweeper attempt 1 fails synchronously and is counted with its PaymentIntent.
    await sql`update organizations set auto_recharge_last_attempt_at = ${attempt1} where id = ${ORG}`;
    await autoRecharge.recordAutoRechargeFailure(sql, { orgId: ORG, ref: "pi_a1", reason: "card_declined" });
    // Webhook for the same intent: deduplicated by ref.
    await autoRecharge.recordAutoRechargeFailure(sql, { orgId: ORG, ref: "pi_a1", reason: "card_declined", intentCreatedAt: attempt1 });
    expect((await org()).failures).toBe(1);
    // Attempt 2 fails and is counted.
    await sql`update organizations set auto_recharge_last_attempt_at = ${attempt2} where id = ${ORG}`;
    await autoRecharge.recordAutoRechargeFailure(sql, { orgId: ORG, ref: "pi_a2", reason: "card_declined" });
    expect((await org()).failures).toBe(2);
    // Attempt 1's webhook arrives late (retry / listing lag): stale, not counted.
    await autoRecharge.recordAutoRechargeFailure(sql, { orgId: ORG, ref: "pi_a1", reason: "card_declined", intentCreatedAt: attempt1 });
    expect((await org()).failures).toBe(2);
    // An asynchronous failure of the current attempt (seen only by webhook) still counts.
    await sql`update organizations set auto_recharge_last_failure_ref = null where id = ${ORG}`;
    await autoRecharge.recordAutoRechargeFailure(sql, { orgId: ORG, ref: "pi_a2_async", reason: "payment_failed", intentCreatedAt: new Date(attempt2.getTime() + 1000) });
    expect((await org()).failures).toBe(3);
  });

  it("pending debits count against admission at once and land in the balance on the next flush", async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      credits.enqueueOrgCreditDebit(sql, { orgId: ORG, credits: 10.5, runId: `run-${i % 4}`, workspaceId: "ws" })));
    // Balance untouched; admission and the overview row already subtract the 525 pending.
    expect((await org()).prepaid).toBe(1000);
    expect(await credits.getAvailableCredits(ORG)).toEqual({ balance: 1000, pending: 525, available: 475 });
    const row = await credits.getOrgBillingRow(ORG);
    expect(credits.toCreditBalance(row!)).toMatchObject({ pending: 525, available: 475 });

    const flushed = await credits.flushPendingCreditDebits();
    expect(flushed.debits).toBeGreaterThanOrEqual(50);
    expect((await org()).prepaid).toBe(475);
    expect(await credits.getAvailableCredits(ORG)).toMatchObject({ pending: 0, available: 475 });
    const ledger = await credits.listCreditLedger({ orgId: ORG });
    const usage = ledger.filter((entry) => entry.reason === "usage");
    expect(usage.map((entry) => entry.deltaCredits)).toEqual([-525]);
    expect(usage[0]!.metadata).toMatchObject({ aggregated: true, debitCount: 50, runCount: 4 });
  });

  it("auto-recharge's threshold sees pending debits", async () => {
    await sql`update organizations set auto_recharge_enabled = true, stripe_customer_id = 'cus_pending_test',
      auto_recharge_threshold_credits = 500, auto_recharge_amount_cents = 1000 where id = ${ORG}`;
    const below = async () => {
      const [r] = await sql<{ below: boolean }[]>`
        select o.credit_balance_cents - pending_org_debit_credits(o.id)
          < o.auto_recharge_threshold_credits as below
        from organizations o where o.id = ${ORG}`;
      return r!.below;
    };
    expect(await below()).toBe(false);
    await credits.enqueueOrgCreditDebit(sql, { orgId: ORG, credits: 600 });
    expect(await below()).toBe(true);
  });
});
