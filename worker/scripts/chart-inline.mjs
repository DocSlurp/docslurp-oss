// Parser VM only: inline chart extraction inside the quarantine inspection process (DOCSLURP_CHART_EXPORT_INLINE).
// Unit containment, as #364's guest (chart-export-extract.mjs): the extraction runs in #364's own unit worker
// (chart-export-worker.mjs), which streams every finished unit (an SVG, an embedded-spec scan, an Office chart part). If a
// unit crashes the worker, exhausts its heap or memory budget, or overruns, the worker is ended, that one unit is recorded
// as `unit-crashed` / `unit-timeout`, and a fresh worker resumes after it, skipping every unit already finished or failed.
// Bounds, all of them inline's own (smaller than the standalone guest's), so nothing reaches the inspection:
// - a V8 heap limit per worker (resourceLimits);
// - a process RSS growth limit, polled while a worker runs (the heap limit does not cover Buffers/ArrayBuffers);
// - a wall-clock budget: the extractor's own deadline (setGuestDeadline, softDeadlineShare of it), each unit at most
//   what is left, the whole step at most startupMs + the size-scaled deadline, and never past commandCutoffMs of the
//   quarantine command (inlineStepBudget: the inspection's time counts, council #369 L4); past it one short count-only
//   worker records what is left as guest-deadline ranges. Too little left to start: refused command-budget.
import { accessSync, constants, readdirSync } from "node:fs";
import module from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { INLINE_CHART_LIMITS, inlineChartPlan, inlineStepBudget } from "../dist/chart-export/inline-guest.js";

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
/**
 * #364's own reassembly (reassemble.ts, exported by the bundle: reassembleUnits, resumeSkipList), loaded only when a
 * unit was lost. The normal path returns the worker's result unchanged and never loads the bundle on this thread (it is
 * ~1 MB, and its zod must come after the bundle's zod-jitless import, so its modules are never imported one by one here).
 */
const BUNDLE = new URL("../dist/chart-export/guest.bundle.mjs", import.meta.url);
let guestModule = null;
async function guest(compileCacheDir) {
  if (!guestModule) {
    if (compileCacheDir) { try { module.enableCompileCache(compileCacheDir); } catch { /* no cache: same result */ } }
    guestModule = await import(BUNDLE.href);
  }
  return guestModule;
}
/** A count-only worker (past the deadline) gets this long: it parses nothing, it records what is left. */
const COUNT_ONLY_MS = INLINE_CHART_LIMITS.countOnlyMs;
/** How long a finished worker gets to exit before the next one starts anyway. */
const TERMINATE_WAIT_MS = INLINE_CHART_LIMITS.terminateWaitMs;
const MAX_WORKERS = 8;

/**
 * Run one unit worker until it returns a result, crashes, overruns or passes the memory budget; finished units go into
 * `done`. Resolves { result } | { failure: "timeout" | "crashed" | "exited", inflight }.
 */
/**
 * Run one unit worker until it returns a result, crashes, overruns or passes its memory budget; finished units go into
 * `done`. Resolves only once the worker has exited (or after TERMINATE_WAIT_MS), so the next worker never starts beside a
 * dying one. Bounds (council #369/#510 r4 L1, parity with #364's guest):
 * - each unit at most `unitCapMs` (and never past the step);
 * - memory: this worker's own baseline plus the growth budget, never past the step's hard ceiling. Before its first unit
 *   the worker runs only our code, so only the ceiling applies then: memory a finished worker has not yet returned cannot
 *   end the input;
 * - messages after the worker is settled are ignored (#364 council r9 I1).
 */
function runWorker(workerUrl, task, done, index, ends, memory, onStart, compileCacheDir, unitCapMs, onReady = () => {}) {
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
      // When the worker stopped working on the file (before the exit wait), for the step's work-time account.
      outcome.endedAt = performance.now();
      clearTimeout(unitTimer);
      clearTimeout(hardTimer);
      clearInterval(watch);
      const exited = worker.terminate().catch(() => undefined);
      void Promise.race([exited, new Promise((r) => setTimeout(r, TERMINATE_WAIT_MS))]).then(() => resolve(outcome));
    };
    const workerLimit = Math.min(memory.ceiling, process.memoryUsage.rss() + memory.growth);
    // `ends()` is the step's hard end; it moves earlier once the first worker reports ready (measured start-up).
    const left = () => Math.max(1, ends() - performance.now());
    let hardTimer = setTimeout(() => finish({ failure: "timeout", inflight }), left());
    // The real memory bound (heap limits do not cover external memory): over it, the unit in flight is lost (crashed).
    const watch = setInterval(() => {
      const rss = process.memoryUsage.rss();
      if (rss > memory.ceiling || (inflight && rss > workerLimit)) finish({ failure: "crashed", inflight });
    }, INLINE_CHART_LIMITS.rssPollMs);
    worker.on("message", (m) => {
      if (settled) return;
      if (m?.t === "ready") {
        onReady();
        clearTimeout(hardTimer);
        hardTimer = setTimeout(() => finish({ failure: "timeout", inflight }), left());
      } else if (m?.t === "start") {
        inflight = { id: m.id, locator: m.locator, svgIndex: m.svgIndex, svg: m.svg };
        onStart(inflight);
        clearTimeout(unitTimer);
        unitTimer = setTimeout(() => finish({ failure: "timeout", inflight }), Math.min(left(), unitCapMs));
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
 * `bytes`: the file (for the plan); `inputPath`: the same file on disk (the unit workers read it). `request`: { kind,
 * diagrams } from the host. `inspection`: this process's own inspection of the same bytes. Workers start only after the
 * plan passed. `workerUrl` exists for the tests' hostile workers. Returns { status: "ok", ms, result } |
 * { status: "skipped", reason } | { status: "refused", reason, ms } (no unit could be placed: start-up, or every worker
 * failing outside any unit).
 */
/**
 * `clock.commandStartedAt`: when the quarantine command started, on the performance.now() clock (quarantine-inspect.mjs
 * passes 0, the process start). The step is charged against the command's budget from there (inlineStepBudget, council
 * #369 L4). Omitted (tests, in-process callers): the step starts the clock itself.
 */
export async function inlineCharts(bytes, request, inspection, inputPath, workerUrl = WORKER, compileCacheDir = readOnlyCompileCache(), clock = {}) {
  const kind = typeof request?.kind === "string" ? request.kind : "";
  let text;
  const plan = inlineChartPlan(kind, inspection, bytes.length, () => (text ??= bytes.toString("utf8")));
  if (!plan.run) return { status: "skipped", reason: plan.reason };
  // A compile cache inherited through the environment (NODE_COMPILE_CACHE) is configuration, not input, and may be
  // writable: refused, as #364's guest refuses it (the host strips NODE_* from parser commands). Charts only; the
  // inspection stands.
  if (typeof module.getCompileCacheDir === "function" && module.getCompileCacheDir()) return { status: "refused", reason: "cache-inherited", ms: 0 };
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  // The step's budget, cut at the quarantine command's cutoff: a slow inspection shortens it, and with too little left the
  // charts are refused (counted by the host as a deferral) so the command always finishes with its verdict.
  const budget = inlineStepBudget({ now: started, commandStartedAt: typeof clock.commandStartedAt === "number" ? clock.commandStartedAt : started, sizeBytes: bytes.length });
  if (!budget) return { status: "refused", reason: "command-budget", ms: 0 };
  // Time on the file is charged by measurement (council #387 M2): only the time workers spend after reporting ready
  // (bundle loaded, our code only before that) counts against the file's size-scaled deadline, so a fast start-up is not
  // banked as extra time for the file, and a worker restart's own start-up and exit wait do not eat it. `budget.endsAt`
  // (the start-up allowance plus the deadline, cut at the command cutoff) caps the whole step.
  let workUsed = 0;
  // The extractor's own (soft) deadline, inside the hard one: past it, unanalysed units become counted deferrals. Each
  // worker counts it from its own ready (deadlineMs: the same share of the work time left), capped by the command budget
  // (deadline, epoch ms).
  const softCap = Date.now() + budget.softMs;
  const options = { diagrams: request.diagrams !== false };
  // One memory budget for the whole step, from the RSS before the first worker: a later worker never inherits the
  // headroom of memory an ended worker has not yet returned.
  const growth = INLINE_CHART_LIMITS.maxRssGrowthMb * 1024 * 1024;
  // Each worker may grow by `growth` from its own start; the whole step never past twice that from here.
  const memory = { growth, ceiling: process.memoryUsage.rss() + 2 * growth };
  // One unit at most a quarter of the step's deadline (at least 3 s, so a heap overrun ends as the crash it is): a hang loses itself, not the rest (as #364's 15 s
  // per unit inside its 45 s budget).
  const unitCapMs = budget.unitCapMs;
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
    const workLeft = Math.max(0, budget.deadlineMs - workUsed);
    const countOnly = performance.now() >= budget.endsAt || workLeft === 0 || w >= MAX_WORKERS - 1;
    let readyAt = null;
    // A count-only worker: its start-up (measured, capped) and then COUNT_ONLY_MS to record what is left.
    let workerEnd = countOnly ? performance.now() + INLINE_CHART_LIMITS.countOnlyStartupMs : budget.endsAt;
    const onReady = () => {
      if (readyAt !== null) return;
      readyAt = performance.now();
      workerEnd = countOnly ? readyAt + COUNT_ONLY_MS : Math.min(budget.endsAt, readyAt + workLeft);
    };
    // UnitControl.skip (#364 resumeSkipList): unit id to { visuals, bytes }, so a resumed worker carries the byte total.
    const skip = w === 0 ? [] : (await guest(compileCacheDir)).resumeSkipList(done, failed.keys());
    const task = { path: inputPath, kind, packaged: plan.packaged, options, skip, outputBudget: INLINE_OUTPUT_BUDGET, deadline: countOnly ? 0 : softCap, ...(countOnly ? {} : { deadlineMs: Math.floor(workLeft * INLINE_CHART_LIMITS.softDeadlineShare) }), fault };
    const outcome = await runWorker(workerUrl, task, done, w, () => workerEnd, memory,
      (unit) => { nextSvg = unit.svgIndex + (unit.svg ? 1 : 0); }, compileCacheDir, unitCapMs, onReady);
    if (readyAt !== null && !countOnly) workUsed += Math.max(0, outcome.endedAt - readyAt);
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
  const result = final && failed.size === 0 ? final : (await guest(compileCacheDir)).reassembleUnits({
    done, failed: [...failed.values()].map(({ id, svgIndex, reason }) => ({ id, svgIndex, reason })), final, lastWorker,
    unplaced: unplaced ? { svgIndex: nextSvg, locator: kind } : null, outputBudget: INLINE_OUTPUT_BUDGET, maxResultBytes: INLINE_CHART_LIMITS.maxResultBytes,
  });
  let json = JSON.stringify(result);
  // Held to the inline answer's cap by #364's fitResult (truncated and counted: output-limit, overflow), as the guest does
  // for its fast path, instead of refusing the whole answer. Loaded only when over the cap.
  if (Buffer.byteLength(json) > INLINE_CHART_LIMITS.maxResultBytes) json = JSON.stringify((await guest(compileCacheDir)).fitResult(JSON.parse(json), INLINE_CHART_LIMITS.maxResultBytes));
  if (Buffer.byteLength(json) > INLINE_CHART_LIMITS.maxResultBytes) return { status: "refused", reason: "result-too-large", ms: ms() };
  return { status: "ok", ms: ms(), result: JSON.parse(json) };
}
