import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { reconcileRoleGrants } from "../../db/roles.mjs";

let sql: ReturnType<typeof postgres>, stop: () => Promise<void>;
beforeAll(async () => {
  const db = await startMigratedPostgres(); stop = db.stop;
  sql = postgres(db.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id,name,email) values ('u','U','u@cohort.test'), ('v','V','v@cohort.test')`;
  await sql`insert into organizations(id,name,slug,created_by_user_id) values ('o','O','cohort-o','u'), ('other','Other','cohort-other','v')`;
  await sql`insert into org_memberships(org_id,user_id,role) values ('o','u','owner'), ('other','v','owner')`;
  await sql`insert into projects(id,org_id,user_id,name) values ('p','o','u','P'), ('q','o','u','Q'), ('z','other','v','Z')`;
  await sql`insert into api_keys(id,org_id,user_id,key_hash,name,scopes,project_ids) values ('k','o','u','hash-k','K',array['ingest'],array['p'])`;
  for (const [id, origin, stats] of [['r','machine',{apiKeyId:'k'}], ['app','app',{}], ['legacy','machine',{}]] as const) {
    await sql`insert into project_runs(monthly_reservation_cents,id,org_id,user_id,project_id,kind,status,stage,pipeline,origin,stats,execution_generation,creation_source_keys)
      values (100,${id},'o','u','p','bulk-upload','processing','extract','{}',${origin},${sql.json(stats)},'g',array['source'])`;
    await sql`insert into documents(id,org_id,user_id,project_id,run_id,filename,mime_type,source_key,status)
      values (${`d-${id}`},'o','u','p',${id},'a.png','image/png',${`source-${id}`},'processing')`;
  }
  await sql.unsafe("create role docslurp_app nologin; create role docslurp_worker nologin");
  await reconcileRoleGrants({ query: async (statement: string, params: unknown[] = []) => ({ rows: await sql.unsafe(statement, params as postgres.ParameterOrJSON<never>[]) }) }, { log: () => {} });
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

const grant = async (run = 'r', org = 'o', project = 'p', document = `d-${run}`, generation: string | null = 'g') =>
  sql`select * from public.authorize_compute_cohort(${org},${project},${run},${document},${generation})`;

it('authorizes only current, scoped principals and fences stale generations', async () => {
  const [first] = await grant();
  expect(first.cohort_id).toMatch(/^[a-f0-9]{64}$/);
  expect(new Date(first.valid_until).getTime() - Date.now()).toBeLessThanOrEqual(10000);
  for (const args of [['r','other','p','d-r','g'], ['r','o','q','d-r','g'], ['r','o','p','d-app','g'], ['r','o','p','d-r','old']] as const) {
    expect(await grant(...args)).toHaveLength(0);
  }
  await sql`update api_keys set key_type = 'client' where id = 'k'`;
  expect(await grant()).toHaveLength(0);
  await sql`update api_keys set key_type = 'server' where id = 'k'`;
  await sql`update api_keys set revoked_at = now() where id = 'k'`;
  expect(await grant()).toHaveLength(0);
  await sql`update api_keys set revoked_at = null, expires_at = now() - interval '1 second' where id = 'k'`;
  expect(await grant()).toHaveLength(0);
  await sql`update api_keys set expires_at = null, scopes = array['search:deep'] where id = 'k'`;
  expect(await grant()).toHaveLength(0);
  await sql`update api_keys set scopes = array['ingest'], project_ids = array['q'] where id = 'k'`;
  expect(await grant()).toHaveLength(0);
  await sql`update api_keys set project_ids = array['p'] where id = 'k'`;
  expect((await grant())[0].cohort_id).toBe(first.cohort_id);
  await sql`delete from org_memberships where org_id = 'o' and user_id = 'u'`;
  expect(await grant()).toHaveLength(0);
  await sql`insert into org_memberships(org_id,user_id,role) values ('o','u','owner')`;
});

it('changes cohorts with admitted inputs and refuses cancelled or superseded work', async () => {
  const [first] = await grant();
  await expect(sql`update project_runs set compute_input_manifest_hash = ${'0'.repeat(64)} where id = 'r'`).rejects.toThrow(/immutable/);
  await sql`update project_runs set creation_source_keys = array['new-source'] where id = 'r'`;
  expect((await grant())[0].cohort_id).not.toBe(first.cohort_id);
  await sql`update project_runs set control_state = 'cancel_requested' where id = 'r'`;
  expect(await grant()).toHaveLength(0);
  await sql`update project_runs set control_state = null where id = 'r'`;
  await sql`update documents set superseded_at = now() where id = 'd-r'`;
  expect(await grant()).toHaveLength(0);
  await sql`update documents set superseded_at = null where id = 'd-r'`;
});

it('keeps unidentified machine requests single-use and separates app and key cohorts', async () => {
  expect((await grant('legacy'))[0].cohort_id).toBeNull();
  expect((await grant('app'))[0].cohort_id).toMatch(/^[a-f0-9]{64}$/);
  expect((await grant('app'))[0].cohort_id).not.toBe((await grant())[0].cohort_id);
});

it('exposes the predicate to the worker only after role reconciliation', async () => {
  const signature = 'public.authorize_compute_cohort(text,text,text,text,text)';
  for (const [role, allowed] of [['docslurp_worker',true],['docslurp_app',false]] as const) {
    const [row] = await sql`select has_function_privilege(${role},${signature},'EXECUTE') as allowed`;
    expect(row.allowed).toBe(allowed);
  }
  const rows = await sql.begin(async tx => {
    await tx.unsafe('set local role docslurp_worker');
    return tx`select * from public.authorize_compute_cohort('o','p','r','d-r','g')`;
  });
  expect(rows).toHaveLength(1);
  await expect(sql.begin(async tx => {
    await tx.unsafe('set local role docslurp_app');
    return tx`select * from public.authorize_compute_cohort('o','p','r','d-r','g')`;
  })).rejects.toThrow(/permission denied/);
});
