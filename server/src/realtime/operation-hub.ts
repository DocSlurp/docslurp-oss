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
      const rows = await sql<{ root_id: string; user_id: string; version: string }[]>`
        select c.root_id, c.user_id,
          md5(string_agg(c.id || ':' || c.sequence::text || ':' || c.status || ':' || coalesce(c.attempt_id,'') || ':' ||
            c.cancel_requested::text || ':' || c.tree_cancel_requested::text, ',' order by c.id)) || ':' ||
            coalesce(max(r.revision),0)::text as version
        from chat_operations c left join realtime_revisions r on r.org_id=c.org_id
        where c.root_id=any(${sql.array(roots)}) and c.expires_at>now()
        group by c.root_id,c.user_id`;
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
