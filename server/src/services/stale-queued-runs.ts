import {
  defaultPipelineFeatures,
  type PipelineFeatures,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { runLifecycle } from "./run-lifecycle.js";

/**
 * Stale queued-run recovery: the slow backstop. Runs whose workflow start was
 * never confirmed are started within seconds by run-start recovery
 * (run-start-recovery.ts); this sweep retries any Run still queued after a
 * cold-start grace window (for example, a workflow that closed without the
 * worker updating SQL) and fails Runs after a fail-safe window. Starting and
 * failing go through the Run Lifecycle so the fail-safe keeps the same
 * failure_count and dead-letter bookkeeping as worker failures. The sweep runs
 * at boot, from the maintenance sweeper (or run-start recovery when that is
 * disabled), and from the Fly scaler metrics scrape; it is single-flight per process, and Temporal's
 * run-scoped workflow IDs dedupe concurrent starts across processes.
 */

type StaleQueuedRunRow = {
  id: string;
  user_id: string;
  pipeline: PipelineFeatures | null;
  stage: string;
  total_documents: number;
  created_at: string | Date;
  updated_at: string | Date;
  stats: Record<string, unknown> | null;
};

const STALE_QUEUED_RUN_SWEEP_LIMIT = Math.max(
  1,
  Number(process.env.STALE_QUEUED_RUN_SWEEP_LIMIT ?? 8),
);
const STALE_QUEUED_RUN_COLD_START_GRACE_MS = Math.max(
  60_000,
  Number(process.env.STALE_QUEUED_RUN_COLD_START_GRACE_MS ?? 10 * 60_000),
);
const STUCK_QUEUED_RUN_FAIL_AFTER_MS = Math.max(
  STALE_QUEUED_RUN_COLD_START_GRACE_MS,
  Number(process.env.STUCK_QUEUED_RUN_FAIL_AFTER_MS ?? 24 * 60 * 60_000),
);
function staleQueueRecoveryStats(rawStats: Record<string, unknown> | null): {
  attempts: number;
} {
  const recovery = rawStats?.staleQueueRecovery;
  if (!recovery || typeof recovery !== "object") {
    return { attempts: 0 };
  }
  const attempts = Number((recovery as { attempts?: unknown }).attempts ?? 0);
  return { attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0 };
}

function queuedRunAgeMs(row: Pick<StaleQueuedRunRow, "created_at">, nowMs = Date.now()): number {
  const createdAtMs = new Date(row.created_at).getTime();
  return Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : 0;
}

async function failStuckQueuedRun(row: StaleQueuedRunRow, message: string): Promise<void> {
  await runLifecycle.fail(row.id, {
    stage: row.stage,
    message,
    fromStatuses: ["queued"],
    skipControlStates: ["paused", "cancelled", "dead-letter"],
    stats: {
      staleQueueRecovery: {
        ...staleQueueRecoveryStats(row.stats),
        failedAt: new Date().toISOString(),
        reason: message,
      },
    },
    payload: { reason: "stale-queued-run-sweep" },
  });
}

async function markStaleQueuedRunRecoveryAttempt(
  row: StaleQueuedRunRow,
  input: { status: "started" | "deferred" | "failed"; message: string },
): Promise<void> {
  const previous = staleQueueRecoveryStats(row.stats);
  const nextStats = {
    ...(row.stats && typeof row.stats === "object" && !Array.isArray(row.stats) ? row.stats : {}),
    staleQueueRecovery: {
      attempts: previous.attempts + 1,
      lastStatus: input.status,
      lastMessage: input.message,
      lastAttemptedAt: new Date().toISOString(),
    },
  };

  await sql`
    update workspace_runs
    set
      stats = ${sql.json(JSON.parse(JSON.stringify(nextStats)))}::jsonb,
      updated_at = now()
    where id = ${row.id}
      and status = 'queued'
  `;
}

async function recoverStaleQueuedRun(row: StaleQueuedRunRow): Promise<void> {
  const ageMs = queuedRunAgeMs(row);
  if (ageMs < STALE_QUEUED_RUN_COLD_START_GRACE_MS) {
    return;
  }

  if (ageMs >= STUCK_QUEUED_RUN_FAIL_AFTER_MS) {
    await failStuckQueuedRun(
      row,
      "Queued run exceeded the stale queue fail-safe window before processing began. Marked failed so it no longer blocks ingestion scaling.",
    );
    return;
  }

  try {
    const start = await runLifecycle.start({
      id: row.id,
      pipeline: row.pipeline ?? defaultPipelineFeatures,
    });
    await markStaleQueuedRunRecoveryAttempt(row, start.status === "deferred"
      ? { status: "deferred", message: start.reason }
      : { status: "started", message: "Started queued run workflow after cold-start grace window." });
  } catch (error) {
    await markStaleQueuedRunRecoveryAttempt(row, {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sweepOnce(): Promise<void> {
  const rows = await sql<StaleQueuedRunRow[]>`
    select id, user_id, pipeline, stage, total_documents, created_at, updated_at, stats
    from workspace_runs
    where status = 'queued'
      and coalesce(control_state, '') not in ('paused', 'cancelled', 'dead-letter')
      and created_at < now() - (${STALE_QUEUED_RUN_COLD_START_GRACE_MS} * interval '1 millisecond')
    order by created_at asc
    limit ${STALE_QUEUED_RUN_SWEEP_LIMIT}
  `;

  for (const row of rows) {
    try {
      await recoverStaleQueuedRun(row);
    } catch (error) {
      console.error(
        `[stale-queued-run-sweep] runId=${row.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

let inFlight: Promise<void> | null = null;

export function sweepStaleQueuedRuns(): Promise<void> {
  if (!inFlight) {
    inFlight = sweepOnce().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
