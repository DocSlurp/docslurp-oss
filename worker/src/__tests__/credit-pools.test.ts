import { FUNDED_WORKER_SLOTS, STARTER_CREDITS, STARTER_WORKER_SLOTS } from "@docslurp/shared";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";

/**
 * The prepaid balance is moved only by the SQL functions in migration 0068, so
 * the worker and the API share one implementation. These tests pin overdraw,
 * idempotent grants, funding, clawback caps and the pending-debit flusher
 * against a database built from server/db/migrations.
 */
describe("credit balance functions", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    await db.exec(`
      insert into "user" (id, name, email)
      values ('u1', 'U', 'u1@example.com');
    `);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function freshOrg(id: string, balance: number) {
    await db.query(
      `insert into organizations (id, name, created_by_user_id, credit_balance_cents) values ($1, $1, 'u1', $2)`,
      [id, balance],
    );
  }

  async function org(id: string) {
    const { rows } = await db.query<{ balance: string; funded: boolean; slots: number }>(
      `select credit_balance_cents::text as balance, funded_at is not null as funded, worker_slots as slots
       from organizations where id = $1`,
      [id],
    );
    return { balance: Number(rows[0]!.balance), funded: rows[0]!.funded, slots: rows[0]!.slots };
  }

  async function ledger(id: string) {
    const { rows } = await db.query<{ credits: string; reason: string }>(
      `select (delta * 100)::text as credits, reason from credit_ledger where org_id = $1 order by created_at`,
      [id],
    );
    return rows.map((row) => ({ credits: Number(row.credits), reason: row.reason }));
  }

  it("debits the single prepaid balance and records one ledger row", async () => {
    await freshOrg("debit", 1000);
    const { rows } = await db.query<{ debited: string }>(`select debit_org_credits('debit', 500)::text as debited`);
    expect(Number(rows[0]!.debited)).toBe(500);
    expect((await org("debit")).balance).toBe(500);
    expect(await ledger("debit")).toEqual([{ credits: -500, reason: "usage" }]);
  });

  it("lets an admitted run overdraw and keeps sub-cent fractions", async () => {
    await freshOrg("overdraw", 50);
    await db.query(`select debit_org_credits('overdraw', 100.5)`);
    await db.query(`select debit_org_credits('overdraw', 0.000123)`);
    expect((await org("overdraw")).balance).toBeCloseTo(-50.500123, 9);
  });

  it("debits lock the org row without blocking foreign-key checks", async () => {
    const { rows } = await db.query<{ def: string }>(`select pg_get_functiondef('debit_org_credits'::regproc) as def`);
    expect(rows[0]?.def).toMatch(/FOR NO KEY UPDATE;/);
    expect(rows[0]?.def).not.toMatch(/\bFOR UPDATE;/);
  });

  it("has no plans, included allowance, subscriptions or expiry", async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'organizations'
         and column_name in ('plan_id', 'included_credits_remaining', 'subscription_status', 'past_due_since', 'last_billable_activity_at', 'stripe_subscription_id')`,
    );
    expect(rows).toEqual([]);
    await freshOrg("no-sub", 0);
    await expect(db.query(`select grant_org_credits('no-sub', 'subscription', 'in_1', 2000)`)).rejects.toThrow(/credit_grants_source_check/);
  });

  it("a top-up pays down a negative balance, funds the org and raises its worker ceiling once", async () => {
    await freshOrg("fund", -120);
    expect(await org("fund")).toEqual({ balance: -120, funded: false, slots: STARTER_WORKER_SLOTS });
    const { rows } = await db.query<{ granted: boolean }>(`select grant_org_credits('fund', 'topup', 'pi_f', 2500) as granted`);
    expect(rows[0]!.granted).toBe(true);
    expect(await org("fund")).toEqual({ balance: 2380, funded: true, slots: FUNDED_WORKER_SLOTS });
    // A custom ceiling set later is never lowered by another grant.
    await db.query(`update organizations set worker_slots = 600 where id = 'fund'`);
    await db.query(`select grant_org_credits('fund', 'auto_recharge', 'pi_f2', 1000)`);
    expect((await org("fund")).slots).toBe(600);
  });

  it("starter grants never fund an org", async () => {
    await freshOrg("starter-only", 0);
    await db.query(`select grant_org_credits('starter-only', 'starter', 'starter-only-user', 250)`);
    expect(await org("starter-only")).toEqual({ balance: 250, funded: false, slots: STARTER_WORKER_SLOTS });
  });

  it("grants are idempotent per (source, external id)", async () => {
    await freshOrg("idempotent", 0);
    await db.query(`select grant_org_credits('idempotent', 'topup', 'pi_1', 1000)`);
    const { rows } = await db.query<{ granted: boolean }>(`select grant_org_credits('idempotent', 'topup', 'pi_1', 1000) as granted`);
    expect(rows[0]!.granted).toBe(false);
    expect((await org("idempotent")).balance).toBe(1000);
  });

  it("clawbacks are cumulative, capped at the un-reversed grant, and a fully refunded org is starter again", async () => {
    await freshOrg("clawback", 0);
    await db.query(`select grant_org_credits('clawback', 'topup', 'pi_c', 1000)`);
    const grantId = (await db.query<{ id: string }>(`select id from credit_grants where external_id = 'pi_c'`)).rows[0]!.id;
    const reverse = async (target: number) =>
      Number((await db.query<{ v: string }>(`select reverse_credit_grant($1, $2, 'clawback:refund')::text as v`, [grantId, target])).rows[0]!.v);
    expect(await reverse(400)).toBe(400);
    expect((await org("clawback")).funded).toBe(true);
    expect(await reverse(400)).toBe(0); // replayed cumulative refund
    expect(await reverse(5000)).toBe(600); // dispute: capped at what is left
    expect(await reverse(5000)).toBe(0);
    expect(await org("clawback")).toEqual({ balance: 0, funded: false, slots: STARTER_WORKER_SLOTS });
  });

  it("the starter trigger grants once per user", async () => {
    await db.exec(`
      insert into "user" (id, name, email)
      values ('starter-user', 'S', 's@example.com');
      insert into organizations (id, name, created_by_user_id, is_personal, personal_owner_user_id)
      values ('starter-org', 'S', 'starter-user', true, 'starter-user');
    `);
    expect(await org("starter-org")).toEqual({ balance: STARTER_CREDITS, funded: false, slots: STARTER_WORKER_SLOTS });
    const { rows } = await db.query<{ source: string; credits: string }>(
      `select source, credits::text from credit_grants where org_id = 'starter-org'`,
    );
    expect(rows).toEqual([{ source: "starter", credits: STARTER_CREDITS.toFixed(12) }]);
  });

  describe("pending debits (migration 0030)", () => {
    const enqueue = (orgId: string, credits: number, run: string | null = null, reason = "usage") =>
      db.query(`select enqueue_org_credit_debit($1, $2, 'u1', $3, $4, 'ws-1')`, [orgId, credits, reason, run]);
    const flush = async (orgId: string) => {
      const { rows } = await db.query<{ debits: number; credits: string }>(`select * from apply_pending_org_debits($1)`, [orgId]);
      return { debits: Number(rows[0]!.debits), credits: Number(rows[0]!.credits) };
    };
    const available = async (orgId: string) => {
      const { rows } = await db.query<{ balance: string; pending: string; available: string }>(
        `select balance::text, pending::text, available::text from org_available_credits($1)`, [orgId]);
      const row = rows[0]!;
      return { balance: Number(row.balance), pending: Number(row.pending), available: Number(row.available) };
    };
    const pendingRows = async (orgId: string) =>
      Number((await db.query<{ n: number }>(`select count(*)::int as n from credit_debits_pending where org_id = $1`, [orgId])).rows[0]!.n);

    it("one flush of many pending debits matches the same debits applied one by one", async () => {
      await freshOrg("agg-direct", 1000);
      await freshOrg("agg-pending", 1000);
      const amounts = Array.from({ length: 240 }, (_, i) => 3.5 + (i % 7) * 1.000123456789);
      for (const amount of amounts) await db.query(`select debit_org_credits('agg-direct', $1, 'u1')`, [amount]);
      await Promise.all(amounts.map((amount, i) => enqueue("agg-pending", amount, `run-${i % 3}`)));

      expect((await org("agg-pending")).balance).toBe(1000);
      const before = await available("agg-pending");
      const total = amounts.reduce((sum, amount) => sum + amount, 0);
      expect(before.pending).toBeCloseTo(total, 9);
      expect(before.available).toBeCloseTo(1000 - total, 9);

      expect(await flush("agg-pending")).toEqual({ debits: 240, credits: expect.closeTo(total, 9) });
      expect((await org("agg-pending")).balance).toBeCloseTo((await org("agg-direct")).balance, 9);
      expect((await org("agg-pending")).balance).toBeLessThan(0);
      expect(await pendingRows("agg-pending")).toBe(0);

      const { rows } = await db.query<{ credits: string; metadata: Record<string, unknown> }>(
        `select (delta * 100)::text as credits, metadata from credit_ledger where org_id = 'agg-pending'`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.metadata).toMatchObject({ aggregated: true, debitCount: 240, runCount: 3, runsTruncated: false, workspaceIds: ["ws-1"] });
      const runs = rows[0]!.metadata.runs as Record<string, number>;
      expect(Object.keys(runs).sort()).toEqual(["run-0", "run-1", "run-2"]);
      expect(Object.values(runs).reduce((sum, value) => sum + Number(value), 0)).toBeCloseTo(total, 6);
    });

    it("a second flush applies nothing; debits enqueued later wait for the next flush", async () => {
      await freshOrg("agg-idem", 500);
      await enqueue("agg-idem", 100, "run-a");
      expect((await flush("agg-idem")).debits).toBe(1);
      expect(await flush("agg-idem")).toEqual({ debits: 0, credits: 0 });
      expect((await org("agg-idem")).balance).toBe(400);
      await enqueue("agg-idem", 50, "run-a");
      expect((await org("agg-idem")).balance).toBe(400);
      expect((await flush("agg-idem")).credits).toBe(50);
      expect((await org("agg-idem")).balance).toBe(350);
      const { rows } = await db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from credit_ledger where org_id = 'agg-idem' order by created_at limit 1`);
      expect(rows[0]!.metadata).toMatchObject({ runId: "run-a", workspaceId: "ws-1", debitCount: 1 });
    });

    it("ignores zero and negative amounts", async () => {
      await freshOrg("agg-storage", 100);
      await enqueue("agg-storage", 0);
      await enqueue("agg-storage", -5);
      expect(await pendingRows("agg-storage")).toBe(0);
      await enqueue("agg-storage", 2, null, "storage");
      await flush("agg-storage");
      expect((await org("agg-storage")).balance).toBe(98);
      expect(await ledger("agg-storage")).toEqual([{ credits: -2, reason: "storage" }]);
    });

    it("a grant applies pending debits first, so an overdraft is paid down in order", async () => {
      await freshOrg("agg-paydown", 50);
      await enqueue("agg-paydown", 100, "run-x");
      expect((await available("agg-paydown")).available).toBe(-50);
      await db.query(`select grant_org_credits('agg-paydown', 'topup', 'pi_agg_p', 2500)`);
      expect(await pendingRows("agg-paydown")).toBe(0);
      expect((await org("agg-paydown")).balance).toBe(2450);
      expect(await ledger("agg-paydown")).toEqual([
        { credits: -100, reason: "usage" },
        { credits: 2500, reason: "grant:topup" },
      ]);
    });

    it("a clawback applies pending debits before moving the balance", async () => {
      await freshOrg("agg-claw", 0);
      await db.query(`select grant_org_credits('agg-claw', 'topup', 'pi_agg', 1000)`);
      await enqueue("agg-claw", 900);
      const grantId = (await db.query<{ id: string }>(`select id from credit_grants where external_id = 'pi_agg'`)).rows[0]!.id;
      await db.query(`select reverse_credit_grant($1, 1000, 'clawback:refund')`, [grantId]);
      expect((await org("agg-claw")).balance).toBe(-900);
      expect(await pendingRows("agg-claw")).toBe(0);
    });

    it("drops pending debits of a deleted org and lists orgs oldest first", async () => {
      await enqueue("no-such-org", 10);
      const { rows } = await db.query<{ org_id: string }>(`select org_id from pending_debit_orgs(100)`);
      expect(rows.map((row) => row.org_id)).toContain("no-such-org");
      expect(await flush("no-such-org")).toEqual({ debits: 0, credits: 0 });
      expect(await pendingRows("no-such-org")).toBe(0);
    });

    it("the hot-path enqueue never reads or locks organizations", async () => {
      const { rows } = await db.query<{ def: string }>(`select pg_get_functiondef('enqueue_org_credit_debit'::regproc) as def`);
      expect(rows[0]!.def).not.toMatch(/organizations/i);
      const fk = await db.query<{ n: number }>(
        `select count(*)::int as n from pg_constraint where conrelid = 'credit_debits_pending'::regclass and contype = 'f'`);
      expect(fk.rows[0]!.n).toBe(0);
    });
  });
});
