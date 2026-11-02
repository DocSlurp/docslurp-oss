import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

// Only point this at a disposable database built with server/db/migrate.mjs.
const databaseUrl = process.env.RUN_ADMISSION_TEST_DATABASE_URL;
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let guard: typeof import("../services/billing/spend-guard.js");
let failure: "none" | "throw-after-write" | "null" | "refused" | "zero" | "nan" | "negative" = "none";

beforeAll(async () => {
  const pg = databaseUrl ? null : await startMigratedPostgres();
  stop = pg?.stop ?? (async () => {});
  sql = postgres(databaseUrl ?? pg!.url, { max: databaseUrl ? 2 : 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/worker-fleet.js", () => ({ fleetSupportsNow: () => true, taskQueueForOrgKey: () => ({ taskQueue: "test" }) }));
  vi.doMock("../services/billing/credit-leases.js", async () => {
    const actual = await vi.importActual<typeof import("../services/billing/credit-leases.js")>("../services/billing/credit-leases.js");
    return { ...actual, grantRunCreditLease: async (...args: Parameters<typeof actual.grantRunCreditLease>) => {
      // Write a real lease first: every rejection must roll it back along with
      // the run, including a fault after the grant has changed the database.
      const grant = await actual.grantRunCreditLease(...args);
      if (failure === "throw-after-write") throw new Error("injected lease write failure");
      if (failure === "null") return null;
      if (failure !== "none") return { ...grant!, blockReason: failure === "refused" ? "credit_exhausted" : null,
        remaining: failure === "zero" ? 0 : failure === "nan" ? Number.NaN : failure === "negative" ? -1 : grant!.remaining };
      return grant;
    } };
  });
  await sql`insert into "user"(id, name, email) values ('admission-user', 'Admission', 'admission@example.com') on conflict (id) do nothing`;
  guard = await import("../services/billing/spend-guard.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  failure = "none";
  vi.stubEnv("WORKER_CREDIT_LEASES", "on");
  vi.stubEnv("WORKER_CREDIT_LEASE_FRACTION", "1");
  await sql`delete from workspace_runs where workspace_id in ('admission-w1', 'admission-w2')`;
  await sql`delete from workspaces where id in ('admission-w1', 'admission-w2')`;
  await sql`delete from credit_leases where org_id = 'admission-org'`;
  await sql`delete from organizations where id = 'admission-org'`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents)
    values ('admission-org', 'Admission', 'admission', 'admission-user', 1000)`;
  await sql`insert into workspaces(id, org_id, user_id, name) values
    ('admission-w1', 'admission-org', 'admission-user', 'One'), ('admission-w2', 'admission-org', 'admission-user', 'Two')`;
});

function admit(runId: string, speedBoost = true, workspaceId = "admission-w1") {
  return guard.admitRunSpend("admission-org", workspaceId, tx => tx`
    insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
    values (${runId}, 'admission-org', 'admission-user', ${workspaceId}, 'upload', 'queued', 'queued', ${tx.json({ speedBoost })})
    returning id
  `, { leaseRunId: runId, speedBoost });
}

describe("mandatory run admission leases", () => {
  it.each([undefined, "", "   "])("rejects boosted admission without a lease owner (%s) before its callback", async leaseRunId => {
    const callback = vi.fn(async () => undefined);
    await expect(guard.admitRunSpend("admission-org", "admission-w1", callback, { speedBoost: true, leaseRunId }))
      .rejects.toThrow("requires a lease run ID");
    expect(callback).not.toHaveBeenCalled();
    expect(await sql`select id from workspace_runs where org_id = 'admission-org'`).toHaveLength(0);
  });

  it.each([false, true])("commits a usable lease for speedBoost=%s", async speedBoost => {
    await admit("usable", speedBoost);
    const [lease] = await sql`select granted from credit_leases where holder_id = 'usable' and status = 'active'`;
    expect(Number(lease!.granted)).toBe(speedBoost ? 40 : 10);
  });

  it.each(["throw-after-write", "null", "refused", "zero", "nan", "negative"] as const)("rolls back run and lease on %s", async mode => {
    failure = mode;
    await expect(admit("refused")).rejects.toThrow(mode === "throw-after-write" ? "injected lease write failure" : "usable credit lease");
    expect(await sql`select id from workspace_runs where org_id = 'admission-org'`).toHaveLength(0);
    expect(await sql`select id from credit_leases where org_id = 'admission-org'`).toHaveLength(0);
  });

  it.skipIf(!databaseUrl)("serializes boosted admissions across workspaces on the same limited balance", async () => {
    await sql`update organizations set credit_balance_cents = 105 where id = 'admission-org'`;
    const results = await Promise.allSettled([admit("race-a", true, "admission-w1"), admit("race-b", true, "admission-w2")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "credit_exhausted" } });
    expect(await sql`select id from workspace_runs where org_id = 'admission-org' and status = 'queued'`).toHaveLength(1);
    const [lease] = await sql`select granted from credit_leases where org_id = 'admission-org' and status = 'active'`;
    expect(Number(lease!.granted)).toBe(5);
    const [outstanding] = await sql`select org_outstanding_credit_leases('admission-org') as credits`;
    expect(Number(outstanding!.credits)).toBe(5);
  });
});
