import type { AlertCheck } from "./alert-rules.js";

/**
 * App-side fallback for an unhealthy autoscaler
 * (docs/scaling-1000-workers.md#autoscaler-failure-modes): when the alert
 * evaluator sees runs waiting with no live worker pollers
 * (worker-pollers-missing firing) and no worker machine is started, start
 * one stopped machine through the Fly Machines API. That worker becomes the
 * maintenance leader, publishes the scaling target and the autoscaler takes
 * over again. The autoscaler's watchdog (ops/autoscaler/watchdog.mjs) does
 * the same from the other side; either one is enough.
 *
 * Off unless FLY_WORKER_API_TOKEN is set (a deploy token scoped to the worker
 * app: `fly tokens create deploy -a docslurp-worker`). FLY_WORKER_APP names
 * the app (default docslurp-worker). At most one start per
 * WORKER_FLOOR_COOLDOWN_MS (default 5 min) per app instance.
 */

type Env = Record<string, string | undefined>;

interface FlyMachine {
  id: string;
  state?: string;
}

export interface WorkerFloorConfig {
  token: string;
  app: string;
  cooldownMs: number;
  apiBase: string;
}

export function resolveWorkerFloorConfig(env: Env = process.env): WorkerFloorConfig | null {
  const token = env.FLY_WORKER_API_TOKEN?.trim();
  if (!token) return null;
  const cooldown = Number(env.WORKER_FLOOR_COOLDOWN_MS);
  return {
    token,
    app: env.FLY_WORKER_APP?.trim() || "docslurp-worker",
    cooldownMs: Number.isFinite(cooldown) && cooldown >= 60_000 ? cooldown : 5 * 60_000,
    apiBase: env.FLY_MACHINES_API_BASE?.trim() || "https://api.machines.dev",
  };
}

function authorization(token: string): string {
  return token.startsWith("FlyV1 ") ? token : `Bearer ${token}`;
}

const TRANSITIONAL = new Set(["starting", "created", "replacing", "updating", "launching"]);

/** Pure: the machine to start, or why not. */
export function pickWorkerToStart(machines: FlyMachine[]): { machineId: string } | { skip: string } {
  if (machines.some((machine) => machine.state === "started")) return { skip: "a worker machine is already started" };
  if (machines.some((machine) => TRANSITIONAL.has(machine.state ?? ""))) return { skip: "worker machines are transitioning" };
  const stopped = machines
    .filter((machine) => machine.state === "stopped" || machine.state === "suspended")
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  return stopped ? { machineId: stopped.id } : { skip: "no stopped worker machine" };
}

export class WorkerFloorFallback {
  private lastAttemptAt = -Infinity;
  private running = false;

  constructor(
    private readonly config: WorkerFloorConfig | null = resolveWorkerFloorConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly log: (line: string) => void = (line) => console.warn(line),
  ) {}

  /** Never throws. Returns the started machine id, or null. */
  async evaluate(checks: AlertCheck[]): Promise<string | null> {
    const config = this.config;
    if (!config || this.running) return null;
    const missing = checks.find((check) => check.id === "worker-pollers-missing");
    if (!missing || missing.state !== "firing") return null;
    if (this.now() - this.lastAttemptAt < config.cooldownMs) return null;
    this.lastAttemptAt = this.now();
    this.running = true;
    const base = `${config.apiBase}/v1/apps/${encodeURIComponent(config.app)}/machines`;
    try {
      const list = await this.fetchImpl(base, { headers: { authorization: authorization(config.token) }, signal: AbortSignal.timeout(15_000) });
      if (!list.ok) throw new Error(`list machines: HTTP ${list.status}`);
      const pick = pickWorkerToStart((await list.json()) as FlyMachine[]);
      if ("skip" in pick) {
        this.log(`[worker-floor] runs waiting without worker pollers; not starting a machine: ${pick.skip}`);
        return null;
      }
      const started = await this.fetchImpl(`${base}/${encodeURIComponent(pick.machineId)}/start`, {
        method: "POST",
        headers: { authorization: authorization(config.token) },
        signal: AbortSignal.timeout(30_000),
      });
      if (!started.ok) throw new Error(`start ${pick.machineId}: HTTP ${started.status}`);
      this.log(`[worker-floor] runs waiting without worker pollers; started ${config.app} machine ${pick.machineId} (autoscaler not keeping a worker up?)`);
      return pick.machineId;
    } catch (error) {
      // Messages carry status codes and machine ids only, never the token.
      this.log(`[worker-floor] fallback failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
