import { test } from "node:test";
import assert from "node:assert/strict";
import { calibrate } from "../scripts/calibrate-cost.mjs";
const rates = { cpuCores: 1, memoryGiB: 2, cpuUsdPerCoreSecond: 0.00003942, memoryUsdPerGiBSecond: 0.00000667, ocrUsdPerPage: 0.0015, tableWithOcrUsdPerPage: 0.015 };
const runtime = { t: "runtime", moduleSha256: "a".repeat(64), options: { maxDeepPages: 1000 } };
const calculate = rows => calibrate([runtime, ...rows], rates);
const run = { t: "measurement", id: "sample", kind: "table", oraclePages: 10, validInventory: true, fullDeep: false, elapsedMs: 1000, end: { complete: true, inventoryPages: 10, deepSelected: 10, deepAttempted: 10, deepMeasured: 9, deepPartial: 1 } };
test("partial inspection cannot become a full-deep cost calibration", () => {
  const doc = calculate([run]).documents[0];
  assert.equal(doc.fullDeepUsdPer1000Pages, null);
  assert.equal(doc.downstreamScenarios.allPagesTablesIncludingOcrUsd, 0.15);
  assert.equal(doc.downstreamScenarios.allPagesOcrOnlyUsd, 0.015);
  assert.ok(Math.abs(doc.estimatedProfilerUsdPer1000InventoryPages - 0.005276) < 1e-12);
});
test("failed and mismatched inventory runs never contribute speed or cost", () => {
  const result = calculate([{ ...run, validInventory: false }, { ...run, oraclePages: 11 }]);
  assert.equal(result.documents[0].calibration, null);
  assert.equal(result.documents[0].failedRuns, 2);
});
test("negative prices, zero times and inconsistent page counts reject", () => {
  assert.throws(() => calibrate([runtime, run], { ...rates, ocrUsdPerPage: -1 }));
  assert.throws(() => calculate([{ ...run, elapsedMs: 0 }]));
  assert.throws(() => calculate([run, { ...run, oraclePages: 11, end: { ...run.end, inventoryPages: 11 } }]));
});
test("mixed runtimes and forged completion cannot yield full-deep calibration", () => {
  assert.throws(() => calibrate([runtime, runtime, run], rates));
  assert.throws(() => calculate([{ ...run, oraclePages: NaN }]));
  assert.throws(() => calculate([{ ...run, end: { ...run.end, deepPartial: 99 } }]));
  assert.equal(calculate([{ ...run, fullDeep: true }]).documents[0].fullDeepUsdPer1000Pages, null);
});
