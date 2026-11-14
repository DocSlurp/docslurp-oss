import type { RealtimeResource } from "@docslurp/shared";

export type DashboardResource = Exclude<RealtimeResource, { kind: "operation" }>;
export interface RealtimeBackend {
  authorize(userId: string, resource: DashboardResource): Promise<string | null>;
  /** One fresh scoped decision per input, in order; no cached grants. */
  authorizeMany?(userId: string, resources: DashboardResource[]): Promise<Array<string | null>>;
  /** Collection payloads must reauthorize their constituents before delivery. */
  authorizeDelivery?(userId: string, resource: DashboardResource, data: unknown): Promise<boolean>;
  project(userId: string, resource: DashboardResource): Promise<unknown>;
  /** Organization revisions: move on every change in the organization, access changes included. */
  revisions(orgIds: string[]): Promise<Map<string, string>>;
  /**
   * Per-resource revisions (realtimeResourceScope), keyed by realtimeScopeKey. A backend
   * without them re-projects every subscription on each organization revision.
   */
  scopeRevisions?(keys: Array<{ orgId: string; scope: string }>): Promise<Map<string, string>>;
  listen(wake: () => void): Promise<() => Promise<void>>;
}
export const realtimeMetrics = {
  connections: 0, subscriptions: 0, snapshots: 0, projectionQueries: 0,
  revisionQueries: 0, coalesced: 0, errors: 0, resyncs: 0,
  queuedBytes: 0, projectionMs: 0, rejected: 0, notifications: 0, opened: 0, fallbackRequests: 0,
};
export const realtimeCloseReasons: Record<string, number> = Object.fromEntries([
  "access_revoked", "resync_required", "projection_unavailable", "text_only", "rate_limit",
  "generation_limit", "subscription_limit", "invalid_frame", "authorization_timeout",
  "authorization_failed", "heartbeat_timeout", "transport_error", "server_restart",
].map(reason => [reason, 0]));
export const realtimeProjectionBuckets = [10, 50, 100, 250, 500, 1_000, 2_000, Infinity].map(le => ({ le, count: 0 }));
type Observer = ((data: unknown, revision: number) => Promise<void>) & { failed?: () => void; revoked?: () => void | Promise<void> };
type Entry = {
  userId: string; resource: DashboardResource; orgId: string;
  observers: Set<Observer>;
  /** Data revision of the last projection; organization revision of the last authorization. */
  version?: string; accessVersion?: string;
  revision: number; dirty: boolean;
};

/**
 * The revision scope whose changes can alter a resource's projection, or null for the
 * organization. Matches the scopes migration 0153's triggers record: a project's own
 * rows, documents, runs, suggestions and search sessions move `project:<id>`; a run's
 * row, events, stage states, documents and usage move `run:<id>`.
 */
export function realtimeResourceScope(resource: DashboardResource): string | null {
  switch (resource.kind) {
    case "run": return `run:${resource.runId}`;
    case "project": case "documents": case "suggestions": return `project:${resource.projectId}`;
    default: return null;
  }
}
export const realtimeScopeKey = (orgId: string, scope: string) => `${orgId}\u0000${scope}`;
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
    this.unlisten = await this.backend.listen(() => { realtimeMetrics.notifications++; });
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
      const scoped = new Map<string, { orgId: string; scope: string }>();
      if (this.backend.scopeRevisions) {
        for (const entry of entries) {
          const scope = realtimeResourceScope(entry.resource);
          if (scope) scoped.set(realtimeScopeKey(entry.orgId, scope), { orgId: entry.orgId, scope });
        }
      }
      const scopeVersions = scoped.size && this.backend.scopeRevisions ? await this.backend.scopeRevisions([...scoped.values()]) : new Map<string, string>();
      for (let offset = 0; offset < entries.length; offset += 8) {
        await Promise.all(entries.slice(offset, offset + 8).map(async entry => {
          const orgVersion = versions.get(entry.orgId) ?? "0";
          const scope = this.backend.scopeRevisions ? realtimeResourceScope(entry.resource) : null;
          const version = scope ? scopeVersions.get(realtimeScopeKey(entry.orgId, scope)) ?? "0" : orgVersion;
          if (!entry.dirty && version === entry.version && orgVersion === entry.accessVersion) return;
          const project = entry.dirty || version !== entry.version;
          entry.dirty = false;
          const began = Date.now();
          try {
            // Register first, then read a durable revision before the projection.
            // A concurrent commit advances the next sweep's revision, forcing a
            // second snapshot even if its notification was lost.
            // Authorization is rechecked on every organization revision (membership,
            // sharing and project changes all move it), whether or not this
            // resource's own data changed: exactly as often as before scopes.
            if (!await this.backend.authorize(entry.userId, entry.resource)) {
              for (const observer of [...entry.observers]) await observer.revoked?.();
              return;
            }
            entry.accessVersion = orgVersion;
            // Another resource of the organization changed: nothing to send.
            if (!project) return;
            realtimeMetrics.projectionQueries++;
            realtimeMetrics.coalesced += Math.max(0, entry.observers.size - 1);
            const data = await this.backend.project(entry.userId, entry.resource);
            entry.version = version;
            entry.revision++;
            await Promise.all([...entry.observers].map(observer => observer(data, entry.revision)));
            realtimeMetrics.snapshots++;
            const elapsed = Date.now() - began;
            realtimeMetrics.projectionMs += elapsed;
            for (const bucket of realtimeProjectionBuckets) if (elapsed <= bucket.le) bucket.count++;
          } catch (error) {
            entry.dirty = true; realtimeMetrics.errors++;
            for (const observer of [...entry.observers]) {
              if (error instanceof Error && ["not_found", "forbidden"].includes(error.message)) await observer.revoked?.();
              else observer.failed?.();
            }
          }
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
