// Parser VM only: inline chart extraction inside the quarantine inspection process (DOCSLURP_CHART_EXPORT_INLINE=1).
// The extractor runs in a worker thread under three bounds, so a hostile file that is slow or memory-hungry ends the
// worker, never the inspection:
// - a V8 heap limit (resourceLimits);
// - a process RSS growth limit, polled while the worker runs: the heap limit does not cover Buffers/ArrayBuffers;
// - a wall-clock deadline that starts when the file is handed over (start-up is our code and has its own allowance).
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { INLINE_CHART_LIMITS, inlineChartPlan, inlineDeadlineMs } from "../dist/chart-export/inline-guest.js";

const WORKER = new URL("./chart-inline-worker.mjs", import.meta.url);
/** The image's compile cache for the bundle (built at image build time by bundle-chart-guest.mjs --compile-cache). */
const COMPILE_CACHE = fileURLToPath(new URL("../dist/chart-export/compile-cache/", import.meta.url));

/** Start the worker (thread start, cache, bundle import); it gets bytes only once it says "ready". */
function startChartWorker(workerUrl) {
  const started = performance.now();
  const worker = new Worker(workerUrl, {
    workerData: existsSync(COMPILE_CACHE) ? { compileCache: COMPILE_CACHE } : {},
    resourceLimits: {
      maxOldGenerationSizeMb: INLINE_CHART_LIMITS.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: INLINE_CHART_LIMITS.maxYoungGenerationSizeMb,
      stackSizeMb: INLINE_CHART_LIMITS.stackSizeMb,
    },
  });
  // Unread messages and errors before the job is handed over are kept until inlineCharts() listens.
  const early = [];
  const onEarly = (kind) => (value) => early.push([kind, value]);
  const listeners = { message: onEarly("message"), error: onEarly("error"), exit: onEarly("exit") };
  for (const [event, fn] of Object.entries(listeners)) worker.on(event, fn);
  return {
    worker, started, early,
    detach() { for (const [event, fn] of Object.entries(listeners)) worker.off(event, fn); },
    cancel() { void worker.terminate().catch(() => undefined); },
  };
}

/**
 * `request`: { kind, diagrams, pages? } from the host. `inspection`: this process's own inspection of the same bytes.
 * The worker starts only after the plan passed. `workerUrl` exists for the tests' hostile workers.
 * Returns { status: "ok", ms, result } | { status: "skipped", reason } | { status: "refused", reason, ms }.
 * Transfers `bytes`' memory to the worker: the caller must not use `bytes` afterwards.
 */
export async function inlineCharts(bytes, request, inspection, workerUrl = WORKER) {
  const kind = typeof request?.kind === "string" ? request.kind : "";
  let text;
  const plan = inlineChartPlan(kind, inspection, bytes.length, () => (text ??= bytes.toString("utf8")));
  if (!plan.run) return { status: "skipped", reason: plan.reason };
  const handle = startChartWorker(workerUrl);
  const { worker } = handle;
  const ms = () => Math.round(performance.now() - handle.started);
  const deadline = inlineDeadlineMs(bytes.length);
  // One copy at most: the worker gets the file's memory itself (transferred), the parent keeps none of it.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const job = { kind, packaged: plan.packaged, diagrams: request.diagrams !== false, buffer: own };
  const rssLimit = process.memoryUsage.rss() + INLINE_CHART_LIMITS.maxRssGrowthMb * 1024 * 1024;
  return await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      void worker.terminate().catch(() => undefined);
      resolve(value);
    };
    // The real memory bound (heap limits do not cover external memory): over budget, the worker is stopped.
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() > rssLimit) finish({ status: "refused", reason: "memory-limit", ms: ms() });
    }, INLINE_CHART_LIMITS.rssPollMs);
    timer = setTimeout(() => finish({ status: "refused", reason: "deadline", ms: ms() }), INLINE_CHART_LIMITS.startupMs);
    let ready = false;
    const onMessage = (json) => {
      if (!ready && json === "ready") {
        ready = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish({ status: "refused", reason: "deadline", ms: ms() }), deadline);
        worker.postMessage(job, [own]);
        return;
      }
      if (!ready) return finish({ status: "refused", reason: "result-invalid", ms: ms() });
      if (typeof json !== "string" || Buffer.byteLength(json) > INLINE_CHART_LIMITS.maxResultBytes) return finish({ status: "refused", reason: "result-too-large", ms: ms() });
      try { finish({ status: "ok", ms: ms(), result: JSON.parse(json) }); } catch { finish({ status: "refused", reason: "result-invalid", ms: ms() }); }
    };
    // Machine reasons only: no error text (it could echo file content) leaves the guest. A heap overflow ends the
    // worker with ERR_WORKER_OUT_OF_MEMORY, which lands here, not in the process.
    const onError = () => finish({ status: "refused", reason: "worker-failed", ms: ms() });
    const onExit = () => finish({ status: "refused", reason: "worker-failed", ms: ms() });
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    // Replay anything the worker said before these listeners were attached (none in practice: same tick).
    if (handle.early) {
      handle.detach();
      for (const [event, value] of handle.early.splice(0)) (event === "message" ? onMessage : event === "error" ? onError : onExit)(value);
    }
  });
}
