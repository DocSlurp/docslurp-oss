import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedDatabase } from "@docslurp/worker/testing";
let db: Awaited<ReturnType<typeof createMigratedDatabase>>;
beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`insert into "user" (id,name,email) values ('realtime-user','Test','realtime@example.test');
    insert into organizations(id,name,slug,created_by_user_id) values ('realtime-org','Test','realtime','realtime-user');
    insert into projects(id,org_id,user_id,name) values ('realtime-project','realtime-org','realtime-user','Test');`);
}, 60_000);
afterAll(async () => { await db?.close(); });
async function revision() {
  return (await db.query<{ revision: number }>(`select revision::int from realtime_revisions where org_id='realtime-org'`)).rows[0]!.revision;
}
describe("commit-visible realtime coverage", () => {
  it("compacts committed counter rows without changing the aggregate revision", async () => {
    const before=await revision();
    for(let i=0;i<300;i++) await db.exec("update projects set name=name where id='realtime-project'");
    expect(await revision()).toBe(before+300);
    const {rows:[row]}=await db.query<{count:number}>("select count(*)::int as count from realtime_revision_counters where org_id='realtime-org' and scope=''");
    expect(row!.count).toBeLessThanOrEqual(2);
  });
  it("rolls revisions back with a failed mutation", async () => {
    const before = await revision();
    await expect(db.transaction(async tx => {
      await tx.exec(`update projects set name='rolled back' where id='realtime-project'`);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await revision()).toBe(before);
  });
  it("coalesces repeated writes and publishes settings and deletion", async () => {
    const before = await revision();
    await db.transaction(async tx => {
      for (let i = 0; i < 100; i++) await tx.exec(`update projects set name='changed' where id='realtime-project'`);
    });
    expect(await revision()).toBe(before + 1);
    await db.exec(`insert into documents(id,user_id,org_id,project_id,filename,mime_type,source_key,status)
      values('realtime-doc','realtime-user','realtime-org','realtime-project','test.txt','text/plain','test','queued')`);
    const created = await revision();
    await db.exec(`delete from documents where id='realtime-doc'`);
    expect(await revision()).toBe(created + 1);
  });
  it("publishes run/stage changes, membership revocation and credit changes", async () => {
    await db.exec(`insert into project_runs(id,user_id,org_id,project_id,kind,status,stage)
      values ('realtime-run','realtime-user','realtime-org','realtime-project','upload','processing','extract')`);
    let before = await revision();
    await db.exec(`insert into project_run_stage_states(run_id,stage_name,status) values('realtime-run','extract','completed')`);
    expect(await revision()).toBe(before + 1);
    before = await revision();
    await db.exec(`update organizations set credit_balance_cents=100 where id='realtime-org'`);
    expect(await revision()).toBe(before + 1);
    await db.exec(`insert into org_memberships(org_id,user_id,role) values('realtime-org','realtime-user','owner') on conflict do nothing`);
    before = await revision();
    await db.exec(`delete from org_memberships where org_id='realtime-org'`);
    expect(await revision()).toBe(before + 1);
  });
  it("publishes curated/recent suggestions and page metadata only after commit", async () => {
    let before = await revision();
    await db.exec(`insert into query_suggestions(id,user_id,project_id,phrase) values('realtime-suggestion','realtime-user','realtime-project','Question')`);
    expect(await revision()).toBe(before+1);
    before = await revision();
    await db.exec(`insert into search_sessions(id,user_id,query,metadata) values('realtime-search','realtime-user','Query','{"projectId":"realtime-project"}')`);
    expect(await revision()).toBe(before+1);
    await db.exec(`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status)
      values('realtime-page-doc','realtime-user','realtime-org','realtime-project','realtime-run','test.txt','text/plain','test','processing')`);
    before = await revision();
    await db.exec(`insert into document_pages(id,document_id,run_id,user_id,page_number,text)
      values('realtime-page','realtime-page-doc','realtime-run','realtime-user',1,'text')`);
    expect(await revision()).toBe(before+1);
    before = await revision();
    await expect(db.transaction(async tx => {
      await tx.exec(`delete from query_suggestions where id='realtime-suggestion'`);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await revision()).toBe(before);
  });

  it("records project and run scopes so one project's change leaves another's revision alone", async () => {
    await db.exec(`insert into projects(id,org_id,user_id,name) values ('realtime-project-b','realtime-org','realtime-user','B') on conflict do nothing;
      insert into project_runs(id,user_id,org_id,project_id,kind,status,stage)
        values ('realtime-run-b','realtime-user','realtime-org','realtime-project-b','upload','processing','extract') on conflict do nothing`);
    const scoped = async (scope: string) => Number((await db.query<{ revision: string }>(
      `select revision::text from realtime_scope_revisions where org_id='realtime-org' and scope=$1`, [scope])).rows[0]?.revision ?? 0);
    const snapshot = async () => ({ org: await revision(), a: await scoped("project:realtime-project"), b: await scoped("project:realtime-project-b"),
      run: await scoped("run:realtime-run"), runB: await scoped("run:realtime-run-b") });
    let before = await snapshot();
    await db.exec(`update projects set name='A2' where id='realtime-project'`);
    expect(await snapshot()).toEqual({ ...before, org: before.org + 1, a: before.a + 1 });
    before = await snapshot();
    await db.exec(`insert into project_run_events(id,user_id,run_id,event_type,status) values('realtime-event','realtime-user','realtime-run','stage','processing')`);
    expect(await snapshot()).toEqual({ ...before, org: before.org + 1, a: before.a + 1, run: before.run + 1 });
    before = await snapshot();
    await db.exec(`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status)
      values('realtime-scope-doc','realtime-user','realtime-org','realtime-project-b','realtime-run-b','b.txt','text/plain','k','processing')`);
    await db.exec(`insert into document_tags(document_id,user_id,tag) values('realtime-scope-doc','realtime-user','t')`);
    expect(await snapshot()).toEqual({ ...before, org: before.org + 2, b: before.b + 2, runB: before.runB + 2 });
    // Membership changes move only the organization: the broker re-authorizes on it.
    before = await snapshot();
    await db.exec(`insert into org_memberships(org_id,user_id,role) values('realtime-org','realtime-user','owner') on conflict do nothing`);
    expect(await snapshot()).toEqual({ ...before, org: before.org + 1 });
    // Folding keeps every scope's sum.
    before = await snapshot();
    for (let i = 0; i < 300; i++) await db.exec(`update projects set name=name where id='realtime-project-b'`);
    expect(await snapshot()).toEqual({ ...before, org: before.org + 300, b: before.b + 300 });
    const { rows: [pending] } = await db.query<{ count: number }>(`select count(*)::int as count from realtime_revision_counters where org_id='realtime-org' and transaction_id<>0`);
    expect(pending!.count).toBeLessThanOrEqual(4);
  });
  it("sends the immediate search_eligibility hint when a document leaves search, and not when one arrives", async () => {
    const hints: string[] = [];
    const unlisten = await db.listen("search_eligibility", (payload) => { hints.push(payload); });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    try {
      await db.exec(`insert into documents(id,user_id,org_id,project_id,run_id,filename,mime_type,source_key,status)
        values('hint-doc','realtime-user','realtime-org','realtime-project','realtime-run','h.txt','text/plain','k','processing')`);
      await db.exec(`update documents set status='completed', page_count=3 where id='hint-doc'`);
      await db.exec(`update documents set lexical_searchable_at=now() where id='hint-doc'`);
      await settle();
      expect(hints).toEqual([]);
      const withdrawn = `{"projectIds" : ["realtime-project"]}`;
      for (const statement of [
        `update documents set superseded_at=now() where id='hint-doc'`,
        `update documents set superseded_at=null, status='pii_blocked' where id='hint-doc'`,
        `update documents set status='completed' where id='hint-doc'`,
        `update documents set status='processing' where id='hint-doc'`,
        `update project_runs set status='processing', control_state=null where id='realtime-run'`,
        `update project_runs set control_state='cancel_requested' where id='realtime-run'`,
        `delete from documents where id='hint-doc'`,
      ]) {
        hints.length = 0;
        await db.exec(statement);
        await settle();
        // The status='completed' step is an arrival; the run update to processing keeps it live.
        if (statement.includes("status='completed'") || statement.includes("control_state=null")) expect(hints, statement).toEqual([]);
        else expect(hints.map((hint) => JSON.parse(hint)), statement).toEqual([JSON.parse(withdrawn)]);
      }
    } finally { await unlisten(); }
  });
});
