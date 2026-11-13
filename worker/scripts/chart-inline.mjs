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
import { accessSync, constants, readdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { INLINE_CHART_LIMITS, inlineChartPlan, inlineDeadlineMs } from "../dist/chart-export/inline-guest.js";
import { CHART_EXTRACT_LIMITS } from "../dist/chart-export/extractors/limits.js";

const WORKER = new URL("./chart-export-worker.mjs", import.meta.url);
/** The V8 compile cache pre-filled at image build (chart-guest-bundle.mjs buildCompileCache; verified at VM start). */
const COMPILE_CACHE = fileURLToPath(new URL("../dist/chart-export/compile-cache/", import.meta.url));

/**
 * The compile cache directory to hand #364's workers (`compileCacheDir`), or null. Security condition (#364 council r10):
 * a run must never write a cache that another document's run will load. So it is used only when this process can write
 * neither the directory nor anything in it (the image's root-owned files; parser commands run unprivileged). Anything
 * else (missing, writable, unreadable) runs without a cache: the same result, ~20-40 ms slower.
 */
export function readOnlyCompileCache(dir = COMPILE_CACHE) {
  const writable = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
    if (writable(dir)) return null;
    const stack = [dir];
    let seen = 0;
    while (stack.length) {
      const d = stack.pop();
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (++seen > 64) return null; // a pre-filled cache is a key file and one V8 directory with a few entries
        const p = path.join(d, e.name);
        if (e.isSymbolicLink() || writable(p)) return null;
        if (e.isDirectory()) stack.push(p);
      }
    }
    return dir;
  } catch {
    return null;
  }
}
/** The inline answer's output budget (INLINE_CHART_LIMITS.outputBudget); the byte total carries across worker restarts. */
const INLINE_OUTPUT_BUDGET = INLINE_CHART_LIMITS.outputBudget;
const visualBytes = (v) => Buffer.byteLength(JSON.stringify(v));
/** Reasons merged into one entry per input when reassembling, as #364's chart-export-extract.mjs. */
const MERGED_REASONS = new Set(["visual-limit", "output-limit", "package-part-limit", "guest-deadline-part"]);
function mergeDeferred(list) {
  const out = [];
  for (const d of list) {
    const same = MERGED_REASONS.has(d.reason) ? out.find((e) => e.reason === d.reason) : null;
    if (same) { same.svgIndex = Math.min(same.svgIndex, d.svgIndex); same.count += d.count; } else out.push({ ...d });
  }
  return out.slice(0, 1000);
}
/** A count-only worker (past the deadline) gets this long: it parses nothing, it records what is left. */
const COUNT_ONLY_MS = 1_000;
const MAX_WORKERS = 8;

/**
 * Run one unit worker until it returns a result, crashes, overruns or passes the memory budget; finished units go into
 * `done`. Resolves { result } | { failure: "timeout" | "crashed" | "exited", inflight }.
 */
function runWorker(workerUrl, task, done, index, endsAt, rssLimit, onStart, compileCacheDir) {
  return new Promise((resolve) => {
    // An empty environment, as #364's guest gives its workers.
    const worker = new Worker(workerUrl, {
      env: {},
      // #364's worker enables a compile cache only when given one (read-only here: readOnlyCompileCache).
      ...(compileCacheDir ? { workerData: { compileCacheDir } } : {}),
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
        inflight = { id: m.id, locator: m.locator, svgIndex: m.svgIndex, svg: m.svg };
        onStart(inflight);
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

/**
 * Reassemble a contained run as #364's extractContained (chart-export-extract.mjs) does: earlier workers' units, the
 * failed units counted, an unplaced failure counted from the next SVG, the last worker's accounting, and the same output
 * budget enforced while merging (past it a visual is output-limit, never thrown).
 */
function reassemble(kind, done, failed, final, lastWorker, unplaced, nextSvg, outputBudget) {
  const earlier = [...done].filter(([, d]) => !final || d.worker !== lastWorker).sort((a, b) => a[0] - b[0]).map(([, d]) => d.delta);
  const lost = [...failed.values()].sort((a, b) => a.id - b.id).map((f) => ({ svgIndex: f.svgIndex, count: 1, reason: f.reason }));
  const base = final ?? { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], overflow: 0 };
  const visuals = [];
  const deferredExtra = [];
  let bytes = 0;
  for (const v of [...earlier.flatMap((d) => d.visuals), ...base.visuals]) {
    const size = visualBytes(v);
    if (visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals || bytes + size > outputBudget) { deferredExtra.push({ svgIndex: 0, count: 1, reason: visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals ? "visual-limit" : "output-limit" }); continue; }
    bytes += size;
    visuals.push(v);
  }
  const refusals = [...earlier.flatMap((d) => d.refusals), ...base.refusals, ...(unplaced ? [{ locator: kind, reason: "unit-crashed" }] : [])];
  const deferred = mergeDeferred([...earlier.flatMap((d) => d.deferred), ...lost, ...(unplaced ? [{ svgIndex: nextSvg, count: 1, reason: "unit-crashed" }] : []), ...(base.deferred ?? []), ...deferredExtra]);
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
export async function inlineCharts(bytes, request, inspection, inputPath, workerUrl = WORKER, compileCacheDir = readOnlyCompileCache()) {
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
  let nextSvg = 0;
  // Fault injection (tests only): forwarded as #364's guest does; the worker ignores it unless its bundle was built with
  // the test hooks (the production bundle compiles them out).
  const fault = process.env.DOCSLURP_CHART_GUEST_TEST_FAULT ?? null;
  for (let w = 0; ; w++) {
    const countOnly = performance.now() >= endsAt || w >= MAX_WORKERS - 1;
    // UnitControl.skip: unit id to { visuals, bytes }, so a resumed worker carries the output byte total (#364).
    const skip = [...[...done].map(([id, d]) => [id, { visuals: d.delta.visuals.length, bytes: d.delta.bytes }]), ...[...failed.keys()].map((id) => [id, { visuals: 0, bytes: 0 }])];
    const task = { path: inputPath, kind, packaged: plan.packaged, options, skip, outputBudget: INLINE_OUTPUT_BUDGET, deadline: countOnly ? 0 : softDeadline, fault };
    const outcome = await runWorker(workerUrl, task, done, w, countOnly ? performance.now() + COUNT_ONLY_MS : endsAt, rssLimit,
      (unit) => { nextSvg = unit.svgIndex + (unit.svg ? 1 : 0); }, compileCacheDir);
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
  const result = final && failed.size === 0 ? final : reassemble(kind, done, failed, final, lastWorker, unplaced, nextSvg, INLINE_OUTPUT_BUDGET);
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > INLINE_CHART_LIMITS.maxResultBytes) return { status: "refused", reason: "result-too-large", ms: ms() };
  return { status: "ok", ms: ms(), result: JSON.parse(json) };
}
