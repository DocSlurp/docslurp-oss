import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Chat credit reserve and interactive overdraft (migration 0053) against a
 * migrated database, with the default values: $1 (100 credits) for starter
 * orgs, $3 (300) for funded orgs, 5-credit holds.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let guard: typeof import("../services/billing/spend-guard.js");
let leases: typeof import("../services/billing/credit-leases.js");

beforeAll(async () => {
  process.env.WORKER_CREDIT_LEASES = "on";
  // Leases take everything free up to the 10-credit initial size, so the
  // numbers below are exact.
  process.env.WORKER_CREDIT_LEASE_FRACTION = "1";
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1,
    prepare: false,
    onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/temporal.js", () => ({ signalPipelinePause: vi.fn(), signalPipelineResume: vi.fn() }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  guard = await import("../services/billing/spend-guard.js");
  leases = await import("../services/billing/credit-leases.js");
}, 120_000);

afterAll(async () => {
  delete process.env.WORKER_CREDIT_LEASES;
  delete process.env.WORKER_CREDIT_LEASE_FRACTION;
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from workspace_runs`;
  await sql`delete from credit_leases`;
  await sql`delete from interactive_spend_holds`;
  await sql`delete from credit_grants`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 0)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W')`;
  await grantOnce("o1");
});

async function grantOnce(orgId: string) {
  await sql`insert into credit_grants(org_id, source, external_id, credits) values (${orgId}, 'starter', ${`starter-${orgId}`}, 2500)`;
}

const balance = (credits: number, account: "starter" | "funded" = "starter") =>
  sql`update organizations set credit_balance_cents = ${credits}, funded_at = ${account === "funded" ? new Date() : null} where id = 'o1'`;

async function admit(id: string) {
  return await guard.admitRunSpend("o1", "w", (tx) => tx`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values (${id}, 'o1', 'u1', 'w', 'bulk-upload', 'queued', 'queued', '{}')
    returning id
  `, { leaseRunId: id });
}

const outstanding = async () =>
  Number((await sql<{ total: number }[]>`select org_outstanding_credit_leases('o1') as total`)[0]!.total);

const chat = () => guard.assertCanSpend(null, "w", { kind: "interactive" });

describe("chat credit reserve", () => {
  it("never grants leases into the reserve, however many runs ask", async () => {
    await balance(130);
    // 30 credits free for jobs: runs are admitted and leased until it is gone.
    const admitted: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const id = `run-${i}`;
      if (await admit(id).then(() => true, () => false)) admitted.push(id);
    }
    expect(admitted).toEqual(["run-0", "run-1", "run-2"]);
    expect(await outstanding()).toBeCloseTo(30, 6);
    // Renewals of every run (worker path) cannot reach into the reserve either.
    for (const runId of admitted) {
      await sql`update workspace_runs set status = 'processing' where id = ${runId}`;
      await leases.grantRunCreditLease(sql as never, { runId, orgId: "o1", workspaceId: "w" });
    }
    expect(await outstanding()).toBeLessThanOrEqual(30 + 1e-9);
    // Jobs are out of credits; chat still works on the reserve.
    await expect(guard.assertCanSpend("o1", "w")).rejects.toMatchObject({ code: "credit_exhausted" });
    await expect(chat()).resolves.toBeUndefined();
  });

  it("refuses run admission once only the reserve is left, and admits again above it", async () => {
    await balance(100);
    await expect(admit("run-a")).rejects.toMatchObject({ code: "credit_exhausted" });
    await balance(-20);
    await expect(admit("run-a")).rejects.toMatchObject({ code: "credit_exhausted" });
    await balance(101);
    await expect(admit("run-a")).resolves.toBeDefined();
    expect(await outstanding()).toBeCloseTo(1, 6);
  });

  it("uses the funded reserve for funded orgs", async () => {
    await balance(300, "funded");
    await expect(admit("run-a")).rejects.toMatchObject({ code: "credit_exhausted" });
    await balance(310, "funded");
    await expect(admit("run-a")).resolves.toBeDefined();
    expect(await outstanding()).toBeCloseTo(10, 6);
  });
});

describe("interactive overdraft", () => {
  it("carries a balance down to the allowance, then refuses with a 402 even under concurrent calls", async () => {
    await balance(-50);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => chat()));
    const admitted = results.filter((result) => result.status === "fulfilled").length;
    // -50 - holds must stay above -100: ten 5-credit holds fit.
    expect(admitted).toBe(10);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ statusCode: 402, code: "credit_exhausted" });
    const [held] = await sql<{ total: number }[]>`select coalesce(sum(credits), 0) as total from interactive_spend_holds where org_id = 'o1'`;
    expect(held!.total).toBe(50);
    // Holds expire on their own and the allowance comes back.
    await sql`update interactive_spend_holds set expires_at = now() - interval '1 second'`;
    await expect(chat()).resolves.toBeUndefined();
  });

  it("stops at the allowance itself", async () => {
    await balance(-100);
    await expect(chat()).rejects.toMatchObject({ code: "credit_exhausted" });
    await balance(-300, "funded");
    await expect(chat()).rejects.toMatchObject({ code: "credit_exhausted" });
    await balance(-290, "funded");
    await expect(chat()).resolves.toBeUndefined();
  });

  it("ignores credits held by running jobs", async () => {
    await balance(104);
    await admit("run-a");
    expect(await outstanding()).toBeCloseTo(4, 6);
    // 104 available, 4 leased: jobs are out, chat is fine.
    await expect(guard.assertCanSpend("o1", "w")).rejects.toMatchObject({ code: "credit_exhausted" });
    await expect(chat()).resolves.toBeUndefined();
  });

  it("counts credits running jobs still hold toward the overdraft floor once chat has spent them", async () => {
    await balance(130);
    for (const id of ["run-a", "run-b", "run-c"]) await admit(id);
    expect(await outstanding()).toBeCloseTo(30, 6);
    // Chat spent 190 credits while the runs still hold 30: those will be spent too,
    // so only two more 5-credit holds fit above -100 (-60 - 30 - holds).
    await balance(-60);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => chat()));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    // The runs finish or pause: their leases are released and the floor moves back.
    await sql`update workspace_runs set status = 'completed'`;
    await sql`delete from interactive_spend_holds`;
    for (let i = 0; i < 8; i += 1) await chat();
    await expect(chat()).rejects.toMatchObject({ code: "credit_exhausted" });
  });

  it("gives orgs that never received credits no overdraft (no farming empty orgs)", async () => {
    await sql`delete from credit_grants`;
    await balance(0);
    await expect(chat()).rejects.toMatchObject({ code: "credit_exhausted" });
    await balance(3);
    await expect(chat()).resolves.toBeUndefined();
    // A reversed (refunded) grant does not count either.
    await sql`insert into credit_grants(org_id, source, external_id, credits, reversed_credits) values ('o1', 'topup', 'pi_1', 500, 500)`;
    await balance(-1);
    await expect(chat()).rejects.toMatchObject({ code: "credit_exhausted" });
  });

  it("keeps monthly budget caps as hard stops", async () => {
    await balance(5_000);
    await sql`update workspaces set budget_paused = true where id = 'w'`;
    await expect(chat()).rejects.toMatchObject({ code: "workspace_budget_paused" });
    await sql`update workspaces set budget_paused = false where id = 'w'`;
    await sql`update organizations set budget_paused = true where id = 'o1'`;
    await expect(chat()).rejects.toMatchObject({ code: "org_budget_paused" });
  });

  it("never credit-gates billing-exempt orgs", async () => {
    process.env.BILLING_EXEMPT_ORG_IDS = "o1";
    try {
      await balance(-10_000);
      await expect(chat()).resolves.toBeUndefined();
      expect(await sql`select 1 from interactive_spend_holds`).toHaveLength(0);
    } finally {
      delete process.env.BILLING_EXEMPT_ORG_IDS;
    }
  });

  it("does not let one org's holds or grants affect another org", async () => {
    await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o2', 'Other', 'other', 'u1', -50)`;
    await sql`insert into workspaces(id, org_id, user_id, name) values ('w2', 'o2', 'u1', 'W2')`;
    await balance(-50);
    for (let i = 0; i < 10; i += 1) await chat();
    await expect(chat()).rejects.toMatchObject({ code: "credit_exhausted" });
    // o2 has no grants of its own: o1's starter grant does not make it eligible.
    await expect(guard.assertCanSpend(null, "w2", { kind: "interactive" })).rejects.toMatchObject({ code: "credit_exhausted" });
    await grantOnce("o2");
    await expect(guard.assertCanSpend(null, "w2", { kind: "interactive" })).resolves.toBeUndefined();
  });

  it("a top-up pays the negative balance first", async () => {
    await balance(-80);
    await sql`select grant_org_credits('o1', 'topup', 'pi_topup', 500)`;
    const [org] = await sql<{ available: number }[]>`select available from org_available_credits('o1')`;
    expect(org!.available).toBeCloseTo(420, 6);
    await expect(admit("run-a")).resolves.toBeDefined();
  });
});
