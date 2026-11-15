// Offline analysis of benchmark-real.mjs evidence; no provider/model calls.
// node calibrate-cost.mjs measurements.jsonl rates.json > calibration.json
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function nonnegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
export function calibrate(records, rates) {
  const runtimes = records.filter(r => r.t === "runtime");
  if (runtimes.length !== 1 || !/^[a-f0-9]{64}$/.test(runtimes[0].moduleSha256 ?? "") || !runtimes[0].options) {
    throw new Error("one identified runtime/configuration is required; never pool builds");
  }
  const perSecond = nonnegative(rates.cpuCores, "CPU allocation") * nonnegative(rates.cpuUsdPerCoreSecond, "CPU rate")
    + nonnegative(rates.memoryGiB, "memory allocation") * nonnegative(rates.memoryUsdPerGiBSecond, "memory rate");
  const ocr = nonnegative(rates.ocrUsdPerPage, "OCR rate"), table = nonnegative(rates.tableWithOcrUsdPerPage, "table rate");
  const groups = new Map();
  for (const row of records.filter(r => r.t === "measurement")) {
    if (!groups.has(row.id)) groups.set(row.id, []);
    groups.get(row.id).push(row);
  }
  const documents = [];
  for (const [id, attempts] of groups) {
    for (const row of attempts) {
      if (!Number.isSafeInteger(row.oraclePages) || row.oraclePages < 1) throw new Error("invalid page count");
      if (row.end?.complete) {
        const e = row.end;
        for (const key of ["inventoryPages", "deepSelected", "deepAttempted", "deepMeasured", "deepPartial"]) {
          if (!Number.isSafeInteger(e[key]) || e[key] < 0) throw new Error("invalid evidence count");
        }
        if (e.deepSelected > e.inventoryPages || e.deepAttempted > e.deepSelected || e.deepMeasured + e.deepPartial > e.deepAttempted) throw new Error("inconsistent evidence counts");
      }
    }
    const valid = attempts.filter(r => r.validInventory && r.end?.complete && r.oraclePages > 0 && r.end.inventoryPages === r.oraclePages);
    for (const r of valid) nonnegative(r.elapsedMs, "elapsed time");
    const failed = attempts.length - valid.length;
    if (!valid.length) { documents.push({ id, validRuns: 0, failedRuns: failed, calibration: null }); continue; }
    const pages = valid[0].oraclePages;
    if (valid.some(r => r.oraclePages !== pages)) throw new Error("inconsistent page counts");
    const seconds = valid.map(r => r.elapsedMs / 1000);
    if (seconds.some(s => s <= 0)) throw new Error("zero elapsed time");
    const mid = median(seconds), fullyMeasured = valid.every(r => r.fullDeep && r.end.deepComplete === true && r.end.deepPartial === 0 && r.end.deepMeasured === pages);
    const costs = seconds.map(s => s / pages * 1000 * perSecond);
    const native = valid.map(r => r.nativeTextExtraction).filter(r => r && !r.error && r.outputBytes > 0 && Number.isFinite(r.elapsedMs) && r.elapsedMs > 0);
    documents.push({ id, kind: valid[0].kind, pages, validRuns: valid.length, failedRuns: failed,
      scope: "inventory-all-pages-and-attempt-selected-deep-pages", fullyMeasured,
      deepMeasuredPerRun: valid.map(r => r.end.deepMeasured), partialPerRun: valid.map(r => r.end.deepPartial),
      medianSeconds: mid, pagesPerSecond: pages / mid, pagesPerMinute: pages * 60 / mid,
      observedSecondsRange: [Math.min(...seconds), Math.max(...seconds)],
      estimatedProfilerUsdPer1000InventoryPages: median(costs),
      observedCostRangeUsdPer1000InventoryPages: [Math.min(...costs), Math.max(...costs)],
      estimatedProfilerUsdPerDocument: mid * perSecond,
      fullDeepUsdPer1000Pages: fullyMeasured ? median(costs) : null,
      nativeTextExtraction: native.length ? {
        tool: "pdftotext -layout", validRuns: native.length, qualityValidated: false,
        medianSeconds: median(native.map(r => r.elapsedMs / 1000)),
        pagesPerSecond: pages * 1000 / median(native.map(r => r.elapsedMs)),
        estimatedUsdPer1000Pages: median(native.map(r => r.elapsedMs / pages * perSecond)),
        outputBytes: native.map(r => r.outputBytes),
      } : null,
      downstreamScenarios: {
        allPagesOcrOnlyUsd: pages * ocr,
        allPagesTablesIncludingOcrUsd: pages * table,
        // These are alternative scenarios, never additive (table API includes OCR).
        ocrOnlyUsdPer1000Pages: 1000 * ocr, tablesIncludingOcrUsdPer1000Pages: 1000 * table,
        chartInterpretationUsd: null,
      },
    });
  }
  return { schema: "offline-profiler-cost-calibration@1", generatedAt: new Date().toISOString(), runtime: runtimes[0], rates,
    estimatedAllocationUsdPerSecond: perSecond, documents,
    caveats: ["Compute uses requested allocation times measured wall time, not a provider invoice.",
      "Per-1000-page values normalize these exact document shapes; they do not predict scaling or whole-file deep inspection beyond 1000 pages.",
      "Observed ranges across three runs are not confidence intervals; first pass is not guaranteed disk-cold.",
      "Startup, staging, output transfer, rendering, retries, idle time, storage, egress and orchestration are excluded from marginal profiler cost; lifecycle receipt reports whole VM allocation separately.",
      "Downstream API prices are hypothetical alternatives, not measured DocSlurp routing, billing, extraction quality or latency. Table API includes OCR; do not add both prices.",
      "No paid OCR/model calls were made. Vector-chart interpretation has no calibrated cost; missing evidence stays null."] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [measurements, prices] = process.argv.slice(2);
  const records = (await readFile(measurements, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  console.log(JSON.stringify(calibrate(records, JSON.parse(await readFile(prices, "utf8"))), null, 2));
}
