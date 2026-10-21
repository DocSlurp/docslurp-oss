import test from "node:test";
import assert from "node:assert/strict";
import { compareOverhead, estimateOverhead } from "./guardrail-overhead.mjs";
const sample = (pairId, mode, elapsedMs, outcome = "allow", providerCostUsd = 1) => ({ pairId, workloadHash: "same", traceId: `${pairId}-${mode}`, mode, elapsedMs, outcome, providerCostUsd });
test("pairs work correctly, excludes rejection from equivalent-work latency and preserves missing costs", () => {
  const report = compareOverhead([sample("a", "judge", 130), sample("b", "off", 200), sample("a", "off", 100), sample("b", "judge", 10, "block", null)]).results[0];
  assert.equal(report.allowedPairedDeltaMs.mean, 30);
  assert.equal(report.outcomes.block, 1);
  assert.equal(report.unknownCostPairs, 1);
  assert.equal(report.pairedCostDeltaUsd.mean, 0);
});
test("rejects missing baselines, duplicates and changed workloads", () => {
  assert.throws(() => compareOverhead([sample("a", "judge", 10)]), /baseline/);
  assert.throws(() => compareOverhead([sample("a", "off", 10), sample("a", "off", 20)]), /Duplicate/);
  assert.throws(() => compareOverhead([sample("a", "off", 10), { ...sample("a", "judge", 20), workloadHash: "different" }]), /mismatch/);
});
test("estimates provider increments without inventing latency or free compute", () => {
  const report = estimateOverhead({ checks: 10000, inputTokens: 1000, outputTokens: 100, inputUsdPerMillion: .25, outputUsdPerMillion: 1.5, escalationFraction: .1 });
  assert.deepEqual(report.incrementalProviderCostUsd, { off: 0, moderation: 0, judge: 4, cascade: .4 });
  assert.equal(report.latencyMs, null);
});
