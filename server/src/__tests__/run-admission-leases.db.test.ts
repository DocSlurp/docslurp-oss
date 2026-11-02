import postgres from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
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
  vi.doMock("../services/organizations.js", async () => ({
    ...await vi.importActual<object>("../services/organizations.js"),
    listAccessibleWorkspaceIds: async () => ["admission-w1", "admission-w2"],
    getWorkspaceAccess: async () => ({}),
    canContributeToWorkspace: () => true,
  }));
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

describe("transactional readmission", () => {
  async function readmit(id: string, callback = async (_tx: postgres.TransactionSql) => "restarted") {
    return guard.admitRunSpend("admission-org", "admission-w1", callback,
      { leaseRunId: id, speedBoost: true, readmission: true });
  }

  it("reuses its own valid lease when another boosted minimum would be refused", async () => {
    await sql`update organizations set credit_balance_cents=105 where id='admission-org'`;
    await admit("own");
    await expect(readmit("own")).resolves.toBe("restarted");
    expect(await sql`select id from credit_leases where holder_id='own'`).toHaveLength(1);
  });

  it("does not borrow an expired lease or another workspace's lease", async () => {
    await sql`update organizations set credit_balance_cents=105 where id='admission-org'`;
    await admit("own");
    await sql`update credit_leases set expires_at=now()-interval '1 minute' where holder_id='own'`;
    await sql`update organizations set credit_balance_cents=100 where id='admission-org'`;
    await expect(readmit("own")).rejects.toMatchObject({ code: "credit_exhausted" });
    const callback = vi.fn(async () => "bad");
    await expect(guard.admitRunSpend("wrong-org", "admission-w1", callback,
      { leaseRunId: "own", speedBoost: true, readmission: true })).rejects.toMatchObject({code:"plan_not_entitled"});
    await expect(guard.admitRunSpend("admission-org", "admission-w2", callback,
      { leaseRunId: "own", speedBoost: true, readmission: true })).rejects.toMatchObject({code:"plan_not_entitled"});
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["retry", "recover", "resume"])("evaluates real lifecycle %s eligibility before exhausted credits", async action => {
    const { createRunLifecycle } = await import("../services/run-lifecycle.js");
    const publish = vi.fn();
    const lifecycle = createRunLifecycle({ sql, startWorkflow: publish, failureThreshold: 3,
      signals: { resume: publish, cancel: publish, pause: publish } });
    await admit("noop");
    await sql`update workspace_runs set status='completed', control_state=null where id='noop'`;
    await sql`delete from credit_leases where holder_id='noop'`;
    await sql`update organizations set credit_balance_cents=0 where id='admission-org'`;
    const unchanged = Symbol("unchanged");
    const run = {id:"noop",status:"completed" as const,priority:0,controlState:null,error:null,pipeline:defaultPipelineFeatures};
    await expect(readmit("noop", async tx => {
      const result = action === "retry" ? await lifecycle.prepareRetry(run, tx)
        : await lifecycle.control(run, {action: action as "recover" | "resume"}, tx);
      if (result === "not-retryable" || result === null) throw unchanged;
      return "changed";
    })).rejects.toBe(unchanged);
    expect(publish).not.toHaveBeenCalled();
    expect(await sql`select id from credit_leases where holder_id='noop'`).toHaveLength(0);
    expect((await sql`select status from workspace_runs where id='noop'`)[0]?.status).toBe("completed");
  });

  it.skipIf(!databaseUrl)("serializes mixed admissions without releasing another run's credits", async () => {
    await sql`update organizations set credit_balance_cents=112 where id='admission-org'`;
    await admit("base", false);
    const before = await sql`select granted,consumed from credit_leases where holder_id='base'`;
    const outcomes = await Promise.allSettled([admit("boost-a"), admit("boost-b"), admit("base-b", false)]);
    const [held] = await sql`select org_outstanding_credit_leases('admission-org') as amount`;
    expect(Number(held!.amount)).toBeLessThanOrEqual(12);
    expect(await sql`select granted,consumed from credit_leases where holder_id='base'`).toEqual(before);
    expect(outcomes.some(result => result.status === "rejected")).toBe(true);
    await expect(guard.admitRunSpend("admission-org", "admission-w1", async () => "ok",
      { leaseRunId: "base", speedBoost: false, readmission: true })).resolves.toBe("ok");
  });

  it("rolls readmission back when a lease grant is refused", async () => {
    await admit("refused-existing");
    failure = "refused";
    await expect(readmit("refused-existing", async tx => {
      await tx`update workspace_runs set status='processing' where id='refused-existing'`;
      return "changed";
    })).rejects.toMatchObject({code:"credit_exhausted"});
    expect((await sql`select status from workspace_runs where id='refused-existing'`)[0]?.status).toBe("queued");
  });

  it.each(["retry", "recover", "resume"])("runs.ts %s is a no-op at zero credit without mocking admission", async action => {
    await admit("service-noop");
    await sql`update workspace_runs set status=${action === 'resume' ? 'processing' : 'completed'},control_state=null where id='service-noop'`;
    await sql`delete from credit_leases where holder_id='service-noop'`;
    await sql`update organizations set credit_balance_cents=0 where id='admission-org'`;
    const { retryRun, controlRun } = await import("../services/runs.js");
    if (action === "retry") {
      expect((await retryRun("service-noop", "admission-user"))?.outcome.status).toBe("not-retryable");
    } else {
      expect((await controlRun("service-noop", "admission-user", {action: action as "recover" | "resume"}))?.status).toBe(action === "resume" ? "processing" : "completed");
    }
    expect(await sql`select id from credit_leases where holder_id='service-noop'`).toHaveLength(0);
  });

  it("rolls lifecycle mutations back on actual spend refusal", async () => {
    await admit("rollback");
    await sql`delete from credit_leases where holder_id='rollback'`;
    await sql`update organizations set credit_balance_cents=0 where id='admission-org'`;
    await expect(readmit("rollback", async tx => {
      await tx`update workspace_runs set status='processing' where id='rollback'`;
      return "changed";
    })).rejects.toMatchObject({code:"credit_exhausted"});
    expect((await sql`select status from workspace_runs where id='rollback'`)[0]?.status).toBe("queued");
  });
});
