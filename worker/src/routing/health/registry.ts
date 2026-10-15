/**
 * Per-process decision-model health registry.
 *
 * A healthy canary result is trusted for `ttlMs`; a failed canary or a runtime
 * degeneracy report marks the model unhealthy for a backoff window that doubles
 * on consecutive failures (capped). After the window one canary re-probes the
 * model (half-open); concurrent callers share that single probe.
 */

import type { DecisionModel } from "@docslurp/shared";

import type { CanaryResult } from "./canary.js";

export interface HealthRecord {
  healthy: boolean;
  reason: string;
  checkedAt: number;
  /** Healthy: end of the trust window. Unhealthy: end of the backoff window. */
  until: number;
  consecutiveFailures: number;
}

export class DecisionModelUnhealthyError extends Error {
  readonly code = "DECISION_MODEL_UNHEALTHY";
  constructor(readonly modelId: string, readonly reason: string, readonly cached: boolean) {
    super(`${modelId} unhealthy${cached ? " (cached)" : ""}: ${reason}`);
    this.name = "DecisionModelUnhealthyError";
  }
}

export interface HealthRegistryOptions {
  ttlMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export const DEFAULT_HEALTH_TTL_MS = 10 * 60_000;
export const DEFAULT_HEALTH_BACKOFF_MS = 5 * 60_000;
export const DEFAULT_HEALTH_MAX_BACKOFF_MS = 60 * 60_000;

export class DecisionModelHealthRegistry {
  private readonly records = new Map<string, HealthRecord>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly ttlMs: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;

  constructor(options: HealthRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_HEALTH_TTL_MS;
    this.backoffMs = options.backoffMs ?? DEFAULT_HEALTH_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_HEALTH_MAX_BACKOFF_MS;
    this.now = options.now ?? Date.now;
  }

  status(modelId: string): HealthRecord | undefined {
    const record = this.records.get(modelId);
    return record ? { ...record } : undefined;
  }

  markHealthy(modelId: string, reason = "ok"): void {
    const at = this.now();
    this.records.set(modelId, { healthy: true, reason, checkedAt: at, until: at + this.ttlMs, consecutiveFailures: 0 });
  }

  markUnhealthy(modelId: string, reason: string): void {
    const at = this.now();
    const failures = (this.records.get(modelId)?.consecutiveFailures ?? 0) + 1;
    const backoff = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** (failures - 1));
    this.records.set(modelId, { healthy: false, reason, checkedAt: at, until: at + backoff, consecutiveFailures: failures });
  }

  reset(): void {
    this.records.clear();
    this.inflight.clear();
  }

  /**
   * Resolves when the model is healthy (cached or freshly probed); throws DecisionModelUnhealthyError otherwise.
   * `probe` runs the canary and may throw (timeout, 5xx, ...), which counts as a failed probe.
   */
  async ensureHealthy(model: DecisionModel, probe: () => Promise<CanaryResult>): Promise<void> {
    const cached = this.records.get(model.id);
    const at = this.now();
    if (cached && at < cached.until) {
      if (cached.healthy) return;
      throw new DecisionModelUnhealthyError(model.id, cached.reason, true);
    }
    let pending = this.inflight.get(model.id);
    if (!pending) {
      pending = (async () => {
        try {
          const result = await probe();
          if (result.healthy) this.markHealthy(model.id, result.reason);
          else this.markUnhealthy(model.id, result.reason);
        } catch (error) {
          this.markUnhealthy(model.id, `canary failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
        }
      })().finally(() => this.inflight.delete(model.id));
      this.inflight.set(model.id, pending);
    }
    await pending;
    const after = this.records.get(model.id);
    if (!after?.healthy) throw new DecisionModelUnhealthyError(model.id, after?.reason ?? "unknown", false);
  }
}

/** Process-wide registry used by the worker; tests construct their own. */
export const decisionModelHealth = new DecisionModelHealthRegistry();
