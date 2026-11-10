import { nativeChatRuntime } from "../agent-runtime/runtime.js";
import { MAX_OPERATION_ATTEMPTS } from "../agent-runtime/native-attempts.js";
import { operationOutputTopic } from "../agent-runtime/operation-delivery.js";
import type { authorizedChatOperationSnapshot } from "../services/chat-operation-access.js";
import { sql } from "../db.js";
import { realtimeMetrics } from "./broker.js";

type Watcher = { rootId: string; userId: string; version?: string; refresh(): Promise<boolean>; failed(): Promise<void> };
/** Shared process reconciliation for durable operation trees. A tree's changing
 * children affect its signature even when the root answer is already terminal.
 * Only wake-up metadata is shared; session authorization remains per observer.
 */
class OperationHub {
  private recoveries = new Map<string, Promise<Awaited<ReturnType<typeof authorizedChatOperationSnapshot>>>>();
  shareRecovery(key: string, load: () => Promise<Awaited<ReturnType<typeof authorizedChatOperationSnapshot>>>) {
    if (!this.running) return load();
    const existing = this.recoveries.get(key);
    if (existing) return existing;
    const pending = load();
    if (this.recoveries.size < 128) this.recoveries.set(key, pending);
    return pending;
  }
  private watchers = new Set<Watcher>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  watch(watcher: Watcher) {
    if (this.watchers.size >= 2_048) throw new Error("operation_subscription_limit");
    this.watchers.add(watcher);
    this.timer ??= setInterval(() => { void this.tick(); }, 1_000);
    this.timer.unref();
    return () => {
      this.watchers.delete(watcher);
      if (!this.watchers.size) { clearInterval(this.timer); this.timer = undefined; }
    };
  }
  async tick() {
    if (this.running || !this.watchers.size) return;
    this.running = true;
    const watchers = [...this.watchers];
    try {
      realtimeMetrics.revisionQueries++;
      const roots = [...new Set(watchers.map(w => w.rootId))];
      const rows = await sql<{ root_id: string; user_id: string; version: string; native_tasks: string[] }[]>`
        select c.root_id, c.user_id,
          md5(string_agg(c.id || ':' || c.sequence::text || ':' || c.status || ':' || coalesce(c.attempt_id,'') || ':' ||
            c.cancel_requested::text || ':' || c.tree_cancel_requested::text, ',' order by c.id)) || ':' ||
            coalesce(max(r.revision),0)::text || ':' ||
            (select count(*)::text || ':' || count(*) filter(where d.created_at+interval '15 minutes'<now())::text
              from chat_run_dependencies d join chat_operations owner on owner.id=d.operation_id where owner.root_id=c.root_id) || ':' || coalesce(string_agg(t.id || ':' || t.status || ':' || t.retry_count::text,',' order by t.id),'') as version,
          coalesce(array_agg(t.id) filter(where t.id is not null),'{}') as native_tasks
        from chat_operations c left join realtime_revisions r on r.org_id=c.org_id
        left join docslurp_mastra.mastra_background_tasks t on c.runtime='mastra' and t.tool_call_id=c.id
          and t.agent_id='docslurp-project-chat'
        where c.root_id=any(${sql.array(roots)}) and c.expires_at>now()
        group by c.root_id,c.user_id`;
      // Native retained-list length detects missed PubSub wakes without reading
      // output payloads, once per task/root rather than per observing socket.
      if(rows.some(row=>row.native_tasks.length)) {
        const host=await nativeChatRuntime();
        for(const row of rows) {
          if(row.native_tasks.length>64*MAX_OPERATION_ATTEMPTS)throw new Error("operation_tree_limit");
          const lengths=await Promise.all([...row.native_tasks].sort().map(id=>host.cache.listLength(`pubsub:${operationOutputTopic(id)}`)));
          row.version+=":"+lengths.join(",");
        }
      }
      const versions = new Map(rows.map(row => [JSON.stringify([row.user_id,row.root_id]), row.version]));
      for (let i=0; i<watchers.length; i+=8) await Promise.all(watchers.slice(i,i+8).map(async watcher => {
        const version = versions.get(JSON.stringify([watcher.userId,watcher.rootId])) ?? "expired";
        if (watcher.version === version || !this.watchers.has(watcher)) return;
        try {
          // A concurrent commit appears in the next signature; never assign a
          // post-read revision to an earlier snapshot. More replay pages remain dirty.
          const more = await watcher.refresh();
          watcher.version = more ? undefined : version;
        } catch { this.watchers.delete(watcher); await watcher.failed().catch(() => {}); }
      }));
    } catch {
      realtimeMetrics.errors++;
      for (const watcher of watchers) { this.watchers.delete(watcher); await watcher.failed().catch(() => {}); }
    } finally {
      this.recoveries.clear();
      this.running = false;
      if (!this.watchers.size) { clearInterval(this.timer); this.timer = undefined; }
    }
  }
}
export const operationHub = new OperationHub();
