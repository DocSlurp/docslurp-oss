import { sql } from "../db.js";

/**
 * Connector syncs run in-process after the trigger request returns, so a
 * restart or crash mid-sync would leave its connector_sync_log row 'running'
 * forever (and, with the one-running-sync guard, block future syncs). This
 * sweep fails syncs that have been running longer than the timeout.
 */
const CONNECTOR_SYNC_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.CONNECTOR_SYNC_TIMEOUT_MS ?? 30 * 60_000),
);

export async function sweepInterruptedConnectorSyncs(): Promise<number> {
  const interrupted = await sql<{ connector_id: string }[]>`
    update connector_sync_log
    set
      status = 'failed',
      finished_at = now(),
      error_message = 'Sync was interrupted before completing (process restart, crash, or timeout). Trigger the sync again.'
    where status = 'running'
      and started_at < now() - (${CONNECTOR_SYNC_TIMEOUT_MS} * interval '1 millisecond')
    returning connector_id
  `;

  const connectorIds = [...new Set(interrupted.map((row) => row.connector_id))];
  if (connectorIds.length > 0) {
    await sql`
      update workspace_connectors
      set status = 'error', updated_at = now()
      where id in ${sql(connectorIds)} and status <> 'paused'
    `;
    console.warn(
      `[connector-sync-recovery] failed ${interrupted.length} interrupted sync(s) connectors=${connectorIds.join(",")}`,
    );
  }
  return interrupted.length;
}
