import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { score } from "./eval.mjs";

const [datasetPath, preflightPath, runDirectory, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: score-embedding-screen.mjs DATASET PREFLIGHT RUN_DIRECTORY OUTPUT");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const datasetRaw = readFileSync(datasetPath), preflight = JSON.parse(readFileSync(preflightPath, "utf8"));
if (hash(datasetRaw) !== preflight.datasetSha256) throw new Error("Frozen dataset hash mismatch");
const dataset = JSON.parse(datasetRaw), stateRaw = readFileSync(join(runDirectory, "state.json")), state = JSON.parse(stateRaw);
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null; };
const arms = state.arms.map((arm) => {
  if (arm.status !== "success") return { id: arm.id, status: arm.status, score: "not_complete" };
  const records = dataset.cases.map((test) => {
    const path = join(runDirectory, arm.id, `query-${test.id}.json`), raw = readFileSync(path), response = JSON.parse(raw);
    const results = response.hits.map((hit) => ({ text: hit.text, citation: { documentId: hit.documentId, pageNumber: hit.pageNumber, pageNumbers: hit.pageNumbers ?? [], sourceTrace: hit.metadata?.sourceTrace ?? null } }));
    return { ...score(test, results), kind: test.kind, latencyMs: response.latencyMs, responseSha256: hash(raw) };
  });
  const explicit = records.filter((item) => item.kind === "explicit"), inferred = records.filter((item) => item.kind === "inferred"), latencies = records.map((item) => item.latencyMs);
  return { id: arm.id, status: arm.status, explicitCorrect: explicit.filter((item) => item.correct).length, explicitTotal: explicit.length, explicitMrr: explicit.reduce((sum, item) => sum + item.reciprocalRank, 0) / explicit.length, primaryCitationCorrect: explicit.filter((item) => item.primaryPageCorrect).length, sourceTraceCitationCorrect: explicit.filter((item) => item.sourceTracePageCorrect).length, inferredPremisesComplete: inferred.filter((item) => item.correct).length, inferredTotal: inferred.length, negativeControls: records.filter((item) => item.kind === "unanswerable").map(({ id, status, retrievalHits }) => ({ id, status, retrievalHits })), latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95), min: Math.min(...latencies), max: Math.max(...latencies) }, providerActualUsd: arm.providerActualUsd, records };
});
const baseline = arms.find((arm) => arm.id === "openai1536");
for (const arm of arms) if (arm.records && baseline?.records) {
  arm.recovered = arm.records.filter((row) => row.kind !== "unanswerable" && row.correct && !baseline.records.find((item) => item.id === row.id)?.correct).map((row) => row.id);
  arm.regressed = arm.records.filter((row) => row.kind !== "unanswerable" && !row.correct && baseline.records.find((item) => item.id === row.id)?.correct).map((row) => row.id);
}
const report = { at: new Date().toISOString(), evaluation: "dense-only exact cosine over matched retained provider inputs; not hybrid/answer quality", sourceCommit: state.sourceCommit, screenId: state.screenId, sourceStateSha256: hash(stateRaw), datasetSha256: preflight.datasetSha256, querySha256: preflight.querySha256, corpusHashes: preflight.corpora.map(({ documentId, corpusSha256, artifactSha256 }) => ({ documentId, corpusSha256, artifactSha256 })), stateStatus: state.status, providerActualUsd: state.providerActualUsd, customerLedgerUsd: state.customerLedgerUsd ?? null, deferredArms: preflight.arms.filter((arm) => arm.status), arms };
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ stateStatus: report.stateStatus, providerActualUsd: report.providerActualUsd, arms: arms.map(({ id, status, explicitCorrect, explicitTotal, explicitMrr, recovered, regressed }) => ({ id, status, explicitCorrect, explicitTotal, explicitMrr, recovered, regressed })) }, null, 2));
