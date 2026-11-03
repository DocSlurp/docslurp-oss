# Execution generation: coordinated downtime rollout

Migration 0112 is incompatible with mixed ingestion fleets. Old workflows omit
generation fields, new activities reject them, and old activities cannot enforce
ownership. Do not rolling-deploy this release. This procedure requires operator
execution; it has not been performed by implementing this change.

The supported migrator (`pnpm db:migrate`, including startup/release invocations)
refuses an existing pre-0112 database unless all three checks pass:

- `GENERATION_ROLLOUT_DRAINED=all-executions-and-activities-stopped` explicitly
  attests the external Temporal/process checks below.
- The database has `CONNECTION LIMIT 0`, the migrator is a superuser, and no other
  database sessions exist, including idle sessions.
- Every SQL run is completed, failed or cancelled. Queued recovery, running,
  pending, paused, blocked and unknown statuses refuse migration.

This is a migration barrier, not a Temporal drain detector. The SQL check covers
all organizations in this database, including queued runs without a confirmed
workflow start. It cannot prove the absence of Temporal executions, delayed
retries, queued activities or disconnected worker processes. Database connection
limits exclude superusers and do not close existing sessions. Runtime processes
must use non-superuser credentials; stop all processes with owner/superuser
credentials and prevent their restart. The operator attestation is required
because legacy binaries have no startup handshake. Do not set it globally in an
image, deployment environment, or API startup configuration. Do not bypass the
supported migrator with drizzle-kit or direct SQL. Fresh installations with no
workspace_runs table and already-migrated installations skip this one-time gate.

## Required sequence

1. Pause admission at the ingress and every producer: uploads, API/SDK/CLI/MCP,
   connectors, schedules, retries, admin actions and automated recovery. Keep old
   workers available to finish existing work. Prevent autoscaling/restarts and
   automatic releases throughout maintenance.
2. Drain **all** ingestion executions in every Temporal namespace/task queue used
   by this database, including child workflows, retry timers and queued/running
   activities. Use Temporal execution descriptions as well as visibility lists;
   visibility may lag. A terminal SQL run is not evidence of a drained workflow.
   Cancellation/termination alone is insufficient: wait for activity handlers and
   subprocesses to exit, and for retry work to cease. Resolve queued SQL recovery
   under the old fleet, or explicitly cancel it and verify its Temporal state.
   Retain evidence identifying namespaces, queues, executions and drain time.
3. Stop every old worker, API (including mounted app servers), scheduler and
   recovery process. Disable their supervisors. Verify no worker process or
   parser subprocess survives and no producer can reconnect. Do not leave an old
   worker polling while starting the new fleet.
4. Record the current database connection limit. As administrator, set
   `ALTER DATABASE <quoted_database_name> CONNECTION LIMIT 0`. Close remaining
   runtime/pool sessions; inspect pg_stat_activity for this database. Use a
   dedicated superuser migration connection with no competing admin sessions.
   The migrator refuses rather than killing sessions. This barrier prevents
   ordinary runtime reconnects during the migration, but is not a substitute for
   stopping legacy superuser clients in step 3.
5. Run the supported migrator once with the drain attestation above, using a
   direct superuser MIGRATION_DATABASE_URL. If any check fails, resolve it while
   maintenance stays active; never falsify terminal SQL statuses to pass.
6. Verify 0112 and subsequent migrations succeeded. Deploy only the new API,
   workers and recovery binaries, with admission still paused. Restore the saved
   connection limit so the new non-superuser fleet can connect, start that fleet,
   and verify its health and versions. Keep old images/supervisors disabled.
7. Resume recovery and admission only after the entire new fleet is ready. Check
   a new run has a generation token and completes on the new workflow/activity
   implementation. Remove the one-shot attestation from the migration shell.

## Failure and rollback

A refused migration leaves the old schema available; keep admission paused while
investigating. Restore the saved connection limit only when intentionally
returning to a wholly old fleet or starting the wholly new fleet. After 0112,
never restart old binaries against this database, even if no new run was admitted.
Prefer a forward fix. A rollback requires another full drain/stop and a verified
pre-migration database restore plus coordinated Temporal reconciliation; dropping
the column does not undo new workflow histories or side effects. No automatic
rollback, mixed-version compatibility or deployment authorization is provided.
