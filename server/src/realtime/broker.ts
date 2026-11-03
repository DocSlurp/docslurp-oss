import type { RealtimeResource } from "@docslurp/shared";

export type DashboardResource = Exclude<RealtimeResource, { kind: "operation" }>;
export interface RealtimeBackend {
  authorize(userId: string, resource: DashboardResource): Promise<string | null>;
  project(userId: string, resource: DashboardResource): Promise<unknown>;
  revisions(orgIds: string[]): Promise<Map<string, string>>;
  listen(wake: () => void): Promise<() => Promise<void>>;
}
export const realtimeMetrics = {
  connections: 0, subscriptions: 0, snapshots: 0, projectionQueries: 0,
  revisionQueries: 0, coalesced: 0, errors: 0, resyncs: 0,
  queuedBytes: 0, projectionMs: 0, rejected: 0,
};
type Observer = ((data: unknown, revision: number) => Promise<void>) & { failed?: () => void };
type Entry = {
  userId: string; resource: DashboardResource; orgId: string;
  observers: Set<Observer>; version?: string; revision: number; dirty: boolean;
};
/** One notification listener and revision sweep for every socket using this broker.
 * Notifications do not carry customer data or constitute durable history.
 */
export class RealtimeBroker {
  private entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private unlisten?: () => Promise<void>;
  private starting?: Promise<void>;
  private running = false;
  private closed = false;
  constructor(private backend: RealtimeBackend, private intervalMs = 1_000) {}
  async subscribe(userId: string, resource: DashboardResource, observer: Observer): Promise<() => void> {
    if (this.closed) throw new Error("draining");
    const orgId = await this.backend.authorize(userId, resource);
    if (!orgId) throw new Error("forbidden");
    const key = JSON.stringify([userId, resource]);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 2_048) throw new Error("capacity");
      entry = { userId, resource, orgId, observers: new Set(), revision: 0, dirty: true };
      this.entries.set(key, entry);
    }
    entry.observers.add(observer);
    entry.dirty = true;
    realtimeMetrics.subscriptions++;
    try {
      this.starting ??= this.start();
      await this.starting;
    } catch (error) {
      entry.observers.delete(observer);
      realtimeMetrics.subscriptions--;
      if (!entry.observers.size) this.entries.delete(key);
      this.starting = undefined;
      throw error;
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      realtimeMetrics.subscriptions--;
      entry.observers.delete(observer);
      if (!entry.observers.size) this.entries.delete(key);
    };
  }
  private async start() {
    this.unlisten = await this.backend.listen(() => { realtimeMetrics.coalesced++; });
    if (this.closed) { await this.unlisten(); return; }
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    this.timer.unref();
  }
  async tick(): Promise<void> {
    if (this.running || this.closed || !this.entries.size) return;
    this.running = true;
    try {
      const entries = [...this.entries.values()];
      realtimeMetrics.revisionQueries++;
      const versions = await this.backend.revisions([...new Set(entries.map(e => e.orgId))]);
      for (let offset = 0; offset < entries.length; offset += 8) {
        await Promise.all(entries.slice(offset, offset + 8).map(async entry => {
          const version = versions.get(entry.orgId) ?? "0";
          if (!entry.dirty && version === entry.version) return;
          entry.dirty = false;
          const began = Date.now();
          try {
            // Register first, then read a durable revision before the projection.
            // A concurrent commit advances the next sweep's revision, forcing a
            // second snapshot even if its notification was lost.
            if (!await this.backend.authorize(entry.userId, entry.resource)) throw new Error("forbidden");
            realtimeMetrics.projectionQueries++;
            const data = await this.backend.project(entry.userId, entry.resource);
            entry.version = version;
            entry.revision++;
            await Promise.all([...entry.observers].map(observer => observer(data, entry.revision)));
            realtimeMetrics.snapshots++;
            realtimeMetrics.projectionMs += Date.now() - began;
          } catch { entry.dirty = true; realtimeMetrics.errors++; for (const observer of entry.observers) observer.failed?.(); }
        }));
      }
    } catch { realtimeMetrics.errors++; for (const entry of this.entries.values()) for (const observer of entry.observers) observer.failed?.(); }
    finally { this.running = false; }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.starting?.catch(() => {});
    await this.unlisten?.();
  }
}
