// Parser VM only: inline chart extraction inside the quarantine inspection process (DOCSLURP_CHART_EXPORT_INLINE=1).
// The extractor runs in a worker thread with its own heap limit and a wall-clock deadline, so a hostile file that is slow
// or memory-hungry ends the worker, never the inspection: quarantine always gets its result.
import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { INLINE_CHART_LIMITS, inlineChartPlan, inlineDeadlineMs } from "../dist/chart-export/inline-guest.js";

const WORKER = new URL("./chart-inline-worker.mjs", import.meta.url);

/**
 * `request`: { kind, diagrams } from the host. `inspection`: this process's own inspection of the same bytes.
 * Returns { status: "ok", ms, result } | { status: "skipped", reason } | { status: "refused", reason, ms }.
 */
export async function inlineCharts(bytes, request, inspection) {
  const kind = typeof request?.kind === "string" ? request.kind : "";
  let text;
  const plan = inlineChartPlan(kind, inspection, bytes.length, () => (text ??= bytes.toString("utf8")));
  if (!plan.run) return { status: "skipped", reason: plan.reason };
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const deadline = inlineDeadlineMs(bytes.length);
  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      resolve(value);
    };
    const worker = new Worker(WORKER, {
      workerData: { kind, packaged: plan.packaged, diagrams: request.diagrams !== false, bytes: new Uint8Array(bytes) },
      resourceLimits: {
        maxOldGenerationSizeMb: INLINE_CHART_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: INLINE_CHART_LIMITS.maxYoungGenerationSizeMb,
        stackSizeMb: INLINE_CHART_LIMITS.stackSizeMb,
      },
      stdout: true, stderr: true,
    });
    const timer = setTimeout(() => finish({ status: "refused", reason: "deadline", ms: ms() }), deadline);
    worker.once("message", (json) => {
      if (typeof json !== "string" || Buffer.byteLength(json) > INLINE_CHART_LIMITS.maxResultBytes) return finish({ status: "refused", reason: "result-too-large", ms: ms() });
      try { finish({ status: "ok", ms: ms(), result: JSON.parse(json) }); } catch { finish({ status: "refused", reason: "result-invalid", ms: ms() }); }
    });
    // Machine reasons only: no error text (it could echo file content) leaves the guest.
    worker.once("error", () => finish({ status: "refused", reason: "worker-failed", ms: ms() }));
    worker.once("exit", () => finish({ status: "refused", reason: "worker-failed", ms: ms() }));
  });
}
