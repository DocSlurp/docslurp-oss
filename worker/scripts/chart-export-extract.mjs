// Parser-VM guest: deterministic chart/diagram extraction (office-chart-xml, embedded-spec, svg-geometry).
// argv: <input file> <request.json> <output.json> [more input files...]. Reads customer bytes; runs only inside the
// parser VM in production. With `batch: N` in the request (SVG only), the first input plus the N-1 trailing inputs are
// extracted one by one, each under its own size limit, and the output is one result per input, in order.
import { readFile, stat, writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
// One bundled module (built from dist/chart-export/extractors/guest-entry.js): loads in a fraction of the CPU the
// separate ESM files take, which matters because every VM command starts a fresh process.
import { CHART_EXTRACT_LIMITS } from "../dist/chart-export/guest.bundle.mjs";
const started = Date.now();
const [input, requestPath, output, ...more] = process.argv.slice(2);
if ((await stat(requestPath)).size > 4096) throw new Error("chart extract request exceeds limit");
const request = JSON.parse(await readFile(requestPath, "utf8"));
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
 * skipping every unit already finished or failed. Past the deadline, a last worker only counts what is left. So no
 * input can take the guest down: the document keeps every other visual, and every loss is counted.
 */
const WORKER = new URL("./chart-export-worker.mjs", import.meta.url);
// Heap per worker: well inside the 4 GiB parser VM next to this small parent (measured legitimate peaks are < 600 MB).
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: Number(process.env.DOCSLURP_CHART_GUEST_TEST_HEAP_MB) > 0 ? Number(process.env.DOCSLURP_CHART_GUEST_TEST_HEAP_MB) : 1536, maxYoungGenerationSizeMb: 64 };
// Wall clock one unit may take (legitimate units take milliseconds; the gates bound hostile ones to seconds).
const UNIT_TIMEOUT_MS = Number(process.env.DOCSLURP_CHART_GUEST_TEST_UNIT_MS) > 0 ? Number(process.env.DOCSLURP_CHART_GUEST_TEST_UNIT_MS) : 15_000;
// A worker started past the deadline only counts the rest; it gets this long.
const COUNT_ONLY_MS = 5_000;
const MAX_WORKERS_PER_INPUT = 8;

/** Run one worker until it returns a result, crashes or overruns; record finished units into `done`. */
function runWorker(task, done, workerIndex) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER, { resourceLimits: RESOURCE_LIMITS });
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
      if (m.t === "start") {
        inflight = { id: m.id, locator: m.locator, svgIndex: m.svgIndex, svg: m.svg };
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
    worker.postMessage(task);
  });
}

/** One input, contained: the worker's own result when nothing failed (identical to an uncontained run). */
async function extractContained(path, kind, packaged) {
  const done = new Map();
  const failed = new Map();
  let final = null;
  let lastWorker = 0;
  let unplaced = false;
  for (let w = 0; ; w++) {
    const countOnly = Date.now() >= deadline || w >= MAX_WORKERS_PER_INPUT - 1;
    const skip = [...[...done].map(([id, d]) => [id, d.delta.visuals.length]), ...[...failed.keys()].map((id) => [id, 0])];
    const outcome = await runWorker({ path, kind, packaged, options, skip, deadline: countOnly ? 0 : deadline }, done, w);
    lastWorker = w;
    if (outcome.result) { final = outcome.result; break; }
    if (outcome.inflight && !failed.has(outcome.inflight.id) && !countOnly) {
      failed.set(outcome.inflight.id, { ...outcome.inflight, reason: outcome.failure === "timeout" ? "unit-timeout" : "unit-crashed" });
      continue;
    }
    // A failure outside any unit, or in the counting worker: nothing more can be isolated.
    unplaced = true;
    break;
  }
  if (final && failed.size === 0) return final;
  // Reassemble: units finished by earlier workers, the failed units, and the last worker's own accounting.
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

let json;
if (request.batch !== undefined) {
  const batch = request.batch;
  if (kind !== "svg" || !Number.isSafeInteger(batch) || batch < 1 || batch > 40 || more.length !== batch - 1) throw new Error("invalid chart extract batch");
  const refused = (reason) => ({ schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "svg", reason }] });
  const results = [];
  // Each figure runs contained: one bad figure never sinks the others; the host sees a machine reason only.
  for (const file of [input, ...more]) {
    if ((await stat(file)).size > CHART_EXTRACT_LIMITS.maxTextBytes) { results.push(refused("input-too-large")); continue; }
    try {
      results.push(await extractContained(file, kind, false));
    } catch {
      results.push(refused("extract-failed"));
    }
  }
  json = JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results });
} else {
  if (more.length > 0) throw new Error("unexpected chart extract inputs");
  if ((await stat(input)).size > (packaged ? CHART_EXTRACT_LIMITS.maxPackageBytes : CHART_EXTRACT_LIMITS.maxTextBytes)) throw new Error("chart extract input exceeds limit");
  json = JSON.stringify(await extractContained(input, kind, packaged));
}
if (Buffer.byteLength(json) > MAX_RESULT_BYTES) throw new Error("chart extract result exceeds limit");
await writeFile(output, json, { mode: 0o600 });
