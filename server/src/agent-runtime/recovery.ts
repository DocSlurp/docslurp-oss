import { Mastra } from "@mastra/core/mastra";
import { PubSub, type Event } from "@mastra/core/events";
import { PostgresStore } from "@mastra/pg";
import { RedisStreamsPubSub, type RedisStreamsPubSubConfig } from "@mastra/redis-streams";
import { createClient } from "redis";
import { Pool, type PoolClient } from "pg";

/** Native restart has no AbortSignal and also accepts running tasks. Give each
 * recovery attempt its own cancellable I/O; never release its pending-row lock
 * while native code can still read state or begin publishing.
 */
export function startNativeRecovery(source: Pool, redisUrl: string, namespace: string) {
  let stopped = false;
  let cursor = "";
  let horizon: Date | undefined;
  let running: Promise<void> | undefined;
  let abort: (() => void) | undefined;
  const sweep = async () => {
    const controller = new AbortController();
    const { signal } = controller;
    // Separate, owned pool: exhausting the executor pool cannot stall recovery;
    // timeout destroys these connections, including blocked CAS/lock queries.
    const pool = new Pool({ ...source.options, max: 3, application_name: "docslurp-native-recovery", connectionTimeoutMillis: 500,
      statement_timeout: 1000, query_timeout: 1200, idle_in_transaction_session_timeout: 4000 });
    const clients = new Set<PoolClient>();
    pool.on("connect", client => { clients.add(client); client.on("error", () => {}); });
    pool.on("remove", client => clients.delete(client));
    pool.on("error", () => {});
    const writer = createClient({ url: redisUrl, disableOfflineQueue: true,
      socket: { connectTimeout: 500, reconnectStrategy: false }, commandOptions: { abortSignal: signal } });
    writer.on("error", () => {});
    // Adapter types name node-redis 5; public client APIs are compatible with 6.
    const transport = new RedisStreamsPubSub({ client: writer as unknown as RedisStreamsPubSubConfig["client"], keyPrefix: `${namespace}:events`,
      maxStreamLength: 4096, streamIdleTtlMs: 7 * 86400000 });
    // This producer only dispatches. It owns no result observer or execution
    // workers. Native serialization/dispatch remains in Mastra's public APIs.
    class DispatchOnly extends PubSub {
      async publish(topic: string, event: Omit<Event, "id" | "createdAt">) {
        signal.throwIfAborted();
        await transport.publish(topic, event);
      }
      async subscribe() {}
      async unsubscribe() {}
      async flush() {}
    }
    const pubsub = new DispatchOnly();
    const storage = new PostgresStore({ id: "native-recovery", pool, schemaName: "docslurp_mastra", disableInit: true });
    const mastra = new Mastra({ storage, pubsub, workers: false, logger: false,
      recovery: { workflows: "off", durableAgents: "off" },
      backgroundTasks: { enabled: true, mode: "producer", recoverStaleTasksOnStart: false,
        globalConcurrency: 8, perAgentConcurrency: 8, defaultRetries: { maxRetries: 0 } } });
    const manager = mastra.backgroundTaskManager!;
    let ending: Promise<void> | undefined;
    const terminate = () => {
      controller.abort();
      // Starting shutdown synchronously fences further native admission. Abort
      // queued Redis commands and destroy the socket: no offline late publish.
      void mastra.shutdown({ drainTimeout: 0 }).catch(() => {});
      try { writer.destroy(); } catch {}
      for (const client of clients) void client.end().catch(() => {});
      ending ??= pool.end();
    };
    abort = terminate;
    const timer = setTimeout(terminate, 3000);
    try {
      // Keyset cursor advances for every attempted row, even under contention.
      // Status changes cannot shift an offset and skip a later retained row.
      // Freeze creation time per pass: later ingress cannot prevent wraparound
      // and indefinitely postpone an earlier contended row.
      if (!horizon) {
        const { rows: [clock] } = await pool.query<{ now: Date }>("select clock_timestamp() as now");
        horizon = clock!.now;
      }
      const { rows } = await pool.query<{ id: string }>(`select id from docslurp_mastra.mastra_background_tasks
        where agent_id='docslurp-project-chat' and status in ('pending','running') and id>$1 and "createdAtZ"<=$2 order by id limit 64`, [cursor, horizon]);
      if (!rows.length) { cursor = ""; horizon = undefined; }
      await manager.init(pubsub);
      const tasks = await manager.getStorage();
      for (const { id } of rows) {
        signal.throwIfAborted();
        cursor = id;
        try {
          const task = await tasks.getTask(id);
          signal.throwIfAborted();
          if (!task || !["pending", "running"].includes(task.status)) continue;
          if (task.status === "running" || task.ownerId) {
            const { rows: [clock] } = await pool.query<{ now: Date }>("select clock_timestamp() as now");
            if (task.leaseExpiresAt && task.leaseExpiresAt > clock!.now) continue;
            await tasks.updateTask(id, { status: "failed", completedAt: clock!.now,
              error: { message: "Worker process terminated before task completed" }, ownerId: undefined, leaseExpiresAt: undefined },
            { expectedStatus: task.status, expectedOwnerId: task.ownerId ?? null, expectedLeaseExpiresAt: task.leaseExpiresAt ?? null });
            continue;
          }
          const client = await pool.connect();
          try {
            await client.query("begin");
            await client.query(`select root.id from chat_operations root join chat_operations op on op.root_id=root.id
              where op.id=$1 for update of root`, [task.toolCallId]);
            const { rows: allowed } = await client.query(`select op.id from chat_operations op join chat_operations root on root.id=op.root_id
              where op.id=$1 and op.runtime='mastra' and op.root_id=$2
                and json_build_array(op.org_id,op.user_id)::jsonb=$3::jsonb
                and not op.cancel_requested and not root.tree_cancel_requested
                and op.deadline>clock_timestamp() and op.expires_at>clock_timestamp()`, [task.toolCallId, task.runId, task.resourceId]);
            if (!allowed.length) {
              await tasks.updateTask(id, { status: "failed", completedAt: new Date(),
                error: { message: "Operation cancelled, expired or unavailable before dispatch" } },
              { expectedStatus: "pending", expectedOwnerId: null, expectedLeaseExpiresAt: task.leaseExpiresAt ?? null });
            } else {
              const pending = await client.query(`select id from docslurp_mastra.mastra_background_tasks
                where id=$1 and status='pending' and "ownerId" is null for update`, [id]);
              signal.throwIfAborted();
              if (pending.rowCount) await manager.restart(id);
            }
            signal.throwIfAborted();
            await client.query("commit");
          } catch (error) {
            // Destroying a connection rolls its transaction back even if the
            // server/driver cannot answer ROLLBACK. No background lock holder.
            client.release(true);
            throw error;
          }
          client.release();
        } catch {
          if (signal.aborted) break;
          console.warn("[native-chat] recovery_task_failed");
        }
      }
    } finally {
      clearTimeout(timer);
      terminate();
      await ending;
      await transport.close().catch(() => {});
      abort = undefined;
    }
  };
  const tick = () => {
    if (stopped || running) return;
    running = sweep().catch(() => { console.warn("[native-chat] recovery_sweep_failed"); })
      .finally(() => { running = undefined; });
  };
  const timer = setInterval(tick, 2000);
  timer.unref();
  tick();
  return () => { stopped = true; clearInterval(timer); abort?.(); return running ?? Promise.resolve(); };
}
