import { withBackgroundSpan } from "@docslurp/shared/observability";
import {
  DEFAULT_FLEET_CAPABILITY_OPTIONS,
  gatedFeatureStates,
  intersectFleetCapabilities,
  resolveCreditLeaseConfig,
  type FleetCapabilityOptions,
  type FleetCapabilitySnapshot,
  type FleetPoller,
  type GatedFeatureState,
  type WorkerCapability,
  type WorkerCapabilityRecord,
} from "@docslurp/shared";

import { sql } from "../db.js";

/**
 * App side of the worker capability handshake
 * (packages/shared/src/worker-capabilities.ts, docs/releases.md#app-and-worker-skew).
 *
 * A gated flag (WORKER_INDEX_BEFORE_ENRICH, WORKER_GROUP_ADJACENT_STAGES,
 * WORKER_CREDIT_LEASES, SEARCH_EARLY_LEXICAL) takes effect only when it is
 * configured on and every worker that can pick up the run advertises the
 * matching capability. Resolution is cached per task queue
 * (WORKER_CAPABILITY_CACHE_MS, default 15 s) and fail-safe: Temporal or the
 * registry being unreachable, or a timeout, resolves to no capabilities.
 *
 * WORKER_CAPABILITY_GATE=off turns the gate off (the configured flag alone
 * decides, as before this handshake). It defaults on except under
 * NODE_ENV=test, where unit tests drive flags directly.
 */

type Env = Record<string, string | undefined>;

function envFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  return !["0", "false", "off", "no"].includes(normalized);
}

function readMs(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export function capabilityGateEnabled(env: Env = process.env): boolean {
  return envFlag(env.WORKER_CAPABILITY_GATE, env.NODE_ENV !== "test");
}

export function fleetCapabilityOptions(env: Env = process.env): FleetCapabilityOptions {
  const d = DEFAULT_FLEET_CAPABILITY_OPTIONS;
  const fallback = env.WORKER_CAPABILITY_IDLE_FALLBACK?.trim().toLowerCase();
  return {
    liveWindowMs: readMs(env, "WORKER_CAPABILITY_LIVE_WINDOW_MS", d.liveWindowMs, 15_000, 15 * 60_000),
    recentWindowMs: readMs(env, "WORKER_CAPABILITY_RECENT_WINDOW_MS", d.recentWindowMs, 60_000, 7 * 24 * 60 * 60_000),
    pollerStaleMs: readMs(env, "ALERT_POLLER_STALE_MS", d.pollerStaleMs, 1_000, 15 * 60_000),
    idleFallback: fallback === "none" ? "none" : "recent",
  };
}

/** The pipeline task queue (TEMPORAL_TASK_QUEUE), without loading the Temporal client. */
export function defaultPipelineTaskQueue(env: Env = process.env): string {
  return env.TEMPORAL_TASK_QUEUE?.trim() || "docslurp-pipeline";
}

/**
 * Load-test routing (TEMPORAL_LOADTEST_TASK_QUEUE / TEMPORAL_LOADTEST_ORG_IDS):
 * listed orgs run on the load-test fleet's queue, everyone else on the default.
 */
export function taskQueueForOrgKey(
  orgKey: string | null | undefined,
  defaultQueue: string = defaultPipelineTaskQueue(),
  env: Env = process.env,
): { taskQueue: string; loadtest: boolean } {
  const loadtestQueue = env.TEMPORAL_LOADTEST_TASK_QUEUE?.trim();
  if (!loadtestQueue || !orgKey) return { taskQueue: defaultQueue, loadtest: false };
  const orgs = new Set((env.TEMPORAL_LOADTEST_ORG_IDS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  return orgs.has(orgKey) ? { taskQueue: loadtestQueue, loadtest: true } : { taskQueue: defaultQueue, loadtest: false };
}

/** Configured (env) value of every gated flag, with each flag's own default. */
export function configuredGatedFlags(env: Env = process.env): Record<string, boolean> {
  const nonProduction = env.NODE_ENV !== "production";
  const earlyLexical = env.SEARCH_EARLY_LEXICAL?.trim().toLowerCase() ?? "";
  return {
    WORKER_INDEX_BEFORE_ENRICH: envFlag(env.WORKER_INDEX_BEFORE_ENRICH, nonProduction),
    WORKER_GROUP_ADJACENT_STAGES: envFlag(env.WORKER_GROUP_LIGHT_STAGES, true) && envFlag(env.WORKER_GROUP_ADJACENT_STAGES, nonProduction),
    WORKER_CREDIT_LEASES: resolveCreditLeaseConfig(env).enabled,
    SEARCH_EARLY_LEXICAL: ["1", "true", "on", "yes"].includes(earlyLexical)
      ? true
      : ["0", "false", "off", "no"].includes(earlyLexical)
        ? false
        : nonProduction,
  };
}

export interface FleetDeps {
  /** Registry rows for `taskQueue` seen within `recentWindowMs`; lastSeenAt on the app clock. */
  readRecords: (taskQueue: string, recentWindowMs: number, now: number) => Promise<WorkerCapabilityRecord[]>;
  /** Live pollers on the queues serving `taskQueue`. Throws when Temporal is unreachable. */
  readPollers: (taskQueue: string) => Promise<FleetPoller[]>;
  now: () => number;
  log: (line: string) => void;
}

async function readRecordsFromDb(taskQueue: string, recentWindowMs: number, now: number): Promise<WorkerCapabilityRecord[]> {
  // Ages come from the database clock, so app/database skew cannot make rows look fresh.
  const rows = await sql<{
    instance_id: string;
    identity: string;
    task_queue: string;
    build_id: string | null;
    protocol: number;
    capabilities: string[] | null;
    age_ms: number | string;
    stopped_age_ms: number | string | null;
  }[]>`
    select instance_id, identity, task_queue, build_id, protocol, capabilities,
      extract(epoch from (now() - last_seen_at)) * 1000 as age_ms,
      extract(epoch from (now() - stopped_at)) * 1000 as stopped_age_ms
    from worker_capabilities
    where task_queue = ${taskQueue}
      and last_seen_at > now() - (${Math.round(recentWindowMs)} * interval '1 millisecond')
    order by last_seen_at desc
    limit 2000
  `;
  return rows.map((row) => ({
    instanceId: row.instance_id,
    identity: row.identity,
    taskQueue: row.task_queue,
    buildId: row.build_id,
    protocol: Number(row.protocol),
    capabilities: row.capabilities ?? [],
    lastSeenAt: now - Number(row.age_ms),
    stoppedAt: row.stopped_age_ms === null ? null : now - Number(row.stopped_age_ms),
  }));
}

async function readPollersFromTemporal(taskQueue: string): Promise<FleetPoller[]> {
  // Lazy: keeps the Temporal client out of the search import path.
  const { describeTaskQueuePollers, workerTaskQueues } = await import("../lib/temporal.js");
  const fleet = workerTaskQueues();
  const queues: Array<{ name: string; type: "workflow" | "activity" }> =
    taskQueue === defaultPipelineTaskQueue() && fleet.length > 1
      ? fleet
      : [{ name: taskQueue, type: "workflow" }, { name: taskQueue, type: "activity" }];
  const results = await Promise.all(queues.map((queue) => describeTaskQueuePollers(queue.name, queue.type, 2_000)));
  return results.flat();
}

const defaultDeps: FleetDeps = {
  readRecords: readRecordsFromDb,
  readPollers: readPollersFromTemporal,
  now: () => Date.now(),
  log: (line) => console.log(line),
};

function unknownSnapshot(reason: string): FleetCapabilitySnapshot {
  return { capabilities: [], basis: "unknown", reason, workers: [] };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

interface CacheEntry {
  at: number;
  ttlMs: number;
  snapshot: FleetCapabilitySnapshot;
}

export class WorkerFleetCapabilities {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<FleetCapabilitySnapshot>>();
  private readonly lastLogged = new Map<string, string>();
  private readonly failureLoggedAt = new Map<string, number>();

  constructor(
    private readonly deps: FleetDeps = defaultDeps,
    private readonly env: Env = process.env,
  ) {}

  private get cacheMs(): number {
    return readMs(this.env, "WORKER_CAPABILITY_CACHE_MS", 15_000, 1_000, 5 * 60_000);
  }

  /** At most one log line a minute per failure kind and queue. */
  private logFailure(key: string, line: string): void {
    const now = this.deps.now();
    if (now - (this.failureLoggedAt.get(key) ?? -Infinity) < 60_000) return;
    this.failureLoggedAt.set(key, now);
    this.deps.log(line);
  }

  private async compute(taskQueue: string): Promise<FleetCapabilitySnapshot> {
    const options = fleetCapabilityOptions(this.env);
    const now = this.deps.now();
    const [records, pollers] = await Promise.all([
      this.deps.readRecords(taskQueue, options.recentWindowMs, now).catch((error: unknown) => {
        this.logFailure(`registry:${taskQueue}`, `[worker-fleet] capability registry unavailable queue=${taskQueue}: ${errorMessage(error)}`);
        return null;
      }),
      this.deps.readPollers(taskQueue).catch((error: unknown) => {
        this.logFailure(`pollers:${taskQueue}`, `[worker-fleet] Temporal pollers unavailable queue=${taskQueue}: ${errorMessage(error)}`);
        return null;
      }),
    ]);
    if (records === null) return unknownSnapshot("capability registry unavailable");
    return intersectFleetCapabilities({ now, records, pollers, options });
  }

  private logChange(taskQueue: string, snapshot: FleetCapabilitySnapshot): void {
    const states = gatedFeatureStates(configuredGatedFlags(this.env), new Set(snapshot.capabilities));
    const heldBack = states.filter((state) => state.configured && !state.effective);
    const signature = `${snapshot.basis}|${snapshot.capabilities.join(",")}|${heldBack.map((state) => state.flag).join(",")}`;
    if (this.lastLogged.get(taskQueue) === signature) return;
    this.lastLogged.set(taskQueue, signature);
    this.deps.log(
      `[worker-fleet] queue=${taskQueue} basis=${snapshot.basis} capabilities=${snapshot.capabilities.join(",") || "none"} ` +
      `workers=${snapshot.workers.length} builds=${[...new Set(snapshot.workers.map((worker) => worker.buildId ?? "unknown"))].join(",") || "none"} ` +
      `reason=${JSON.stringify(snapshot.reason)}`,
    );
    for (const state of heldBack) {
      const blocker = snapshot.workers.find((worker) => !worker.capabilities.includes(state.capability));
      this.deps.log(
        `[worker-fleet] ${state.flag} is configured on but held back on queue=${taskQueue}: ` +
        (blocker
          ? `worker ${blocker.identity} (build ${blocker.buildId ?? "unknown"}) lacks ${state.capability}${blocker.note ? ` (${blocker.note})` : ""}`
          : snapshot.reason),
      );
    }
  }

  /** Fresh (cached up to WORKER_CAPABILITY_CACHE_MS) snapshot for a task queue. Never throws. */
  async resolve(taskQueue: string = defaultPipelineTaskQueue(this.env)): Promise<FleetCapabilitySnapshot> {
    const now = this.deps.now();
    const cached = this.cache.get(taskQueue);
    if (cached && now - cached.at < cached.ttlMs) return cached.snapshot;
    const pending = this.inflight.get(taskQueue);
    if (pending) return pending;
    const timeoutMs = 4_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.race([
      this.compute(taskQueue),
      new Promise<FleetCapabilitySnapshot>((resolve) => {
        timer = setTimeout(() => resolve(unknownSnapshot(`capability check timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ])
      .catch((error: unknown) => unknownSnapshot(`capability check failed: ${errorMessage(error)}`))
      .then((snapshot) => {
        // Unknown answers are retried sooner than settled ones.
        const ttlMs = snapshot.basis === "unknown" ? Math.min(5_000, this.cacheMs) : this.cacheMs;
        this.cache.set(taskQueue, { at: this.deps.now(), ttlMs, snapshot });
        this.logChange(taskQueue, snapshot);
        return snapshot;
      })
      .finally(() => {
        clearTimeout(timer);
        this.inflight.delete(taskQueue);
      });
    this.inflight.set(taskQueue, work);
    return work;
  }

  /**
   * Synchronous view for hot paths (search): the cached snapshot when it is
   * at most 4 cache periods old, else unknown. Starts a refresh when stale.
   */
  peek(taskQueue: string = defaultPipelineTaskQueue(this.env)): FleetCapabilitySnapshot {
    const now = this.deps.now();
    const cached = this.cache.get(taskQueue);
    if (!cached || now - cached.at >= cached.ttlMs) void this.resolve(taskQueue);
    if (cached && now - cached.at < this.cacheMs * 4) return cached.snapshot;
    return unknownSnapshot("no recent capability snapshot");
  }

  /** Test hook. */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
    this.lastLogged.clear();
    this.failureLoggedAt.clear();
  }
}

let shared: WorkerFleetCapabilities | null = null;

export function workerFleet(): WorkerFleetCapabilities {
  shared ??= new WorkerFleetCapabilities();
  return shared;
}

/** Test hook. */
export function setWorkerFleet(fleet: WorkerFleetCapabilities | null): void {
  shared = fleet;
}

/**
 * Capabilities the app may rely on for `taskQueue`, or null when the gate is
 * off (the configured flags alone decide). Never throws.
 */
export async function effectiveFleetCapabilities(
  taskQueue?: string,
  env: Env = process.env,
): Promise<ReadonlySet<WorkerCapability> | null> {
  if (!capabilityGateEnabled(env)) return null;
  return new Set((await workerFleet().resolve(taskQueue)).capabilities);
}

/** Synchronous form for hot paths; unknown or stale resolves to no capabilities. */
export function effectiveFleetCapabilitiesSync(
  taskQueue?: string,
  env: Env = process.env,
): ReadonlySet<WorkerCapability> | null {
  if (!capabilityGateEnabled(env)) return null;
  return new Set(workerFleet().peek(taskQueue).capabilities);
}

/** True when `capability` may be used (gate off, or every worker supports it). */
export async function fleetSupports(capability: WorkerCapability, taskQueue?: string): Promise<boolean> {
  const capabilities = await effectiveFleetCapabilities(taskQueue);
  return capabilities === null || capabilities.has(capability);
}

/**
 * Synchronous form of fleetSupports for request paths that must not wait on
 * Temporal (run admission): a stale or missing snapshot counts as unsupported
 * and starts a refresh in the background.
 */
export function fleetSupportsNow(capability: WorkerCapability, taskQueue?: string): boolean {
  const capabilities = effectiveFleetCapabilitiesSync(taskQueue);
  return capabilities === null || capabilities.has(capability);
}

export interface WorkerFleetReport {
  gate: boolean;
  taskQueue: string;
  basis: FleetCapabilitySnapshot["basis"];
  reason: string;
  capabilities: WorkerCapability[];
  features: GatedFeatureState[];
  workers: FleetCapabilitySnapshot["workers"];
  checkedAt: string;
}

/** Operator view (GET /ops/worker-fleet, /metrics): configured vs effective flags. */
export async function workerFleetReport(taskQueue?: string, env: Env = process.env): Promise<WorkerFleetReport> {
  const queue = taskQueue ?? defaultPipelineTaskQueue(env);
  const gate = capabilityGateEnabled(env);
  const snapshot = gate ? await workerFleet().resolve(queue) : unknownSnapshot("WORKER_CAPABILITY_GATE is off; configured flags apply as-is");
  return {
    gate,
    taskQueue: queue,
    basis: snapshot.basis,
    reason: snapshot.reason,
    capabilities: snapshot.capabilities,
    features: gatedFeatureStates(configuredGatedFlags(env), gate ? new Set(snapshot.capabilities) : null),
    workers: snapshot.workers,
    checkedAt: new Date().toISOString(),
  };
}

let refresher: ReturnType<typeof setInterval> | null = null;

/**
 * Keep the default queue's snapshot warm so synchronous readers (run
 * admission, search) see a current view. Only runs when the gate is on and a
 * gated flag is configured; a no-op otherwise.
 */
export function startWorkerFleetRefresher(env: Env = process.env): void {
  stopWorkerFleetRefresher();
  if (!capabilityGateEnabled(env)) return;
  if (!Object.values(configuredGatedFlags(env)).some(Boolean)) return;
  const intervalMs = readMs(env, "WORKER_CAPABILITY_CACHE_MS", 15_000, 1_000, 5 * 60_000);
  void workerFleet().resolve();
  refresher = setInterval(() => void withBackgroundSpan("api.worker-fleet-refresh", () => workerFleet().resolve()), intervalMs);
  refresher.unref?.();
}

export function stopWorkerFleetRefresher(): void {
  if (refresher) clearInterval(refresher);
  refresher = null;
}
