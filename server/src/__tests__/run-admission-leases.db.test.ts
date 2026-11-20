import postgres from "postgres";
import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

// Only point this at a disposable database built with server/db/migrate.mjs.
const databaseUrl = process.env.TEST_DATABASE_URL;
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let guard: typeof import("../services/billing/spend-guard.js");
let admission: typeof import("../services/run-admission.js");
let failure: "none" | "throw-after-write" | "null" | "refused" | "zero" | "nan" | "negative" = "none";

beforeAll(async () => {
  const pg = databaseUrl ? null : await startMigratedPostgres();
  stop = pg?.stop ?? (async () => {});
  sql = postgres(databaseUrl ?? pg!.url, { max: databaseUrl ? 2 : 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/organizations.js", async () => ({
    ...await vi.importActual<object>("../services/organizations.js"),
    listAccessibleProjectIds: async () => ["admission-w1", "admission-w2"],
    getProjectAccess: async () => ({}),
    canContributeToProject: () => true,
    // Retry spends credits and needs edit access (council L3); this suite tests admission, not who may retry.
    canEditProject: () => true,
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
  admission = await import("../services/run-admission.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  failure = "none";
  vi.stubEnv("WORKER_CREDIT_LEASES", "on");
  vi.stubEnv("WORKER_CREDIT_LEASE_FRACTION", "1");
  await sql`delete from project_runs where project_id in ('admission-w1', 'admission-w2')`;
  await sql`delete from projects where id in ('admission-w1', 'admission-w2')`;
  await sql`delete from credit_leases where org_id = 'admission-org'`;
  await sql`delete from organizations where id = 'admission-org'`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, credit_balance_cents)
    values ('admission-org', 'Admission', 'admission', 'admission-user', 1000)`;
  await sql`insert into projects(id, org_id, user_id, name) values
    ('admission-w1', 'admission-org', 'admission-user', 'One'), ('admission-w2', 'admission-org', 'admission-user', 'Two')`;
  // getRun checks project access in SQL (docslurp_project_access): the user owns the organization.
  await sql`insert into org_memberships(org_id, user_id, role) values ('admission-org', 'admission-user', 'owner') on conflict do nothing`;
});

function admit(runId: string, speedBoost = true, projectId = "admission-w1") {
  return admission.admitRunSpend("admission-org", projectId, async tx => {
    const rows = await tx`
      insert into project_runs(monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline)
      values (100, ${runId}, 'admission-org', 'admission-user', ${projectId}, 'upload', 'queued', 'queued', ${tx.json({ speedBoost })})
      returning id`;
    await tx`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status,file_size)
      values(${runId},'admission-org','admission-user',${projectId},${runId},'fixture.txt','text/plain','synthetic','queued',1000)`;
    return rows;
  }, { leaseRunId: runId, speedBoost });
}

// Admission mechanics below are sized for a $1 starter chat reserve (the default is lower).
beforeEach(() => { vi.stubEnv("CHAT_CREDIT_RESERVE_STARTER_CREDITS", "100"); });

describe("mandatory run admission leases", () => {
  it.each([undefined, "", "   "])("rejects boosted admission without a lease owner (%s) before its callback", async leaseRunId => {
    const callback = vi.fn(async () => undefined);
    await expect(admission.admitRunSpend("admission-org", "admission-w1", callback, { speedBoost: true, leaseRunId }))
      .rejects.toThrow("requires a lease run ID");
    expect(callback).not.toHaveBeenCalled();
    expect(await sql`select id from project_runs where org_id = 'admission-org'`).toHaveLength(0);
  });

  it.each([false, true])("commits a usable lease for speedBoost=%s", async speedBoost => {
    await admit("usable", speedBoost);
    const [lease] = await sql`select granted from credit_leases where holder_id = 'usable' and status = 'active'`;
    expect(Number(lease!.granted)).toBe(speedBoost ? 40 : 10);
  });

  it.each(["throw-after-write", "null", "refused", "zero", "nan", "negative"] as const)("rolls back run and lease on %s", async mode => {
    failure = mode;
    await expect(admit("refused")).rejects.toThrow(mode === "throw-after-write" ? "injected lease write failure" : "usable credit lease");
    expect(await sql`select id from project_runs where org_id = 'admission-org'`).toHaveLength(0);
    expect(await sql`select id from credit_leases where org_id = 'admission-org'`).toHaveLength(0);
  });

  it.skipIf(!databaseUrl)("serializes boosted admissions across projects on the same limited balance", async () => {
    await sql`update organizations set credit_balance_cents = 105 where id = 'admission-org'`;
    const results = await Promise.allSettled([admit("race-a", true, "admission-w1"), admit("race-b", true, "admission-w2")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "credit_exhausted" } });
    expect(await sql`select id from project_runs where org_id = 'admission-org' and status = 'queued'`).toHaveLength(1);
    const [lease] = await sql`select granted from credit_leases where org_id = 'admission-org' and status = 'active'`;
    expect(Number(lease!.granted)).toBe(5);
    const [outstanding] = await sql`select org_outstanding_credit_leases('admission-org') as credits`;
    expect(Number(outstanding!.credits)).toBe(5);
  });
});

describe("transactional readmission", () => {
  async function readmit(id: string, callback = async (_tx: postgres.TransactionSql) => "restarted") {
    return admission.admitRunSpend("admission-org", "admission-w1", callback,
      { leaseRunId: id, speedBoost: true, readmission: true });
  }

  it("reuses its own valid lease when another boosted minimum would be refused", async () => {
    await sql`update organizations set credit_balance_cents=105 where id='admission-org'`;
    await admit("own");
    await expect(readmit("own")).resolves.toBe("restarted");
    expect(await sql`select id from credit_leases where holder_id='own'`).toHaveLength(1);
  });

  it("does not borrow an expired lease or another project's lease", async () => {
    await sql`update organizations set credit_balance_cents=105 where id='admission-org'`;
    await admit("own");
    await sql`update credit_leases set expires_at=now()-interval '1 minute' where holder_id='own'`;
    await sql`update organizations set credit_balance_cents=100 where id='admission-org'`;
    await expect(readmit("own")).rejects.toMatchObject({ code: "credit_exhausted" });
    const callback = vi.fn(async () => "bad");
    await expect(admission.admitRunSpend("wrong-org", "admission-w1", callback,
      { leaseRunId: "own", speedBoost: true, readmission: true })).rejects.toMatchObject({code:"plan_not_entitled"});
    await expect(admission.admitRunSpend("admission-org", "admission-w2", callback,
      { leaseRunId: "own", speedBoost: true, readmission: true })).rejects.toMatchObject({code:"plan_not_entitled"});
    expect(callback).not.toHaveBeenCalled();
  });

  it.each(["retry", "recover", "resume"])("evaluates real lifecycle %s eligibility before exhausted credits", async action => {
    const { createRunLifecycle } = await import("../services/run-lifecycle.js");
    const publish = vi.fn();
    const lifecycle = createRunLifecycle({ sql, startWorkflow: publish, failureThreshold: 3,
      signals: { resume: publish, cancel: publish, pause: publish } });
    await admit("noop");
    await sql`update project_runs set status='completed', control_state=null where id='noop'`;
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
    expect((await sql`select status from project_runs where id='noop'`)[0]?.status).toBe("completed");
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
    await expect(admission.admitRunSpend("admission-org", "admission-w1", async () => "ok",
      { leaseRunId: "base", speedBoost: false, readmission: true })).resolves.toBe("ok");
  });

  it("rolls readmission back when a lease grant is refused", async () => {
    await admit("refused-existing");
    failure = "refused";
    await expect(readmit("refused-existing", async tx => {
      await tx`update project_runs set status='processing' where id='refused-existing'`;
      return "changed";
    })).rejects.toMatchObject({code:"credit_exhausted"});
    expect((await sql`select status from project_runs where id='refused-existing'`)[0]?.status).toBe("queued");
  });

  it.each(["retry", "recover", "resume"])("runs.ts %s is a no-op at zero credit without mocking admission", async action => {
    await admit("service-noop");
    await sql`update project_runs set status=${action === 'resume' ? 'processing' : 'completed'},control_state=null where id='service-noop'`;
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
      await tx`update project_runs set status='processing' where id='rollback'`;
      return "changed";
    })).rejects.toMatchObject({code:"credit_exhausted"});
    expect((await sql`select status from project_runs where id='rollback'`)[0]?.status).toBe("queued");
  });
});

describe("runs admitted inside the caller's transaction", () => {
  const scope = (runId: string, projectId = "admission-w1") => ({ runId, orgId: "admission-org", projectId, speedBoost: true });
  const insertRun = (tx: postgres.TransactionSql, runId: string, blockedReason: string | null, projectId = "admission-w1") => tx`
    insert into project_runs(monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, blocked_reason, stage, pipeline)
    values (100, ${runId}, 'admission-org', 'admission-user', ${projectId}, 'reindex', ${blockedReason ? "blocked" : "queued"},
      ${blockedReason}, 'queued', ${tx.json({ speedBoost: true })})`;
  const inTransaction = (runId: string, refusal: "throw" | "block", projectId = "admission-w1") =>
    sql.begin(tx => admission.admitRunInTransaction(tx, scope(runId, projectId), reason => insertRun(tx, runId, reason, projectId), { refusal }));
  const runStatus = async (runId: string) => (await sql`select status, blocked_reason from project_runs where id = ${runId}`)[0];
  const leases = (runId: string) => sql`select id from credit_leases where holder_id = ${runId}`;

  it("queues a run with its own lease", async () => {
    await expect(inTransaction("tx-ok", "throw")).resolves.toMatchObject({ blockedReason: null });
    expect(await runStatus("tx-ok")).toMatchObject({ status: "queued" });
    expect(await leases("tx-ok")).toHaveLength(1);
  });

  it("refuses by throwing before the run is created, or by saving it blocked", async () => {
    await sql`update organizations set credit_balance_cents = 100 where id = 'admission-org'`;
    const create = vi.fn(async () => undefined);
    await expect(sql.begin(tx => admission.admitRunInTransaction(tx, scope("tx-throw"), create, { refusal: "throw" })))
      .rejects.toMatchObject({ code: "credit_exhausted" });
    expect(create).not.toHaveBeenCalled();
    await expect(inTransaction("tx-block", "block")).resolves.toMatchObject({ blockedReason: "credits" });
    expect(await runStatus("tx-block")).toMatchObject({ status: "blocked", blocked_reason: "credits" });
    expect(await leases("tx-block")).toHaveLength(0);
  });

  it("reads no spend when the whole job is already blocked", async () => {
    await expect(sql.begin(tx => admission.admitRunInTransaction(tx, scope("tx-job"), reason => insertRun(tx, "tx-job", reason),
      { refusal: "block", blockedReason: "budget" }))).resolves.toMatchObject({ blockedReason: "budget" });
    expect(await runStatus("tx-job")).toMatchObject({ status: "blocked", blocked_reason: "budget" });
    expect(await leases("tx-job")).toHaveLength(0);
  });

  it("never leaves a queued run whose lease was refused", async () => {
    failure = "refused";
    await expect(inTransaction("tx-lease-block", "block")).resolves.toMatchObject({ blockedReason: "credits" });
    expect(await runStatus("tx-lease-block")).toMatchObject({ status: "blocked", blocked_reason: "credits" });
    expect(await leases("tx-lease-block")).toHaveLength(0);
    await expect(inTransaction("tx-lease-throw", "throw")).rejects.toThrow("usable credit lease");
    expect(await runStatus("tx-lease-throw")).toBeUndefined();
    expect(await leases("tx-lease-throw")).toHaveLength(0);
  });

  it("refuses a project of another organization and creates nothing", async () => {
    const create = vi.fn(async () => undefined);
    await expect(sql.begin(tx => admission.admitRunInTransaction(tx, { ...scope("tx-foreign"), orgId: "wrong-org" }, create, { refusal: "throw" })))
      .rejects.toMatchObject({ code: "plan_not_entitled" });
    expect(create).not.toHaveBeenCalled();
  });

  it.skipIf(!databaseUrl)("admits one of two concurrent transactions on a balance that covers one", async () => {
    await sql`update organizations set credit_balance_cents = 105 where id = 'admission-org'`;
    const results = await Promise.allSettled([inTransaction("tx-race-a", "throw", "admission-w1"), inTransaction("tx-race-b", "throw", "admission-w2")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "credit_exhausted" } });
    expect(await sql`select id from project_runs where org_id = 'admission-org' and status = 'queued'`).toHaveLength(1);
    const [outstanding] = await sql`select org_outstanding_credit_leases('admission-org') as credits`;
    expect(Number(outstanding!.credits)).toBe(5);
  });
});

describe("blocked runs", () => {
  const blocked = async (id: string) => {
    await sql`insert into project_runs(monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, blocked_reason, stage, pipeline)
      values (100, ${id}, 'admission-org', 'admission-user', 'admission-w1', 'reindex', 'blocked', 'credits', 'queued', ${sql.json({ speedBoost: true })})`;
    return { id, orgId: "admission-org", projectId: "admission-w1", speedBoost: true };
  };
  const status = async (id: string) => (await sql`select status from project_runs where id = ${id}`)[0]?.status;

  it("queues a blocked run with its lease once the organization may spend", async () => {
    const run = await blocked("blocked-ok");
    await expect(admission.admitBlockedRun(sql as never, run)).resolves.toBe(true);
    expect(await status("blocked-ok")).toBe("queued");
    expect(await sql`select id from credit_leases where holder_id = 'blocked-ok' and status = 'active'`).toHaveLength(1);
  });

  it("leaves the run blocked when spend or its lease is refused", async () => {
    const run = await blocked("blocked-refused");
    failure = "refused";
    await expect(admission.admitBlockedRun(sql as never, run)).resolves.toBe(false);
    failure = "none";
    await sql`update organizations set credit_balance_cents = 100 where id = 'admission-org'`;
    await expect(admission.admitBlockedRun(sql as never, run)).resolves.toBe(false);
    expect(await status("blocked-refused")).toBe("blocked");
    expect(await sql`select id from credit_leases where holder_id = 'blocked-refused'`).toHaveLength(0);
  });

  it("never queues a run named under another organization or project", async () => {
    const run = await blocked("blocked-foreign");
    await expect(admission.admitBlockedRun(sql as never, { ...run, orgId: "wrong-org" })).resolves.toBe(false);
    await expect(admission.admitBlockedRun(sql as never, { ...run, projectId: "admission-w2" })).resolves.toBe(false);
    expect(await status("blocked-foreign")).toBe("blocked");
    expect(await sql`select id from credit_leases where holder_id = 'blocked-foreign'`).toHaveLength(0);
  });
});

describe("on-demand page runs", () => {
  it("inserts under the interactive rule and refuses a project outside the organization", async () => {
    const insert = vi.fn(async () => "inserted");
    await expect(sql.begin(tx => admission.admitOnDemandRun(tx, { orgId: "admission-org", projectId: "admission-w1" }, insert))).resolves.toBe("inserted");
    insert.mockClear();
    await expect(sql.begin(tx => admission.admitOnDemandRun(tx, { orgId: "wrong-org", projectId: "admission-w1" }, insert)))
      .rejects.toMatchObject({ code: "plan_not_entitled" });
    await expect(sql.begin(tx => admission.admitOnDemandRun(tx, { orgId: "admission-org", projectId: "not-a-project" }, insert)))
      .rejects.toMatchObject({ code: "plan_not_entitled" });
    expect(insert).not.toHaveBeenCalled();
  });
});
