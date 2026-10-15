import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";

/**
 * The credit pools are moved only by the SQL functions in migration 0024, so
 * the worker and the API share one implementation. These tests pin the order
 * (included before prepaid), overdraw, grant pay-down, idempotency and
 * clawback caps against a database built from server/db/migrations.
 */
describe("credit pool functions", () => {
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

  async function freshOrg(id: string, prepaid: number, included = 0) {
    await db.query(
      `insert into organizations (id, name, created_by_user_id, credit_balance_cents, included_credits_remaining)
       values ($1, $1, 'u1', $2, $3)`,
      [id, prepaid, included],
    );
  }

  async function pools(id: string) {
    const { rows } = await db.query<{ included: string; prepaid: string; active: string | null }>(
      `select included_credits_remaining::text as included, credit_balance_cents::text as prepaid,
              last_billable_activity_at::text as active
       from organizations where id = $1`,
      [id],
    );
    return { included: Number(rows[0]!.included), prepaid: Number(rows[0]!.prepaid), active: rows[0]!.active };
  }

  async function ledger(id: string) {
    const { rows } = await db.query<{ pool: string; credits: string; reason: string }>(
      `select pool, (delta * 100)::text as credits, reason from credit_ledger where org_id = $1 order by created_at, pool`,
      [id],
    );
    return rows.map((row) => ({ pool: row.pool, credits: Number(row.credits), reason: row.reason }));
  }

  it("spends included credits before prepaid and records both pools", async () => {
    await freshOrg("debit-order", 1000, 300);
    const { rows } = await db.query<{ from_included: string; from_prepaid: string }>(
      `select * from debit_org_credits('debit-order', 500)`,
    );
    expect(Number(rows[0]!.from_included)).toBe(300);
    expect(Number(rows[0]!.from_prepaid)).toBe(200);
    const after = await pools("debit-order");
    expect(after.included).toBe(0);
    expect(after.prepaid).toBe(800);
    expect(after.active).not.toBeNull();
    expect(await ledger("debit-order")).toEqual([
      { pool: "included", credits: -300, reason: "usage" },
      { pool: "prepaid", credits: -200, reason: "usage" },
    ]);
  });

  it("lets an admitted run overdraw prepaid credits", async () => {
    await freshOrg("overdraw", 50, 10);
    await db.query(`select * from debit_org_credits('overdraw', 100.5)`);
    const after = await pools("overdraw");
    expect(after.included).toBe(0);
    expect(after.prepaid).toBeCloseTo(-40.5, 9);
  });

  it("does not touch prepaid while included credits cover the debit", async () => {
    await freshOrg("included-only", 100, 1000);
    await db.query(`select * from debit_org_credits('included-only', 0.000123)`);
    const after = await pools("included-only");
    expect(after.included).toBeCloseTo(999.999877, 9);
    expect(after.prepaid).toBe(100);
    expect(await ledger("included-only")).toHaveLength(1);
  });

  it("debits lock the org row without blocking foreign-key checks", async () => {
    // FOR UPDATE would conflict with the FOR KEY SHARE every FK insert for the
    // org takes (audit_log, notification_deliveries, credit_ledger …).
    const { rows } = await db.query<{ def: string }>(`select pg_get_functiondef('debit_org_credits'::regproc) as def`);
    expect(rows[0]?.def).toMatch(/FOR NO KEY UPDATE;/);
    expect(rows[0]?.def).not.toMatch(/\bFOR UPDATE;/);
  });

  it("storage debits do not count as account activity", async () => {
    await freshOrg("storage-debit", 100);
    await db.query(`select * from debit_org_credits('storage-debit', 1, null, 'storage')`);
    expect((await pools("storage-debit")).active).toBeNull();
  });

  it("an included grant pays down a negative prepaid balance first", async () => {
    await freshOrg("paydown", -120);
    const { rows } = await db.query<{ granted: boolean }>(
      `select grant_org_credits('paydown', 'subscription', 'in_1', 'included', 2000, true) as granted`,
    );
    expect(rows[0]!.granted).toBe(true);
    const after = await pools("paydown");
    expect(after.prepaid).toBe(0);
    expect(after.included).toBe(1880);
  });

  it("renewal grants expire the old allowance; proration grants add to it", async () => {
    await freshOrg("renewal", 0, 0);
    await db.query(`select grant_org_credits('renewal', 'subscription', 'in_r1', 'included', 2000, true)`);
    await db.query(`select * from debit_org_credits('renewal', 500)`);
    await db.query(`select grant_org_credits('renewal', 'subscription', 'in_r2', 'included', 1650, false)`);
    expect((await pools("renewal")).included).toBe(3150);
    await db.query(`select grant_org_credits('renewal', 'subscription', 'in_r3', 'included', 5500, true)`);
    expect((await pools("renewal")).included).toBe(5500);
    const { rows } = await db.query<{ granted: string }>(
      `select included_credits_granted::text as granted from organizations where id = 'renewal'`,
    );
    expect(Number(rows[0]!.granted)).toBe(5500);
    expect((await ledger("renewal")).some((row) => row.reason === "included_expired" && row.credits === -3150)).toBe(true);
  });

  it("grants are idempotent per (source, external id)", async () => {
    await freshOrg("idempotent", 0);
    await db.query(`select grant_org_credits('idempotent', 'topup', 'pi_1', 'prepaid', 1000)`);
    const { rows } = await db.query<{ granted: boolean }>(
      `select grant_org_credits('idempotent', 'topup', 'pi_1', 'prepaid', 1000) as granted`,
    );
    expect(rows[0]!.granted).toBe(false);
    expect((await pools("idempotent")).prepaid).toBe(1000);
  });

  it("clawbacks are cumulative and capped at the un-reversed grant", async () => {
    await freshOrg("clawback", 0);
    await db.query(`select grant_org_credits('clawback', 'topup', 'pi_c', 'prepaid', 1000)`);
    const grantId = (await db.query<{ id: string }>(`select id from credit_grants where external_id = 'pi_c'`)).rows[0]!.id;
    const reverse = async (target: number) =>
      Number((await db.query<{ v: string }>(`select reverse_credit_grant($1, $2, 'clawback:refund')::text as v`, [grantId, target])).rows[0]!.v);
    expect(await reverse(400)).toBe(400);
    expect(await reverse(400)).toBe(0); // replayed cumulative refund
    expect(await reverse(5000)).toBe(600); // dispute: capped at what is left
    expect(await reverse(5000)).toBe(0);
    expect((await pools("clawback")).prepaid).toBe(0);
  });

  it("clawing back an included grant drains included first, then overdraws prepaid", async () => {
    await freshOrg("clawback-included", 100);
    await db.query(`select grant_org_credits('clawback-included', 'subscription', 'in_ci', 'included', 2000, true)`);
    await db.query(`select * from debit_org_credits('clawback-included', 1500)`);
    const grantId = (await db.query<{ id: string }>(`select id from credit_grants where external_id = 'in_ci'`)).rows[0]!.id;
    await db.query(`select reverse_credit_grant($1, 2000, 'clawback:dispute')`, [grantId]);
    const after = await pools("clawback-included");
    expect(after.included).toBe(0);
    expect(after.prepaid).toBe(-1400);
  });

  it("the starter trigger grants once per user into the prepaid pool", async () => {
    await db.exec(`
      insert into "user" (id, name, email)
      values ('starter-user', 'S', 's@example.com');
      insert into organizations (id, name, created_by_user_id, is_personal, personal_owner_user_id)
      values ('starter-org', 'S', 'starter-user', true, 'starter-user');
    `);
    expect((await pools("starter-org")).prepaid).toBe(2500);
    const { rows } = await db.query<{ source: string; credits: string }>(
      `select source, credits::text from credit_grants where org_id = 'starter-org'`,
    );
    expect(rows).toEqual([{ source: "starter", credits: "2500.000000000000" }]);
  });

  describe("pending debits (migration 0030)", () => {
    const enqueue = (org: string, credits: number, run: string | null = null, reason = "usage") =>
      db.query(`select enqueue_org_credit_debit($1, $2, 'u1', $3, $4, 'ws-1')`, [org, credits, reason, run]);
    const flush = async (org: string) => {
      const { rows } = await db.query<{ debits: number; credits: string }>(`select * from apply_pending_org_debits($1)`, [org]);
      return { debits: Number(rows[0]!.debits), credits: Number(rows[0]!.credits) };
    };
    const available = async (org: string) => {
      const { rows } = await db.query<{ included: string; prepaid: string; pending: string; available: string }>(
        `select included::text, prepaid::text, pending::text, available::text from org_available_credits($1)`, [org]);
      const row = rows[0]!;
      return { included: Number(row.included), prepaid: Number(row.prepaid), pending: Number(row.pending), available: Number(row.available) };
    };
    const pendingRows = async (org: string) =>
      Number((await db.query<{ n: number }>(`select count(*)::int as n from credit_debits_pending where org_id = $1`, [org])).rows[0]!.n);

    it("one flush of many pending debits matches the same debits applied one by one", async () => {
      await freshOrg("agg-direct", 1000, 300);
      await freshOrg("agg-pending", 1000, 300);
      // Sub-cent amounts across 3 runs, crossing from included into prepaid and below zero.
      const amounts = Array.from({ length: 240 }, (_, i) => 3.5 + (i % 7) * 1.000123456789);
      for (const amount of amounts) await db.query(`select * from debit_org_credits('agg-direct', $1, 'u1')`, [amount]);
      await Promise.all(amounts.map((amount, i) => enqueue("agg-pending", amount, `run-${i % 3}`)));

      // Nothing has touched the pools yet; admission already sees the debits.
      expect(await pools("agg-pending")).toMatchObject({ included: 300, prepaid: 1000, active: null });
      const before = await available("agg-pending");
      const total = amounts.reduce((sum, amount) => sum + amount, 0);
      expect(before.pending).toBeCloseTo(total, 9);
      expect(before.available).toBeCloseTo(1300 - total, 9);

      expect(await flush("agg-pending")).toEqual({ debits: 240, credits: expect.closeTo(total, 9) });
      const direct = await pools("agg-direct");
      const aggregated = await pools("agg-pending");
      expect(aggregated.included).toBe(direct.included);
      expect(aggregated.prepaid).toBeCloseTo(direct.prepaid, 9);
      expect(aggregated.prepaid).toBeLessThan(0);
      expect(aggregated.active).not.toBeNull();
      expect(await pendingRows("agg-pending")).toBe(0);
      expect((await available("agg-pending")).pending).toBe(0);

      // One ledger row per pool for the whole flush, with the run breakdown.
      const { rows } = await db.query<{ pool: string; credits: string; metadata: Record<string, unknown> }>(
        `select pool, (delta * 100)::text as credits, metadata from credit_ledger where org_id = 'agg-pending' order by pool`);
      expect(rows.map((row) => row.pool)).toEqual(["included", "prepaid"]);
      expect(Number(rows[0]!.credits)).toBe(-300);
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
      expect((await pools("agg-idem")).prepaid).toBe(400);
      await enqueue("agg-idem", 50, "run-a");
      expect((await pools("agg-idem")).prepaid).toBe(400);
      expect((await flush("agg-idem")).credits).toBe(50);
      expect((await pools("agg-idem")).prepaid).toBe(350);
      const { rows } = await db.query<{ metadata: Record<string, unknown> }>(
        `select metadata from credit_ledger where org_id = 'agg-idem' order by created_at limit 1`);
      expect(rows[0]!.metadata).toMatchObject({ runId: "run-a", workspaceId: "ws-1", debitCount: 1 });
    });

    it("ignores zero and negative amounts and keeps storage debits out of account activity", async () => {
      await freshOrg("agg-storage", 100);
      await enqueue("agg-storage", 0);
      await enqueue("agg-storage", -5);
      expect(await pendingRows("agg-storage")).toBe(0);
      await enqueue("agg-storage", 2, null, "storage");
      await flush("agg-storage");
      expect(await pools("agg-storage")).toMatchObject({ prepaid: 98, active: null });
      expect(await ledger("agg-storage")).toEqual([{ pool: "prepaid", credits: -2, reason: "storage" }]);
    });

    it("a grant applies pending debits first, so an overdraft is still paid down", async () => {
      await freshOrg("agg-paydown", 30, 20);
      await enqueue("agg-paydown", 100, "run-x");
      expect((await available("agg-paydown")).available).toBe(-50);
      // Renewal: last period's usage (pending) spends the old allowance, overdraws prepaid by 50,
      // and the renewal grant pays that down before resetting the allowance.
      await db.query(`select grant_org_credits('agg-paydown', 'subscription', 'in_agg', 'included', 2000, true)`);
      expect(await pendingRows("agg-paydown")).toBe(0);
      const after = await pools("agg-paydown");
      expect(after.prepaid).toBe(0);
      expect(after.included).toBe(1950);
      expect(await ledger("agg-paydown")).toEqual(expect.arrayContaining([
        { pool: "included", credits: -20, reason: "usage" },
        { pool: "prepaid", credits: -80, reason: "usage" },
        { pool: "prepaid", credits: 50, reason: "grant:subscription" },
      ]));
    });

    it("expiry and clawback apply pending debits before moving the pools", async () => {
      await freshOrg("agg-expire", 100, 300);
      await enqueue("agg-expire", 120);
      expect(Number((await db.query<{ v: string }>(`select expire_included_credits('agg-expire')::text as v`)).rows[0]!.v)).toBe(180);
      expect(await pools("agg-expire")).toMatchObject({ included: 0, prepaid: 100 });

      await freshOrg("agg-claw", 0);
      await db.query(`select grant_org_credits('agg-claw', 'topup', 'pi_agg', 'prepaid', 1000)`);
      await enqueue("agg-claw", 900);
      const grantId = (await db.query<{ id: string }>(`select id from credit_grants where external_id = 'pi_agg'`)).rows[0]!.id;
      await db.query(`select reverse_credit_grant($1, 1000, 'clawback:refund')`, [grantId]);
      expect(await pools("agg-claw")).toMatchObject({ prepaid: -900 });
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
      // A foreign key would take FOR KEY SHARE on the org row from every concurrent checkpoint.
      expect(fk.rows[0]!.n).toBe(0);
    });
  });
});
