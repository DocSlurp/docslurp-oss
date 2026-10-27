import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * App side of credit leases (migration 0052) against a migrated database: the
 * first lease at run admission, lease-aware spend resumes, assertCanSpend
 * seeing leased credits, and the expiry sweep.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let guard: typeof import("../services/billing/spend-guard.js");
let paused: typeof import("../services/spend-paused-runs.js");
let leases: typeof import("../services/billing/credit-leases.js");

const signals = { pause: vi.fn(async () => undefined), resume: vi.fn(async () => undefined) };

beforeAll(async () => {
  process.env.WORKER_CREDIT_LEASES = "on";
  // Lease mechanics with no chat reserve; chat-reserve.db.test.ts covers it.
  process.env.CHAT_CREDIT_RESERVE_CREDITS = "0";
  process.env.CHAT_CREDIT_RESERVE_STARTER_CREDITS = "0";
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
  paused = await import("../services/spend-paused-runs.js");
  leases = await import("../services/billing/credit-leases.js");
}, 120_000);

afterAll(async () => {
  delete process.env.WORKER_CREDIT_LEASES;
  delete process.env.CHAT_CREDIT_RESERVE_CREDITS;
  delete process.env.CHAT_CREDIT_RESERVE_STARTER_CREDITS;
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  signals.pause.mockClear();
  signals.resume.mockClear();
  await sql`delete from workspace_run_events`;
  await sql`delete from workspace_runs`;
  await sql`delete from credit_leases`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents) values ('o1', 'Org', 'org', 'u1', 0.6)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W')`;
});

async function admit(id: string) {
  return await guard.admitRunSpend("o1", "w", (tx) => tx`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values (${id}, 'o1', 'u1', 'w', 'bulk-upload', 'queued', 'queued', '{}')
    returning id
  `, { leaseRunId: id });
}

const outstanding = async () =>
  Number((await sql<{ total: number }[]>`select org_outstanding_credit_leases('o1') as total`)[0]!.total);

describe("credit leases (app)", () => {
  it("grants the first lease at admission, so a second admission on the same balance is refused", async () => {
    await admit("run-a");
    expect(await outstanding()).toBeCloseTo(0.5, 9);
    // 0.1 credits left unleased: still admitted (spendable > 0) and gets the rest.
    await admit("run-b");
    expect(await outstanding()).toBeCloseTo(0.6, 9);
    const error = await admit("run-c").catch((caught: unknown) => caught);
    expect(guard.isSpendBlockedError(error)).toBe(true);
    // Chat/search admission (assertCanSpend) sees the leased credits too.
    await expect(guard.assertCanSpend("o1", "w")).rejects.toMatchObject({ code: "credit_exhausted" });
  });

  it("resumes a spend-paused run only when it gets a lease, and sweeps one org on notification", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, control_state, pause_reason)
      values ('p1', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'vision-extract', '{}', 'paused', 'credit_exhausted'),
             ('p2', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'vision-extract', '{}', 'paused', 'credit_exhausted')`;
    await sql`update organizations set credit_balance_cents = 0.5 where id = 'o1'`;
    const result = await paused.sweepSpendPausedRuns({ sql: sql as never, signals, orgId: "o1" });
    // The first run takes the 0.5 credits; the second finds nothing free and stays paused.
    expect(result.resumed).toBe(1);
    const rows = await sql<{ id: string; control_state: string | null; pause_reason: string | null }[]>`
      select id, control_state, pause_reason from workspace_runs order by id`;
    expect(rows).toEqual([
      { id: "p1", control_state: null, pause_reason: null },
      { id: "p2", control_state: "paused", pause_reason: "credit_exhausted" },
    ]);
    expect(signals.resume).toHaveBeenCalledTimes(1);
    expect(await outstanding()).toBeCloseTo(0.5, 9);
    // A manual resume of the still-blocked run is refused, not passed to the operator resume.
    expect(await paused.resumeSpendPausedRunOutcome("p2", { sql: sql as never, signals }))
      .toEqual({ status: "blocked", reason: "credit_exhausted" });
    expect((await sql<{ control_state: string }[]>`select control_state from workspace_runs where id = 'p2'`)[0]!.control_state).toBe("paused");
    // Another org's sweep never touches this org's runs.
    expect(await paused.sweepSpendPausedRuns({ sql: sql as never, signals, orgId: "other" })).toEqual({ resumed: 0, stillBlocked: 0 });
  });

  it("keeps the durable pause and lease unchanged after failed resume delivery, then retries once", async () => {
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, control_state, pause_reason)
      values ('delivery', 'o1', 'u1', 'w', 'bulk-upload', 'processing', 'vision-extract', '{}', 'paused', 'credit_exhausted')`;
    signals.resume.mockRejectedValueOnce(new Error("Temporal unavailable"));
    expect(await paused.resumeSpendPausedRunOutcome("delivery", { sql: sql as never, signals })).toEqual({ status: "deferred" });
    expect((await sql`select control_state, pause_reason from workspace_runs where id = 'delivery'`)[0]).toMatchObject({ control_state: "paused", pause_reason: "credit_exhausted" });
    expect(await outstanding()).toBe(0);
    expect(await sql`select id from workspace_run_events where run_id = 'delivery'`).toHaveLength(0);
    expect(await paused.resumeSpendPausedRunOutcome("delivery", { sql: sql as never, signals })).toEqual({ status: "resumed" });
    expect(await paused.resumeSpendPausedRunOutcome("delivery", { sql: sql as never, signals })).toEqual({ status: "not-spend-paused" });
    expect(signals.resume).toHaveBeenCalledTimes(2);
    expect(await sql`select id from workspace_run_events where run_id = 'delivery'`).toHaveLength(1);
  });

  it("parses org_spend_changed payloads defensively", () => {
    expect(paused.orgIdFromSpendChangedPayload(JSON.stringify({ orgId: "o1", reason: "org" }))).toBe("o1");
    expect(paused.orgIdFromSpendChangedPayload("not json")).toBeNull();
    expect(paused.orgIdFromSpendChangedPayload(JSON.stringify({ orgId: 5 }))).toBeNull();
  });

  it("expires leases past their TTL and drops old settled rows", async () => {
    await admit("run-a");
    await sql`update credit_leases set expires_at = now() - interval '1 second'`;
    expect(await outstanding()).toBe(0);
    expect(await leases.sweepExpiredCreditLeases({ sql: sql as never })).toEqual({ orgs: 1, deleted: 0 });
    await sql`update credit_leases set updated_at = now() - interval '8 days'`;
    expect(await leases.sweepExpiredCreditLeases({ sql: sql as never })).toEqual({ orgs: 0, deleted: 1 });
  });

  it("keeps the per-run reservation when leases are off", async () => {
    process.env.WORKER_CREDIT_LEASES = "off";
    try {
      await admit("run-a");
      expect(await sql`select 1 from credit_leases`).toHaveLength(0);
      // Reservation of 1 credit per in-flight run: 0.6 available, so the next run is refused.
      await expect(admit("run-b")).rejects.toMatchObject({ code: "credit_exhausted" });
    } finally {
      process.env.WORKER_CREDIT_LEASES = "on";
    }
  });
});
