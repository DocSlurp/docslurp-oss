/**
 * Autoscaler target from the worker fleet (OP-13).
 *
 * fly-autoscaler reads `docslurp_worker_target_machines` from Fly's managed
 * Prometheus. The app used to be its only source, but the app suspends when it
 * has no HTTP traffic, while the autoscaler always keeps at least one worker
 * started. So the worker maintenance leader computes the same target (shared
 * query and formula, @docslurp/shared worker-autoscale) and serves it on its
 * health port `/metrics`; the autoscaler query takes the max over both apps.
 * fly-autoscaler treats an empty result as an error and keeps the fleet as is
 * (prometheus.go: "empty prometheus result"), so a leader handover gap holds
 * rather than scales in.
 *
 * While work exists the leader also requests WORKER_APP_KEEPALIVE_URL (the
 * app's /health) so the app, which runs the alert evaluator and run-start
 * recovery, stays awake for exactly as long as there is work.
 */

import {
  formatWorkerScalerMetricLines,
  type WorkerScalerConfig,
  type WorkerScalerQueryParams,
  type WorkerScalerSnapshot,
} from "@docslurp/shared";

export interface ScalerPublisherDeps {
  isLeader: () => boolean;
  read: () => Promise<WorkerScalerSnapshot>;
  config: WorkerScalerConfig;
  params: WorkerScalerQueryParams;
  /** Requested while work exists; empty disables keep-alive. */
  keepAliveUrl?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Reuse one snapshot for this long (default 10 s, like DOCSLURP_SCALER_CACHE_MS). */
  cacheMs?: number;
}

export function hasWork(snapshot: WorkerScalerSnapshot): boolean {
  return Number(snapshot.queue_depth ?? 0) > 0
    || Number(snapshot.worker_active ?? 0) > 0
    || Number(snapshot.pending_page_tasks ?? 0) > 0;
}

export class ScalerPublisher {
  private cached: { at: number; snapshot: Promise<WorkerScalerSnapshot> } | null = null;
  private lastKeepAliveError = 0;

  constructor(private readonly deps: ScalerPublisherDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private snapshot(): Promise<WorkerScalerSnapshot> {
    const now = this.now();
    const cacheMs = this.deps.cacheMs ?? 10_000;
    if (this.cached && now - this.cached.at < cacheMs) return this.cached.snapshot;
    const snapshot = this.deps.read();
    this.cached = { at: now, snapshot };
    snapshot.catch(() => {
      if (this.cached?.snapshot === snapshot) this.cached = null;
    });
    return snapshot;
  }

  /** Prometheus text: the target only from the leader, so max() sees one worker series. */
  async metrics(): Promise<string> {
    const leader = this.deps.isLeader();
    const lines = [
      "# HELP docslurp_worker_scaler_leader 1 on the worker that publishes the autoscaler target.",
      "# TYPE docslurp_worker_scaler_leader gauge",
      `docslurp_worker_scaler_leader ${leader ? 1 : 0}`,
    ];
    if (leader) lines.push(...formatWorkerScalerMetricLines(await this.snapshot(), this.deps.config, this.deps.params));
    return `${lines.join("\n")}\n`;
  }

  /** Leader tick: keep the app awake while there is work. Never throws. */
  async tick(): Promise<{ work: boolean; pinged: boolean }> {
    if (!this.deps.isLeader()) return { work: false, pinged: false };
    let work = false;
    try {
      work = hasWork(await this.snapshot());
    } catch (error) {
      console.warn(`[scaler] demand read failed: ${error instanceof Error ? error.message : String(error)}`);
      return { work: false, pinged: false };
    }
    const url = this.deps.keepAliveUrl?.trim();
    if (!work || !url) return { work, pinged: false };
    try {
      const response = await (this.deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "docslurp-worker-keepalive" } });
      await response.body?.cancel().catch(() => {});
      return { work, pinged: true };
    } catch (error) {
      const now = this.now();
      if (now - this.lastKeepAliveError > 10 * 60_000) {
        this.lastKeepAliveError = now;
        console.warn(`[scaler] app keep-alive ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { work, pinged: false };
    }
  }
}
