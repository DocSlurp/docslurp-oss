import { sql as defaultSql, type SqlClient } from "../db.js";

// Long source preparation renews this lease. Expiry only authorizes cleanup;
// it never authorizes processing. Every document write and publication locks
// the unpublished Run, so a creator that resumes after cleanup is fenced out.
const CREATION_LEASE_MS = 5 * 60_000;
const CREATION_HEARTBEAT_MS = 30_000;

export async function lockRunCreation(runId: string, sql: SqlClient): Promise<void> {
  const [run] = await sql<{ id: string }[]>`
    select id from workspace_runs
    where id = ${runId} and creation_ready_at is null and status = 'queued'
      and workflow_started_at is null
    for update
  `;
  if (!run) throw new Error(`Run ${runId} is no longer being created`);
}

// Sources are registered with the initial Run insert, including files whose
// preparation never made a Document. Reprocessing borrows sources and registers
// none. Queue only keys with no remaining Document reference.
async function enqueueUnmaterializedSources(runId: string, sql: SqlClient): Promise<void> {
  await sql`
    insert into storage_cleanup_queue (kind, org_id, target, payload, artifact_uris, reason)
    select 'storage_prefix', r.org_id, r.user_id || '/' || r.id || '/',
      jsonb_build_object('workspaceId', r.workspace_id), sources.keys, 'run_creation'
    from workspace_runs r
    cross join lateral (
      select array_agg(distinct key) as keys
      from unnest(r.creation_source_keys) as source(key)
      where not exists (select 1 from documents d where d.source_key = source.key)
    ) sources
    where r.id = ${runId} and cardinality(sources.keys) > 0
    on conflict (kind, target) do update
    set artifact_uris = array(select distinct unnest(storage_cleanup_queue.artifact_uris || excluded.artifact_uris))
  `;
}

async function deleteRunCreation(runId: string, sql: SqlClient): Promise<void> {
  await sql`delete from documents where run_id = ${runId}`;
  await enqueueUnmaterializedSources(runId, sql);
  await sql`delete from workspace_runs where id = ${runId}`;
}

/** Publish only a fully materialized manifest, with its final document/page totals. */
export async function publishRunCreation(runId: string, totalDocuments: number, sql: SqlClient = defaultSql): Promise<void> {
  await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    await lockRunCreation(runId, client);
    const [manifest] = await client<{ count: number; pages: number }[]>`
      select count(*)::int as count, coalesce(sum(page_count), 0)::int as pages
      from documents where run_id = ${runId}
    `;
    if (manifest?.count !== totalDocuments) {
      throw new Error(`Run ${runId} has an incomplete manifest: expected ${totalDocuments}, found ${manifest?.count ?? 0}`);
    }
    await client`
      update workspace_runs
      set total_documents = ${totalDocuments}, pages_total = ${manifest.pages},
          creation_ready_at = now(), creation_expires_at = null, creation_source_keys = '{}', updated_at = now()
      where id = ${runId}
    `;
  });
}

/** Keep slow preparation alive, publish on success, and discard partial work on failure. */
export async function completeRunCreation<T>(
  runId: string,
  prepare: () => Promise<{ value: T; totalDocuments: number }>,
  options: { sql?: SqlClient; heartbeatMs?: number } = {},
): Promise<T> {
  const sql = options.sql ?? defaultSql;
  let heartbeat: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (heartbeat) return;
    heartbeat = sql`
      update workspace_runs
      set creation_expires_at = now() + (${CREATION_LEASE_MS} * interval '1 millisecond')
      where id = ${runId} and creation_ready_at is null
    `.catch((error: unknown) => {
      console.warn(`[run-creation] lease renewal failed run=${runId}:`, error);
    }).finally(() => { heartbeat = undefined; });
  }, options.heartbeatMs ?? CREATION_HEARTBEAT_MS);
  timer.unref();
  try {
    const prepared = await prepare();
    await publishRunCreation(runId, prepared.totalDocuments, sql);
    return prepared.value;
  } catch (error) {
    await discardUnstartedRun(runId, sql).catch((cleanupError: unknown) => {
      console.error(`[run-creation] could not discard run=${runId}:`, cleanupError);
    });
    throw error;
  } finally {
    clearInterval(timer);
    await heartbeat;
  }
}

/** Published Runs belong to processing and must never be discarded by creation cleanup. */
export async function discardUnstartedRun(runId: string, sql: SqlClient = defaultSql): Promise<boolean> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const [locked] = await client<{ id: string }[]>`
      select id from workspace_runs where id = ${runId}
        and creation_ready_at is null and workflow_started_at is null for update
    `;
    if (!locked) return false;
    await deleteRunCreation(runId, client);
    return true;
  });
}

/** Crash/restart backstop. Existing deletion triggers enqueue source/artifact cleanup. */
export async function sweepInterruptedRunCreations(sql: SqlClient = defaultSql, limit = 25): Promise<number> {
  return await sql.begin(async (tx) => {
    const client = tx as unknown as SqlClient;
    const rows = await client<{ id: string }[]>`
      select id from workspace_runs
      where creation_ready_at is null and workflow_started_at is null
        and creation_expires_at <= now()
      order by creation_expires_at asc limit ${limit} for update skip locked
    `;
    for (const row of rows) {
      await deleteRunCreation(row.id, client);
    }
    return rows.length;
  });
}
