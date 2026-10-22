import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSbomSarif } from "./normalize-sbom-sarif.mjs";

test("retains findings and severity while replacing empty SPDX locations without fabricated lines", () => {
  const result = { ruleId: "advisory-package", level: "error", message: { text: "critical finding" }, locations: [{ physicalLocation: { artifactLocation: { uri: "" }, region: { startLine: 1 } } }] };
  const report = { runs: [{ results: [result, { ruleId: "no-location" }] }] };
  normalizeSbomSarif(report, "worker-source-sbom.spdx.json");
  assert.equal(report.runs[0].results.length, 2);
  assert.equal(result.level, "error");
  assert.equal(result.message.text, "critical finding");
  for (const item of report.runs[0].results) {
    assert.deepEqual(item.locations[0].physicalLocation, { artifactLocation: { uri: "worker-source-sbom.spdx.json" } });
  }
});

test("preserves actual and indexed source locations", () => {
  const report = { runs: [{ artifacts: [{ location: { uri: "pnpm-lock.yaml" } }], results: [
    { locations: [{ physicalLocation: { artifactLocation: { uri: "worker/requirements.txt" }, region: { startLine: 4 } } }] },
    { locations: [{ physicalLocation: { artifactLocation: { index: 0 } } }] },
  ] }] };
  const original = structuredClone(report);
  assert.deepEqual(normalizeSbomSarif(report, "worker-source-sbom.spdx.json"), original);
});
