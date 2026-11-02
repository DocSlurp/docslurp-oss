import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

// PGlite's wire adapter serializes connections; it cannot establish lock contention.
if (process.env.NATIVE_PG_TESTS === '1') {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const sql = postgres(url.toString(), { max: 4 });
  const { createRunLifecycle } = await import('../../src/services/run-lifecycle.ts');
  const { requireRunCreditLease } = await import('../../src/services/billing/spend-guard.ts');
  const { defaultPipelineFeatures } = await import('@docslurp/shared');
  const id = `admission-${randomUUID()}`;
  const lifecycle = createRunLifecycle({ sql, startWorkflow: async () => { throw Error('unexpected publication'); }, failureThreshold: 3,
    signals: { resume: async () => { throw Error('signal before commit'); }, cancel: async () => {}, pause: async () => {} } });
  try {
    await sql`insert into "user"(id,name,email) values (${id}, 'Admission test', ${`${id}@example.com`})`;
    await sql`insert into organizations(id,name,slug,created_by_user_id,credit_balance_cents,funded_at) values (${id},${id},${id},${id},100000,now())`;
    await sql`insert into credit_grants(org_id,source,credits) values (${id},'topup',1000)`;
    await sql`insert into workspaces(id,org_id,user_id,name,pipeline) values (${id},${id},${id},${id},${sql.json(defaultPipelineFeatures)})`;
    for (const boost of [false, true]) for (const action of ['retry', 'recover', 'resume']) {
      const runId = `${id}-${boost}-${action}`;
      const status = action === 'resume' ? 'processing' : 'failed';
      const controlState = action === 'recover' ? 'dead-letter' : action === 'resume' ? 'paused' : null;
      const run = { id: runId, status, priority: 0, controlState, error: null, pipeline: { ...defaultPipelineFeatures, speedBoost: boost } };
      await sql`insert into workspace_runs(id,org_id,user_id,workspace_id,kind,status,stage,control_state,pipeline)
        values (${runId},${id},${id},${id},'bulk-upload',${status},'queued',${controlState},${sql.json(run.pipeline)})`;
      const prepare = tx => action === 'retry' ? lifecycle.prepareRetry(run, tx) : lifecycle.control(run, { action }, tx);
      await assert.rejects(sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${id}))`;
        await tx`delete from credit_grants where org_id=${id}`;
        await tx`update organizations set credit_balance_cents=0 where id=${id}`;
        await prepare(tx);
        await requireRunCreditLease(tx, { runId, orgId: id, workspaceId: id });
      }), error => error.code === 'credit_exhausted');
      assert.equal((await sql`select status from workspace_runs where id=${runId}`)[0].status, status);
      const failure = new Error('failure after grant');
      await assert.rejects(sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${id}))`;
        await prepare(tx);
        await requireRunCreditLease(tx, { runId, orgId: id, workspaceId: id });
        throw failure;
      }), error => error === failure);
      assert.equal((await sql`select status from workspace_runs where id=${runId}`)[0].status, status);
      assert.equal((await sql`select count(*)::int as count from credit_leases where holder_id=${runId}`)[0].count, 0);
      const outcomes = await Promise.all([0, 1].map(() => sql.begin(async tx => {
        await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${id}))`;
        const result = await prepare(tx);
        if (result !== null && result !== 'not-retryable') await requireRunCreditLease(tx, { runId, orgId: id, workspaceId: id });
        return result;
      })));
      assert.equal(outcomes.filter(value => value !== null && value !== 'not-retryable').length, 1);
      const [saved] = await sql`select status,pipeline from workspace_runs where id=${runId}`;
      assert.equal(saved.status, 'queued');
      assert.equal(saved.pipeline.speedBoost, boost);
    }
    console.log('Native PostgreSQL: retry/recover/resume contention, rollback, immutable boost passed.');
  } finally {
    await sql`delete from workspace_runs where workspace_id=${id}`;
    await sql`delete from workspaces where id=${id}`;
    await sql`delete from organizations where id=${id}`;
    await sql`delete from "user" where id=${id}`;
    await sql.end();
  }
} else {
  console.log('SKIP native run-control contention tests: set NATIVE_PG_TESTS=1 with a migrated local DATABASE_URL.');
}
