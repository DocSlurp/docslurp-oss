// This gate deliberately requires downtime; it is not a fleet capability probe.
export async function assertGenerationRollout(client, env = process.env) {
  const { rows: [schema] } = await client.query(`select
    to_regclass('public.project_runs') is not null as existing,
    exists(select 1 from information_schema.columns where table_schema = 'public'
      and table_name = 'project_runs' and column_name = 'execution_generation') as migrated`);
  if (!schema) throw new Error("Generation rollout refused: schema probe returned no result");
  if (!schema.existing && !schema.migrated) return; // fresh installation
  if (schema.migrated) return;
  const refuse = (reason) => { throw new Error(`Generation rollout refused: ${reason}. See docs/generation-rollout.md`); };
  if (env.GENERATION_ROLLOUT_DRAINED !== 'all-executions-and-activities-stopped') {
    refuse('operator drain attestation missing');
  }
  const { rows: [barrier] } = await client.query(`select
    d.datconnlimit = 0 as closed,
    r.rolsuper as migrator_superuser,
    not exists(select 1 from pg_stat_activity a where a.datid = d.oid
      and a.pid <> pg_backend_pid()) as alone
    from pg_database d join pg_roles r on r.rolname = current_user
    where d.datname = current_database()`);
  if (!barrier?.closed || !barrier.migrator_superuser || !barrier.alone) {
    refuse('database must have CONNECTION LIMIT 0, a superuser migrator, and no other sessions');
  }
  const { rows: [runs] } = await client.query(`select exists(select 1 from project_runs
    where status is null or status not in ('completed', 'failed', 'cancelled')) as unfinished`);
  if (!runs || runs.unfinished) refuse('unfinished SQL runs remain (including queued recovery and paused runs)');
}
