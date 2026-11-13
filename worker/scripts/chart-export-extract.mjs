// Parser-VM guest: deterministic chart/diagram extraction (office-chart-xml, embedded-spec, svg-geometry).
// argv: <input file> <request.json> <output.json> [more input files...]. Reads customer bytes; runs only inside the
// parser VM in production. With `batch: N` in the request (SVG only), the first input plus the N-1 trailing inputs are
// extracted one by one, each under its own size limit, and the output is one result per input, in order.
import { accessSync, constants as fsc, lstatSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
// files only, and leaves --disallow-code-generation-from-strings and zod jitless as they are.
// A cache the guest could write would let one document's run leave compiled code for the next (Node's check is an
// unkeyed checksum), so it is used only when the guest cannot write it (council r10 L3): prepared ahead of time and
// mounted read-only. A writable, missing or unusual directory runs without the cache (identical output) and says why.
// A cache inherited through the environment is never accepted: that is configuration, not input, so it is refused.
if (typeof module.getCompileCacheDir === "function" && module.getCompileCacheDir()) throw new Error("chart extract refuses an inherited compile cache (NODE_COMPILE_CACHE)");
const requestedCache = request.compileCacheDir ?? null;
if (requestedCache !== null && (typeof requestedCache !== "string" || requestedCache.length > 512 || requestedCache.includes("\0") || !path.isAbsolute(requestedCache) || path.normalize(requestedCache) !== requestedCache)) {
  throw new Error("invalid chart extract compile cache");
}
/** Why `dir` cannot serve as a read-only compile cache, or null when it can. */
function cacheUnsafe(dir) {
  const probe = (d) => {
    const file = path.join(d, `.chart-guest-probe-${process.pid}-${Date.now()}`);
    try { writeFileSync(file, "", { flag: "wx" }); } catch { return false; }
    try { unlinkSync(file); } catch { /* removed or not, it was writable */ }
    return true;
  };
  // An entry the guest's own (non-root) user owns can be chmod-ed back to writable: not read-only. Root on a read-write
  // mount fails the write probe instead.
  const uid = process.getuid?.() ?? -1;
  const ownedHere = (p) => uid > 0 && lstatSync(p).uid === uid;
  try {
    if (!lstatSync(dir).isDirectory()) return "not a directory";
    if (ownedHere(dir)) return "owned by the guest user";
    if (probe(dir)) return "writable";
    // Node keeps entries one level down (a per-version directory); at most a few, all checked.
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.length > 16) return "unexpected layout";
    for (const e of entries) {
      const sub = path.join(dir, e.name);
      if (e.isSymbolicLink()) return "symbolic link";
      if (ownedHere(sub)) return "owned by the guest user";
      if (!e.isDirectory()) { try { accessSync(sub, fsc.W_OK); return "writable"; } catch { continue; } }
      if (probe(sub)) return "writable";
      const files = readdirSync(sub, { withFileTypes: true });
      if (files.length > 64) return "unexpected layout";
      for (const f of files) {
        if (!f.isFile()) return "unexpected layout";
        if (ownedHere(path.join(sub, f.name))) return "owned by the guest user";
        try { accessSync(path.join(sub, f.name), fsc.W_OK); return "writable"; } catch { /* read-only, as required */ }
      }
    }
    return null;
  } catch {
    return "unreadable";
  }
}
const unsafe = requestedCache ? cacheUnsafe(requestedCache) : null;
if (unsafe) process.stderr.write(`[chart-guest] compile cache disabled: ${unsafe}\n`);
const compileCacheDir = requestedCache && !unsafe ? requestedCache : null;
if (compileCacheDir) module.enableCompileCache(compileCacheDir);
// One bundled module (built from dist/chart-export/extractors/guest-entry.js): loads in a fraction of the CPU the
// separate ESM files take, which matters because every VM command starts a fresh process. A fixed path, loaded after
// the cache is enabled. `testHooks` is null in the production bundle (a build-time constant), so the test-only knobs
// below are inert there.
const { CHART_EXTRACT_LIMITS, testHooks, reassembleUnits, resultVisualBytes, resumeSkipList, fitResult, MAX_RESULT_BYTES } = await import("../dist/chart-export/guest.bundle.mjs");
const kind = request?.kind;
if (!["office", "epub", "svg", "html", "json"].includes(kind)) throw new Error("invalid chart extract kind");
const packaged = kind === "office" || kind === "epub";
const options = { diagrams: request.diagrams !== false };
// Deadline below the host's timeout (the host sends its timeout minus a margin): past it, SVGs not yet analysed are
// returned as a counted `guest-deadline` deferral, so a slow input keeps what it produced instead of being killed.
const budgetMs = Number.isSafeInteger(request.budgetMs) && request.budgetMs >= 1_000 && request.budgetMs <= 175_000 ? request.budgetMs : 45_000;
const deadline = started + budgetMs;

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
  // The batch file has the same cap as one result. The shared visual budget keeps it far under; if refusals still push it
  // over, each figure is held to an equal share, truncated and counted (council r10 M1), never thrown.
  json = JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results });
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) {
    const share = Math.floor((MAX_RESULT_BYTES - 4096) / results.length);
    json = JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results: results.map((r) => fitResult(r, share)) });
  }
} else {
  if (more.length > 0) throw new Error("unexpected chart extract inputs");
  if ((await stat(input)).size > (packaged ? CHART_EXTRACT_LIMITS.maxPackageBytes : CHART_EXTRACT_LIMITS.maxTextBytes)) throw new Error("chart extract input exceeds limit");
  // Held to the result cap by fitResult (inside reassembly, and again here for the fast path): truncated and counted.
  json = JSON.stringify(fitResult(await extractContained(input, kind, packaged, CHART_EXTRACT_LIMITS.maxOutputBytes)));
}
await writeFile(output, json, { mode: 0o600 });
