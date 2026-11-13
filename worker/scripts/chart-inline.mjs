// Parser VM only: inline chart extraction inside the quarantine inspection process (DOCSLURP_CHART_EXPORT_INLINE).
// Unit containment, as #364's guest (chart-export-extract.mjs): the extraction runs in #364's own unit worker
// (chart-export-worker.mjs), which streams every finished unit (an SVG, an embedded-spec scan, an Office chart part). If a
// unit crashes the worker, exhausts its heap or memory budget, or overruns, the worker is ended, that one unit is recorded
// as `unit-crashed` / `unit-timeout`, and a fresh worker resumes after it, skipping every unit already finished or failed.
// Bounds, all of them inline's own (smaller than the standalone guest's), so nothing reaches the inspection:
// - a V8 heap limit per worker (resourceLimits);
// - a process RSS growth limit, polled while a worker runs (the heap limit does not cover Buffers/ArrayBuffers);
// - a wall-clock budget: the extractor's own deadline (setGuestDeadline, softDeadlineShare of it), each unit at most
//   what is left, the whole step at most startupMs + the size-scaled deadline; past it one short count-only worker
//   records what is left as guest-deadline ranges.
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { INLINE_CHART_LIMITS, inlineChartPlan, inlineDeadlineMs } from "../dist/chart-export/inline-guest.js";
import { CHART_EXTRACT_LIMITS } from "../dist/chart-export/extractors/limits.js";

const WORKER = new URL("./chart-export-worker.mjs", import.meta.url);
/** A count-only worker (past the deadline) gets this long: it parses nothing, it records what is left. */
const COUNT_ONLY_MS = 1_000;
const MAX_WORKERS = 8;

/**
 * Run one unit worker until it returns a result, crashes, overruns or passes the memory budget; finished units go into
 * `done`. Resolves { result } | { failure: "timeout" | "crashed" | "exited", inflight }.
 */
function runWorker(workerUrl, task, done, index, endsAt, rssLimit) {
  return new Promise((resolve) => {
    const worker = new Worker(workerUrl, {
      resourceLimits: {
        maxOldGenerationSizeMb: INLINE_CHART_LIMITS.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: INLINE_CHART_LIMITS.maxYoungGenerationSizeMb,
        stackSizeMb: INLINE_CHART_LIMITS.stackSizeMb,
      },
    });
    let inflight = null;
    let settled = false;
    let unitTimer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(unitTimer);
      clearTimeout(hardTimer);
      clearInterval(watch);
      void worker.terminate().catch(() => undefined);
      resolve(outcome);
    };
    const left = () => Math.max(1, endsAt - performance.now());
    const hardTimer = setTimeout(() => finish({ failure: "timeout", inflight }), left());
    // The real memory bound (heap limits do not cover external memory): over it, the unit in flight is lost (crashed).
    const watch = setInterval(() => {
      if (process.memoryUsage.rss() > rssLimit) finish({ failure: "crashed", inflight });
    }, INLINE_CHART_LIMITS.rssPollMs);
    worker.on("message", (m) => {
      if (m?.t === "start") {
        inflight = { id: m.id, locator: m.locator, svgIndex: m.svgIndex };
        clearTimeout(unitTimer);
        unitTimer = setTimeout(() => finish({ failure: "timeout", inflight }), left());
      } else if (m?.t === "done") {
        clearTimeout(unitTimer);
        done.set(m.id, { delta: m.delta, worker: index });
        inflight = null;
      } else if (m?.t === "result") finish({ result: m.result });
    });
    // Machine reasons only: no error text (it could echo file content) leaves the guest.
    worker.on("error", () => finish({ failure: "crashed", inflight }));
    worker.on("exit", (code) => finish({ failure: code === 0 ? "exited" : "crashed", inflight }));
    worker.postMessage(task);
  });
}

/** Reassemble a contained run, exactly as #364's extractContained (chart-export-extract.mjs) does. */
function reassemble(kind, done, failed, final, lastWorker, unplaced) {
  const earlier = [...done].filter(([, d]) => !final || d.worker !== lastWorker).sort((a, b) => a[0] - b[0]).map(([, d]) => d.delta);
  const lost = [...failed.values()].sort((a, b) => a.id - b.id).map((f) => ({ svgIndex: f.svgIndex, count: 1, reason: f.reason }));
  const base = final ?? { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], overflow: 0 };
  const visuals = [...earlier.flatMap((d) => d.visuals), ...base.visuals].slice(0, CHART_EXTRACT_LIMITS.maxVisuals);
  const refusals = [...earlier.flatMap((d) => d.refusals), ...base.refusals, ...(unplaced ? [{ locator: kind, reason: "unit-crashed" }] : [])];
  const deferred = [...earlier.flatMap((d) => d.deferred), ...lost, ...(base.deferred ?? [])].slice(0, 1000);
  const overflow = earlier.reduce((n, d) => n + d.overflow, 0) + (base.overflow ?? 0) + Math.max(0, refusals.length - 1000);
  return {
    schemaVersion: "chart-export-deterministic@v1",
    visuals,
    refusals: refusals.slice(0, 1000),
    ...(overflow > 0 ? { overflow } : {}),
    ...(deferred.length ? { deferred } : {}),
  };
}

/**
 * `bytes`: the file (for the plan); `inputPath`: the same file on disk (the unit workers read it). `request`: { kind,
 * diagrams } from the host. `inspection`: this process's own inspection of the same bytes. Workers start only after the
 * plan passed. `workerUrl` exists for the tests' hostile workers. Returns { status: "ok", ms, result } |
 * { status: "skipped", reason } | { status: "refused", reason, ms } (no unit could be placed: start-up, or every worker
 * failing outside any unit).
 */
export async function inlineCharts(bytes, request, inspection, inputPath, workerUrl = WORKER) {
  const kind = typeof request?.kind === "string" ? request.kind : "";
  let text;
  const plan = inlineChartPlan(kind, inspection, bytes.length, () => (text ??= bytes.toString("utf8")));
  if (!plan.run) return { status: "skipped", reason: plan.reason };
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const deadline = inlineDeadlineMs(bytes.length);
  const endsAt = started + INLINE_CHART_LIMITS.startupMs + deadline;
  // The extractor's own deadline (epoch ms), inside the hard one: past it, unanalysed units become counted deferrals.
  const softDeadline = Date.now() + INLINE_CHART_LIMITS.startupMs + Math.floor(deadline * INLINE_CHART_LIMITS.softDeadlineShare);
  const options = { diagrams: request.diagrams !== false };
  // One memory budget for the whole step, from the RSS before the first worker: a later worker never inherits the
  // headroom of memory an ended worker has not yet returned.
  const rssLimit = process.memoryUsage.rss() + INLINE_CHART_LIMITS.maxRssGrowthMb * 1024 * 1024;
  const done = new Map();
  const failed = new Map();
  let final = null;
  let lastWorker = 0;
  let unplaced = false;
  let failure = null;
  for (let w = 0; ; w++) {
    const countOnly = performance.now() >= endsAt || w >= MAX_WORKERS - 1;
    const skip = [...[...done].map(([id, d]) => [id, d.delta.visuals.length]), ...[...failed.keys()].map((id) => [id, 0])];
    const task = { path: inputPath, kind, packaged: plan.packaged, options, skip, deadline: countOnly ? 0 : softDeadline };
    const outcome = await runWorker(workerUrl, task, done, w, countOnly ? performance.now() + COUNT_ONLY_MS : endsAt, rssLimit);
    lastWorker = w;
    if (outcome.result) { final = outcome.result; break; }
    if (outcome.inflight && !failed.has(outcome.inflight.id) && !countOnly) {
      failed.set(outcome.inflight.id, { ...outcome.inflight, reason: outcome.failure === "timeout" ? "unit-timeout" : "unit-crashed" });
      continue;
    }
    unplaced = true;
    failure = outcome.failure;
    break;
  }
  // Nothing placed at all (the first worker never reached a unit): a refusal, as before containment.
  if (!final && done.size === 0 && failed.size === 0) return { status: "refused", reason: failure === "timeout" ? "deadline" : "worker-failed", ms: ms() };
  const result = final && failed.size === 0 ? final : reassemble(kind, done, failed, final, lastWorker, unplaced);
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > INLINE_CHART_LIMITS.maxResultBytes) return { status: "refused", reason: "result-too-large", ms: ms() };
  return { status: "ok", ms: ms(), result: JSON.parse(json) };
}
