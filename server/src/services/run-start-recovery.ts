import { withBackgroundSpan } from "@docslurp/shared/observability";
import {
  defaultPipelineFeatures,
  type PipelineFeatures,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";
import {
  isTemporalClientConnected,
  onTemporalClientConnected,
  warmTemporalClient,
} from "../lib/temporal.js";
import { isMaintenanceSweepEnabled } from "./maintenance-sweeper.js";
import { sweepInterruptedRunCreations } from "./run-creation.js";
import { resumeBlockedRuns } from "./blocked-runs.js";
import { pruneDrainedIndexConfigs } from "../search/index-serving.js";
import { runLifecycle, type RunLifecycle } from "./run-lifecycle.js";
import { sweepStaleQueuedRuns } from "./stale-queued-runs.js";

/**
 * Run-start recovery: start queued Runs whose Temporal workflow start was
 * never confirmed (workflow_started_at is null), within seconds rather than
 * after the 10-minute stale-queued grace window.
 *
 * A start goes unconfirmed when Temporal was unreachable at intake (Run
 * Lifecycle defers it and schedules workflow_start_next_at with backoff), or
 * when intake died after publishing a complete Run and before starting it.
 * Unpublished Runs are never eligible; expired creation leases are cleaned.
 * Runs that are queued while waiting for worker slots have a confirmed start
 * and are never touched here.
 *
 * Triggers: once at boot, on a short interval (independent of the general
 * maintenance sweeper), and immediately whenever the Temporal client
 * (re)connects. Safe across app instances: due Runs are claimed with
 * FOR UPDATE SKIP LOCKED and leased by pushing workflow_start_next_at, and
 * workflow IDs are run-scoped, so a racing start resolves to "already started".
 */

export interface RunStartRecoveryConfig {
  /** Runs claimed per pass. */
  batchSize: number;
  /** How long a claim hides a Run from other instances while it is started. */
  leaseMs: number;
}

export function resolveRunStartRecoveryConfig(env: NodeJS.ProcessEnv = process.env): RunStartRecoveryConfig & {
  intervalMs: number;
} {
  const num = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    intervalMs: Math.max(0, num(env.RUN_START_RECOVERY_INTERVAL_MS, 5_000)),
    batchSize: Math.max(1, Math.min(500, num(env.RUN_START_RECOVERY_BATCH_SIZE, 25))),
    leaseMs: 30_000,
  };
}

type PendingStartRow = { id: string; pipeline: PipelineFeatures | null };

export type RunStartRecoveryPass = {
  claimed: number;
  started: number;
  deferred: number;
  failed: number;
};

export function createRunStartRecovery(deps: {
  sql: SqlClient;
  lifecycle: Pick<RunLifecycle, "start">;
  config: RunStartRecoveryConfig;
}) {
  const { sql, lifecycle, config } = deps;

  async function claimDue(ignoreBackoff: boolean): Promise<PendingStartRow[]> {
    return await sql<PendingStartRow[]>`
      with due as (
        select id
        from workspace_runs
        where status = 'queued'
          and workflow_started_at is null
          and kind <> 'materialize'
          and coalesce(control_state, '') not in ('paused', 'pause_requested', 'cancelled', 'cancel_requested', 'dead-letter')
          and creation_ready_at is not null
          and (
            ${ignoreBackoff}
            or workflow_start_next_at is null
            or workflow_start_next_at <= now()
          )
        order by created_at asc
        limit ${config.batchSize}
        for update skip locked
      )
      update workspace_runs r
      set workflow_start_next_at = now() + (${config.leaseMs} * interval '1 millisecond')
      from due
      where r.id = due.id
      returning r.id, r.pipeline
    `;
  }

  async function releaseClaims(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    // Temporal is unreachable: retry these on the next pass or connect, not after the lease.
    await sql`
      update workspace_runs
      set workflow_start_next_at = now()
      where id = any(${ids})
        and workflow_started_at is null
    `;
  }

  async function sweepOnce(options: { ignoreBackoff?: boolean } = {}): Promise<RunStartRecoveryPass> {
    await sweepInterruptedRunCreations(sql);
    // Blocked config-change jobs become queued once their org can spend; the claim below starts them.
    await resumeBlockedRuns({ sql }).catch((error: unknown) => {
      console.error(`[run-start-recovery] blocked-run resume failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    // Re-index runs that finished leave index configs no document uses; drop them from the serving map.
    await pruneDrainedIndexConfigs(sql).catch((error: unknown) => {
      console.error(`[run-start-recovery] index-config prune failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const rows = await claimDue(options.ignoreBackoff === true);
    const pass: RunStartRecoveryPass = { claimed: rows.length, started: 0, deferred: 0, failed: 0 };
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      try {
        const outcome = await lifecycle.start({ id: row.id, pipeline: row.pipeline ?? defaultPipelineFeatures });
        if (outcome.status === "deferred") {
          pass.deferred += 1;
          // One deferral means Temporal is down; do not spend a connect
          // timeout per remaining Run. The connect listener retries them.
          await releaseClaims(rows.slice(index + 1).map((rest) => rest.id));
          break;
        }
        pass.started += 1;
        console.log(`[run-start-recovery] runId=${row.id} workflow ${outcome.status}`);
      } catch (error) {
        // Lifecycle already scheduled a backed-off retry for this Run.
        pass.failed += 1;
        console.error(
          `[run-start-recovery] runId=${row.id} start failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (pass.deferred > 0 || pass.failed > 0) {
      console.warn(
        `[run-start-recovery] claimed=${pass.claimed} started=${pass.started} deferred=${pass.deferred} failed=${pass.failed}`,
      );
    }
    return pass;
  }

  // Single-flight per process; a kick during a pass schedules one more pass
  // so a connect that lands mid-pass is not lost.
  let inFlight: Promise<RunStartRecoveryPass> | null = null;
  let rerun: { ignoreBackoff: boolean } | null = null;

  function kick(options: { ignoreBackoff?: boolean } = {}): Promise<RunStartRecoveryPass> {
    if (inFlight) {
      rerun = { ignoreBackoff: (rerun?.ignoreBackoff ?? false) || options.ignoreBackoff === true };
      return inFlight;
    }
    const current = (async () => {
      let last = await sweepOnce(options);
      const total = { ...last };
      // Keep draining after a full batch, or once more if kicked mid-pass.
      while (rerun || (last.claimed >= config.batchSize && last.deferred === 0)) {
        const next = rerun ?? { ignoreBackoff: false };
        rerun = null;
        last = await sweepOnce(next);
        total.claimed += last.claimed;
        total.started += last.started;
        total.deferred += last.deferred;
        total.failed += last.failed;
      }
      return total;
    })();
    inFlight = current;
    void current.then(
      () => { inFlight = null; },
      () => { inFlight = null; rerun = null; },
    );
    return current;
  }

  return { sweepOnce, kick };
}

export type RunStartRecovery = ReturnType<typeof createRunStartRecovery>;

const config = resolveRunStartRecoveryConfig();

export const runStartRecovery: RunStartRecovery = createRunStartRecovery({
  sql: defaultSql,
  lifecycle: runLifecycle,
  config,
});

function logSweepError(name: string) {
  return (error: unknown) => {
    console.error(`[${name}] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * Boot hook (ensureApiStartup): warm the Temporal client with the longer
 * background deadline, start pending and stale queued Runs once, then keep
 * kicking pending Runs on RUN_START_RECOVERY_INTERVAL_MS and on every Temporal
 * (re)connect. Runs even when the maintenance sweeper is disabled; in that case
 * it also runs the stale-queued sweep (24 h fail-safe, lost workflows) once a
 * minute so that recovery never depends on MAINTENANCE_SWEEP_INTERVAL_MS.
 * RUN_START_RECOVERY_INTERVAL_MS=0 disables the interval only; the boot pass
 * and connect kicks still run.
 */
export function startRunStartRecovery(): void {
  if (unsubscribe) return;
  const kick = (options?: { ignoreBackoff?: boolean }) => {
    withBackgroundSpan("api.run-start-recovery", () => runStartRecovery.kick(options)).catch(logSweepError("run-start-recovery"));
  };
  unsubscribe = onTemporalClientConnected(() => kick({ ignoreBackoff: true }));

  void (async () => {
    // A connected client makes the boot pass's starts succeed (and the
    // connect listener already kicks it); the pass also covers Temporal-down boots.
    await warmTemporalClient();
    kick();
    sweepStaleQueuedRuns().catch(logSweepError("stale-queued-run-sweep"));
  })();

  if (config.intervalMs === 0 || timer) return;
  const staleEveryTicks = Math.max(1, Math.round(60_000 / config.intervalMs));
  let tick = 0;
  timer = setInterval(() => {
    tick += 1;
    // Reconnect in the background so a recovered Temporal fires the connect kick.
    if (!isTemporalClientConnected()) void warmTemporalClient();
    kick();
    if (!isMaintenanceSweepEnabled() && tick % staleEveryTicks === 0) {
      withBackgroundSpan("api.stale-queued-run-sweep", () => sweepStaleQueuedRuns()).catch(logSweepError("stale-queued-run-sweep"));
    }
  }, config.intervalMs);
  timer.unref?.();
}

/** Test hook: stop the interval and the connect listener. */
export function stopRunStartRecovery(): void {
  if (timer) clearInterval(timer);
  timer = null;
  unsubscribe?.();
  unsubscribe = null;
}
