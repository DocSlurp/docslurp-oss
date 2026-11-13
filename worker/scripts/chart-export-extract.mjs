// Parser-VM guest: deterministic chart/diagram extraction (office-chart-xml, embedded-spec, svg-geometry).
// argv: <input file> <request.json> <output.json> [more input files...]. Reads customer bytes; runs only inside the
// parser VM in production. With `batch: N` in the request (SVG only), the first input plus the N-1 trailing inputs are
// extracted one by one, each under its own size limit, and the output is one result per input, in order.
import { readFile, stat, writeFile } from "node:fs/promises";
import module from "node:module";
import path from "node:path";
import { Worker } from "node:worker_threads";
const started = Date.now();
const [input, requestPath, output, ...more] = process.argv.slice(2);
if ((await stat(requestPath)).size > 4096) throw new Error("chart extract request exceeds limit");
const request = JSON.parse(await readFile(requestPath, "utf8"));
// Optional V8 compile cache (`compileCacheDir`, an absolute directory): off unless the caller passes one. It saves
// compiling the bundle again in this process and in each worker; it caches compilation of the fixed bundle and script
// files only, and leaves --disallow-code-generation-from-strings and zod jitless as they are. The directory should be
// prepared ahead of time and read-only to the guest, so one document's run cannot leave compiled code for the next.
const compileCacheDir = request.compileCacheDir ?? null;
if (compileCacheDir !== null && (typeof compileCacheDir !== "string" || compileCacheDir.length > 512 || compileCacheDir.includes("\0") || !path.isAbsolute(compileCacheDir) || path.normalize(compileCacheDir) !== compileCacheDir)) {
  throw new Error("invalid chart extract compile cache");
}
if (compileCacheDir) module.enableCompileCache(compileCacheDir);
// One bundled module (built from dist/chart-export/extractors/guest-entry.js): loads in a fraction of the CPU the
// separate ESM files take, which matters because every VM command starts a fresh process. A fixed path, loaded after
// the cache is enabled. `testHooks` is null in the production bundle (a build-time constant), so the test-only knobs
// below are inert there.
const { CHART_EXTRACT_LIMITS, testHooks, reassembleUnits, resultVisualBytes, resumeSkipList } = await import("../dist/chart-export/guest.bundle.mjs");
const kind = request?.kind;
if (!["office", "epub", "svg", "html", "json"].includes(kind)) throw new Error("invalid chart extract kind");
const packaged = kind === "office" || kind === "epub";
const options = { diagrams: request.diagrams !== false };
// Deadline below the host's timeout (the host sends its timeout minus a margin): past it, SVGs not yet analysed are
// returned as a counted `guest-deadline` deferral, so a slow input keeps what it produced instead of being killed.
const budgetMs = Number.isSafeInteger(request.budgetMs) && request.budgetMs >= 1_000 && request.budgetMs <= 175_000 ? request.budgetMs : 45_000;
const deadline = started + budgetMs;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

/*
 * Crash and timeout containment (council r8). Each input's extraction runs in a worker_thread with its own heap limit.
 * The worker streams every finished unit (an SVG, an embedded-spec scan, an Office chart part) here as it completes.
 * If a unit crashes the worker (exception, out of memory) or overruns its time, the worker is terminated, that one unit
 * is recorded as `unit-crashed` / `unit-timeout` (a counted, closed reason), and a fresh worker continues after it,
 * skipping every unit already finished or failed. Past the deadline, a last worker only counts what is left. Output is
 * bounded too (council r9): each chart by `maxChartBytes`, each input and each batch by `maxOutputBytes`, past which
 * visuals are counted as `output-limit`. So no input can take the guest down: the document keeps every other visual,
 * and every loss is counted.
 */
const WORKER = new URL("./chart-export-worker.mjs", import.meta.url);
// Heap per worker: well inside the 4 GiB parser VM next to this small parent (measured legitimate peaks are < 600 MB).
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: testHooks?.heapMb ?? 1536, maxYoungGenerationSizeMb: 64 };
// Wall clock one unit may take (legitimate units take milliseconds; the gates bound hostile ones to seconds).
const UNIT_TIMEOUT_MS = testHooks?.unitMs ?? 15_000;
// A worker started past the deadline only counts the rest; it gets this long.
const COUNT_ONLY_MS = 5_000;
// Failures do not stop the input: workers continue until the deadline (council r9 L1). This only guards a runaway loop.
const MAX_WORKERS_PER_INPUT = 1_000;

/** Run one worker until it returns a result, crashes or overruns; record finished units into `done`. */
function runWorker(task, done, workerIndex, onStart) {
  return new Promise((resolve) => {
    // No environment at all: nothing on the worker host can reach the extractor through it.
    const worker = new Worker(WORKER, { resourceLimits: RESOURCE_LIMITS, env: {}, workerData: { compileCacheDir } });
    let inflight = null;
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(unitTimer);
      clearTimeout(hardTimer);
      worker.terminate().catch(() => {});
      resolve(outcome);
    };
    const remaining = () => Math.max(1_000, task.deadline === 0 ? COUNT_ONLY_MS : deadline + 2_000 - Date.now());
    let unitTimer = null;
    const hardTimer = setTimeout(() => finish({ failure: "timeout", inflight }), task.deadline === 0 ? COUNT_ONLY_MS : remaining());
    worker.on("message", (m) => {
      // A message after the worker was settled (a unit finishing in the tick its timer fired) is ignored (council r9 I1).
      if (settled) return;
      if (m.t === "start") {
        inflight = { id: m.id, locator: m.locator, svgIndex: m.svgIndex, svg: m.svg };
        onStart(inflight);
        clearTimeout(unitTimer);
        unitTimer = setTimeout(() => finish({ failure: "timeout", inflight }), Math.min(UNIT_TIMEOUT_MS, remaining()));
      } else if (m.t === "done") {
        clearTimeout(unitTimer);
        done.set(m.id, { delta: m.delta, worker: workerIndex });
        inflight = null;
      } else if (m.t === "result") finish({ result: m.result });
    });
    worker.on("error", () => finish({ failure: "crashed", inflight }));
    worker.on("exit", (code) => finish({ failure: code === 0 ? "exited" : "crashed", inflight }));
    worker.postMessage({ ...task, fault: testHooks?.fault ?? null });
  });
}

/**
 * One input, contained, its visuals inside `outputBudget` bytes: the worker's own result when nothing failed (identical
 * to an uncontained run), otherwise the units each worker finished, the failed units counted, and the last worker's own
 * accounting, re-checked against the same budget while merging.
 */
async function extractContained(path, kind, packaged, outputBudget) {
  const done = new Map();
  const failed = new Map();
  let final = null;
  let lastWorker = 0;
  let unplaced = false;
  let nextSvg = 0;
  for (let w = 0; ; w++) {
    const countOnly = Date.now() >= deadline || w >= MAX_WORKERS_PER_INPUT - 1;
    const skip = resumeSkipList(done, failed.keys());
    const task = { path, kind, packaged, options, skip, outputBudget, deadline: countOnly ? 0 : deadline };
    const outcome = await runWorker(task, done, w, (unit) => { nextSvg = unit.svgIndex + (unit.svg ? 1 : 0); });
    lastWorker = w;
    if (outcome.result) { final = outcome.result; break; }
    if (outcome.inflight && !failed.has(outcome.inflight.id) && !countOnly) {
      failed.set(outcome.inflight.id, { ...outcome.inflight, reason: outcome.failure === "timeout" ? "unit-timeout" : "unit-crashed" });
      continue;
    }
    // A failure outside any unit, or in the counting worker: nothing more can be isolated. Counted from here on as one
    // deferred unit (a lower bound: the units after it are not enumerated), and refused (council r9 L2).
    unplaced = true;
    break;
  }
  // Shared with the inline supervisor (reassemble.ts in the bundle): identical merge, resume charge and budget re-check.
  return reassembleUnits({ done, failed: failed.values(), final, lastWorker, unplaced: unplaced ? { svgIndex: nextSvg, locator: kind } : null, outputBudget });
}

let json;
if (request.batch !== undefined) {
  const batch = request.batch;
  if (kind !== "svg" || !Number.isSafeInteger(batch) || batch < 1 || batch > 40 || more.length !== batch - 1) throw new Error("invalid chart extract batch");
  const refused = (reason) => ({ schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "svg", reason }] });
  const results = [];
  // Each figure runs contained: one bad figure never sinks the others; the host sees a machine reason only. The figures
  // share one output budget, so the batch result stays inside one result's cap.
  let left = CHART_EXTRACT_LIMITS.maxOutputBytes;
  for (const file of [input, ...more]) {
    if ((await stat(file)).size > CHART_EXTRACT_LIMITS.maxTextBytes) { results.push(refused("input-too-large")); continue; }
    try {
      const result = await extractContained(file, kind, false, left);
      left = Math.max(0, left - resultVisualBytes(result));
      results.push(result);
    } catch {
      results.push(refused("extract-failed"));
    }
  }
  json = JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results });
} else {
  if (more.length > 0) throw new Error("unexpected chart extract inputs");
  if ((await stat(input)).size > (packaged ? CHART_EXTRACT_LIMITS.maxPackageBytes : CHART_EXTRACT_LIMITS.maxTextBytes)) throw new Error("chart extract input exceeds limit");
  json = JSON.stringify(await extractContained(input, kind, packaged, CHART_EXTRACT_LIMITS.maxOutputBytes));
}
// An assertion: the output budgets (visuals ≤ maxOutputBytes, ≤ 1,000 refusals and deferral entries) keep every result
// well under this, so a result over it means a bug, not an input.
if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error("chart extract result exceeds limit");
await writeFile(output, json, { mode: 0o600 });
