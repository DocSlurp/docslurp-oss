// Merge per-tag analysis summaries into the committed summary.json.
// Usage: node combine-summary.mjs <run-dir> <out.json> <tag>...
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [runDir, out, ...tags] = process.argv.slice(2);
const runs = Object.fromEntries(tags.map((tag) => [tag, JSON.parse(readFileSync(path.join(runDir, `raw-${tag}`, `summary-${tag}.json`), "utf8"))]));
// Routed pages the router wanted pixels for but the shadow-mode (legacy) extraction left native.
const routedGap = Object.fromEntries(tags.map((tag) => {
  const a = JSON.parse(readFileSync(path.join(runDir, `raw-${tag}`, "analysis.json"), "utf8"));
  const armA = new Map(a.perDocument.filter((x) => x.arm === "A").map((x) => [x.file, x]));
  const rows = a.perDocument.filter((x) => x.arm === "B").flatMap((x) => x.layoutRows.filter((r) => r.selection === "routed").map((r) => ({ file: x.file, page: r.pageNumber, armAVlm: armA.get(x.file)?.visionSelectedPages.includes(r.pageNumber) ?? false })));
  const kindOf = new Map(a.perDocument.map((x) => [x.file, x.kind]));
  const left = rows.filter((r) => !r.armAVlm);
  return [tag, { routedRows: rows.length, armASentToVlm: rows.filter((r) => r.armAVlm).length, armALeftNative: left.length,
    armALeftNativeByKind: left.reduce((m, r) => ({ ...m, [kindOf.get(r.file)]: (m[kindOf.get(r.file)] ?? 0) + 1 }), {}) }];
}));
// Evidence identifiers (file names, case ids) stay in the external raw-<tag>/analysis.json; the committed
// summary carries only aggregates so product-tree scans cannot match fixture identifiers.
for (const run of Object.values(runs)) {
  run.auditFindings = run.auditFindings.map(({ file, ...rest }) => rest);
  if (run.policyC?.diagnosticTextOnlyLayoutGate) run.policyC.diagnosticTextOnlyLayoutGate.rows = run.policyC.diagnosticTextOnlyLayoutGate.rows.map(({ file, ...rest }) => rest);
}
const meta = JSON.parse(readFileSync(path.join(runDir, "run-meta.json"), "utf8"));
writeFileSync(out, JSON.stringify({ schema: "router-e2e-combined@v1", ...meta, runs, routedPagesLeftNativeByShadowExtraction: routedGap }, null, 2));
console.log(`wrote ${out}`);
