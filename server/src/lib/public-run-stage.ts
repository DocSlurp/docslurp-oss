import { publicRunStage, type RunStage } from "@docslurp/shared";

const reported = new Set<string>();
const MAX_REPORTED = 256;

/**
 * The public stage for a stage name the worker recorded, or null when the
 * contract has no stage for it. A worker stage the shared enum does not know
 * (a newer internal checkpoint, a worker ahead of this API) must never fail
 * response validation: the caller substitutes a safe value, and the raw name
 * goes to telemetry (once per process per source and name) instead of to users.
 */
export function toPublicRunStage(raw: unknown, context: { source: string; runId?: string }): RunStage | null {
  const stage = publicRunStage(raw);
  if (stage === null && raw !== null && raw !== undefined) {
    const name = String(raw).slice(0, 120);
    const key = `${context.source}\u0000${name}`;
    if (!reported.has(key) && reported.size < MAX_REPORTED) {
      reported.add(key);
      console.warn(
        `[run-stage] unknown_internal_stage source=${context.source} stage=${JSON.stringify(name)}` +
          (context.runId ? ` run=${context.runId}` : ""),
      );
    }
  }
  return stage;
}

/** A run's own stage is required: an unknown one reads as completed for finished runs, queued otherwise. */
export function toPublicRunRowStage(raw: unknown, status: unknown, runId?: string): RunStage {
  return toPublicRunStage(raw, { source: "run", runId }) ?? (status === "completed" ? "completed" : "queued");
}

/** Test hook: forget which unknown stages were already reported. */
export function resetReportedRunStagesForTest(): void {
  reported.clear();
}
