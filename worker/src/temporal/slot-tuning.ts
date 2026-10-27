/**
 * How many activities a worker machine runs at once.
 *
 * "resource" (default): a Temporal resource-based slot supplier. The worker
 * always runs `minimum` activities; above that it takes one more only while
 * machine CPU and memory are under target, and waits `rampThrottle` between
 * additions so a burst of new tasks cannot pile onto a machine before the
 * last one's load shows up. Keep the throttle short (see rampThrottleMs): a
 * long one starves short activities even below the minimum. A light stage (DB-bound bookkeeping) packs many
 * activities per machine; CPU-heavy work (embedding, OCR) stops near the CPU
 * target and leaves the rest of the queue to other machines, which the
 * autoscaler adds while demand stays.
 *
 * "fixed": exactly WORKER_ACTIVITY_CONCURRENCY slots (the previous behavior).
 *
 * Workflow tasks are tiny and always use fixed slots.
 */

import type { WorkerTuner } from "@temporalio/worker";

export interface ActivitySlotTuning {
  mode: "resource" | "fixed";
  /** Fixed mode: the slot count. Resource mode: the nominal slots the autoscaler sizes the fleet with. */
  nominalSlots: number;
  minimumSlots: number;
  maximumSlots: number;
  rampThrottleMs: number;
  targetCpuUsage: number;
  targetMemoryUsage: number;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function ratio(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export function resolveActivitySlotTuning(env: NodeJS.ProcessEnv, nominalSlots: number): ActivitySlotTuning {
  const nominal = Math.max(1, Math.floor(nominalSlots));
  // Always grant half the nominal slots: past the minimum the ramp throttle admits at most
  // one activity per ramp interval, so short activities would never build up concurrency.
  const minimumSlots = int(env.WORKER_MIN_ACTIVITY_SLOTS, Math.max(1, Math.floor(nominal / 2)), 1, 256);
  return {
    mode: env.WORKER_SLOT_TUNER?.trim().toLowerCase() === "fixed" ? "fixed" : "resource",
    nominalSlots: nominal,
    minimumSlots,
    maximumSlots: Math.max(minimumSlots, int(env.WORKER_MAX_ACTIVITY_SLOTS, nominal * 2, 1, 256)),
    // The ramp throttle gates every slot above the minimum AND each poller's wait: a slot is issued only when
    // `rampThrottle` has passed since the previous issue, and every issue (including re-issues of the minimum
    // slots as short activities finish) restarts that clock. At 5 s, activities shorter than the throttle
    // never reached their maximum: a local Temporal dev server with 200 ms activities and 2 slots ran 316
    // activities/min fixed, 16 with min 1 / max 2 / ramp 5 s, 53 with min 2 / max 2 / ramp 5 s, and 270-315
    // with ramp 0-50 ms (the 2026-10-23 fleet load test saw 539 vs 21 pages/min the same way). 50 ms is the
    // Temporal SDK's own activity default. Raise it only to spread out slow, memory-heavy starts, and expect
    // short activities to slow down in proportion.
    rampThrottleMs: int(env.WORKER_SLOT_RAMP_MS, 50, 0, 300_000),
    targetCpuUsage: ratio(env.WORKER_TARGET_CPU, 0.85),
    targetMemoryUsage: ratio(env.WORKER_TARGET_MEMORY, 0.8),
  };
}

/** The most activities this worker may run at once (fixed slots, or the resource maximum). */
export function maxActivitySlots(tuning: ActivitySlotTuning): number {
  return tuning.mode === "fixed" ? tuning.nominalSlots : tuning.maximumSlots;
}

/**
 * Worker options for the activity side. `workflowSlots` is set when the same
 * Worker also runs workflow tasks (no separate activity queue).
 */
export function activitySlotOptions(
  tuning: ActivitySlotTuning,
  workflowSlots?: number,
): { maxConcurrentActivityTaskExecutions: number } | { tuner: WorkerTuner } {
  if (tuning.mode === "fixed") return { maxConcurrentActivityTaskExecutions: tuning.nominalSlots };
  const fixed = (numSlots: number) => ({ type: "fixed-size" as const, numSlots });
  return {
    tuner: {
      workflowTaskSlotSupplier: fixed(Math.max(2, workflowSlots ?? 2)),
      activityTaskSlotSupplier: {
        type: "resource-based",
        minimumSlots: tuning.minimumSlots,
        maximumSlots: tuning.maximumSlots,
        rampThrottle: tuning.rampThrottleMs,
        tunerOptions: { targetCpuUsage: tuning.targetCpuUsage, targetMemoryUsage: tuning.targetMemoryUsage },
      },
      localActivityTaskSlotSupplier: fixed(tuning.maximumSlots),
      nexusTaskSlotSupplier: fixed(1),
    },
  };
}
