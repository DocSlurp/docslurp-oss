import type { BackgroundTaskManager, BackgroundTask } from "@mastra/core/background-tasks";
import type { Pool } from "pg";

/** Mastra 1.81 only rescans leases seen at startup and pinned pending tasks.
 * Use its public storage CAS and restart APIs for bounded recurring recovery.
 * Never restart running work, claim a lease, or retry an accepted execution.
 */
export function startNativeRecovery(manager: BackgroundTaskManager, pool: Pool) {
  let stopped = false;
  let page = 0;
  let running: Promise<void> | undefined;
  const sweep = async () => {
    const storage = await manager.getStorage();
    const { tasks } = await storage.listTasks({ agentId: "docslurp-workspace-chat",
      status: ["pending", "running"], orderBy: "createdAt", orderDirection: "asc", page, perPage: 64 });
    page = tasks.length < 64 ? 0 : page + 1;
    if (!tasks.length) return;
    const { rows: [clock] } = await pool.query<{ now: Date }>("select clock_timestamp() as now");
    for (const task of tasks) {
      if (stopped) return;
      const fence = { expectedStatus: task.status, expectedOwnerId: task.ownerId ?? null,
        expectedLeaseExpiresAt: task.leaseExpiresAt ?? null };
      if (task.status === "running" || task.ownerId) {
        if (task.leaseExpiresAt && task.leaseExpiresAt > clock!.now) continue;
        // Native CAS fences a concurrent heartbeat/completion. No retry budget
        // is consumed: interrupted paid work becomes terminal, never restarted.
        await storage.updateTask(task.id, { status: "failed", completedAt: clock!.now,
          error: { message: "Worker process terminated before task completed" },
          ownerId: undefined, leaseExpiresAt: undefined }, fence);
        continue;
      }
      await recoverPending(task).catch(() => { console.warn("[native-chat] pending_recovery_failed"); });
    }
  };
  const recoverPending = async (task: BackgroundTask) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='2s'");
      await client.query("set local statement_timeout='5s'");
      // Same lock order as acceptance/cancellation. Scope comes from persisted
      // metadata; worker executor revalidates session/workspace before spending.
      await client.query(`select root.id from chat_operations root join chat_operations op on op.root_id=root.id
        where op.id=$1 for update of root`, [task.toolCallId]);
      const { rows } = await client.query(`select op.id from chat_operations op join chat_operations root on root.id=op.root_id
        where op.id=$1 and op.runtime='mastra' and op.root_id=$2
          and json_build_array(op.org_id,op.user_id)::jsonb=$3::jsonb
          and not op.cancel_requested and not root.tree_cancel_requested
          and op.deadline>clock_timestamp() and op.expires_at>clock_timestamp()`,
      [task.toolCallId, task.runId, task.resourceId]);
      if (!rows.length) {
        await (await manager.getStorage()).updateTask(task.id, { status: "failed", completedAt: new Date(),
          error: { message: "Operation cancelled, expired or unavailable before dispatch" } },
        { expectedStatus: "pending", expectedOwnerId: null, expectedLeaseExpiresAt: task.leaseExpiresAt ?? null });
      } else {
        // Prevent restart's internal read from entering its running-task branch.
        // Dispatch only publishes; the native worker claims after this commit.
        const pending = await client.query(`select id from docslurp_mastra.mastra_background_tasks
          where id=$1 and status='pending' and "ownerId" is null for update`, [task.id]);
        if (pending.rowCount && !stopped) await manager.restart(task.id);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  const tick = () => {
    if (stopped || running) return;
    running = sweep().catch(() => { console.warn("[native-chat] recovery_sweep_failed"); })
      .finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await running; };
}
