import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, pageCredits } from "@docslurp/shared";
import type { SqlClient } from "../db.js";

/*
 * The spend-paused resume sweep weighs what the run already owes for measured pages (run_measured_pages, migration 0187),
 * the same sum the worker's page-basis check pauses on, so a run is not resumed only to re-pause at its next check.
 */
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("spend-paused resume weighs the run's measured pages (PostgreSQL)", () => {
  let sql: postgres.Sql;
  let funding: typeof import("../services/spend-paused-runs.js");
  const signals = { pause: vi.fn(async () => {}), resume: vi.fn(async () => {}) };

  beforeAll(async () => {
    vi.stubEnv("WORKER_CREDIT_LEASES", "off");
    vi.stubEnv("CHAT_CREDIT_RESERVE_CREDITS", "0");
    vi.stubEnv("CHAT_CREDIT_RESERVE_STARTER_CREDITS", "0");
    sql = postgres(url!, { max: 5, prepare: false, onnotice: () => {} });
    vi.doMock("../db.js", () => ({ sql }));
    funding = await import("../services/spend-paused-runs.js");
    await sql`insert into "user"(id,name,email) values('measured-u','Measured','measured@example.test') on conflict do nothing`;
    await sql`insert into organizations(id,name,created_by_user_id,credit_balance_cents) values('measured-o','Measured','measured-u',0) on conflict do nothing`;
    await sql`insert into projects(id,org_id,user_id,name) values('measured-p','measured-o','measured-u','Measured') on conflict do nothing`;
    await sql`insert into org_memberships(org_id,user_id,role) values('measured-o','measured-u','owner') on conflict do nothing`;
  });
  beforeEach(async () => {
    signals.resume.mockClear();
    await sql`delete from documents where run_id = 'measured-r'`;
    await sql`delete from project_run_events where run_id = 'measured-r'`;
    await sql`delete from project_runs where id = 'measured-r'`;
    await sql`insert into project_runs(id,org_id,project_id,user_id,kind,status,stage,pipeline,control_state,pause_reason,monthly_reservation_cents)
      values('measured-r','measured-o','measured-p','measured-u','upload','processing','extract-markdown',
        ${sql.json(JSON.parse(JSON.stringify(defaultPipelineFeatures)))},'paused','credit_exhausted',10)`;
    // An under-claimed PDF: admission priced 1 page, the worker measured 1,000 (not yet charged: the Fast fee bills at completion).
    await sql`insert into documents(id,org_id,project_id,user_id,run_id,filename,mime_type,source_key,status,file_size,page_count,intake_page_count,page_count_source)
      values('measured-d','measured-o','measured-p','measured-u','measured-r','m.pdf','application/pdf','raw/m','processing',1000,1000,1,'counted')`;
  });
  afterAll(async () => {
    await sql?.end();
    vi.unstubAllEnvs();
  });

  it("keeps the run paused while the balance is above zero but does not cover the measured pages it owes", async () => {
    const owed = pageCredits("fast", 999);
    expect(await funding.runMeasuredCredits(sql as unknown as SqlClient, "measured-r")).toBeCloseTo(owed);
    await sql`update organizations set credit_balance_cents = ${owed / 2} where id = 'measured-o'`;
    const outcome = await funding.resumeSpendPausedRunOutcome("measured-r", { sql: sql as unknown as SqlClient, signals });
    expect(outcome.status).toBe("blocked");
    expect(signals.resume).not.toHaveBeenCalled();
    expect((await sql`select control_state from project_runs where id = 'measured-r'`)[0]!.control_state).toBe("paused");
  });

  it("resumes once the balance covers what the run owes plus the admission reserve", async () => {
    const owed = pageCredits("fast", 999);
    await sql`update organizations set credit_balance_cents = ${owed + 10} where id = 'measured-o'`;
    const outcome = await funding.resumeSpendPausedRunOutcome("measured-r", { sql: sql as unknown as SqlClient, signals });
    expect(outcome.status).toBe("resumed");
    expect(signals.resume).toHaveBeenCalledWith("measured-r");
  });
});
