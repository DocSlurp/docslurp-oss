// Explicit read-only remote search runner; inputs/credentials remain external.
import fs from "node:fs";
import { join } from "node:path";
import { score, hash } from "./eval.mjs";
const [datasetPath, configPath, output, go] = process.argv.slice(2);
if (go !== "--go") throw new Error("Network disabled: explicit --go required");
const dataset = JSON.parse(fs.readFileSync(datasetPath));
const config = JSON.parse(fs.readFileSync(configPath));
const allowed = new Set(["rerank", "mmr", "parentRetrieval", "limit", "minScore"]);
if (config.helperModelProof) {
  const proof = JSON.parse(fs.readFileSync(config.helperModelProof));
  const outputPrice = Number(proof.model?.pricing?.completion) * 1_000_000;
  if (proof.model?.id !== config.expectedHelperModel || /(?:^|[-/])(?:pro|ultra)(?:$|[-/])/i.test(proof.model?.id ?? "") || !Number.isFinite(outputPrice) || outputPrice >= 50 || !config.runtimeModelEvidence) throw new Error("Unverified helper model or prohibited price");
  allowed.add("queryRewrite");
  allowed.add("iterativeMultiHop");
}
for (const arm of config.arms) for (const key of Object.keys(arm.overrides)) if (!allowed.has(key)) throw new Error(`Not a local option: ${key}`);
if (!(config.maxEstimatedCostCents > 0 && config.maxEstimatedCostCents <= 10)) throw new Error("Expected capped cost <= 10 cents");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(join(output, "config.json"), JSON.stringify({ datasetSha256: hash(fs.readFileSync(datasetPath)), arms: config.arms, expectedHelperModel: config.expectedHelperModel, runtimeModelEvidence: config.runtimeModelEvidence, helperModelProof: config.helperModelProof, maxEstimatedCostCents: config.maxEstimatedCostCents }, null, 2), { flag: "wx" });
let estimatedCostCents = 0;
for (const arm of config.arms) {
 const rows = [];
 for (const test of dataset.cases.filter(test => !arm.caseIds || arm.caseIds.includes(test.id))) {
  const reference = test.retrieval ? test : dataset.cases.find(c => c.id === test.provenance.parents[0]);
  const target = config.targets.find(t => t.workspaceId === reference.retrieval.workspaceId);
  if (!target) throw new Error("No authorized target for case");
  const cookie = Object.entries(JSON.parse(fs.readFileSync(target.cookiePath))).map(([k,v]) => `${k}=${v}`).join("; ");
  const params = new URLSearchParams(reference.retrieval.flags);
  for (const [k,v] of Object.entries({ parentRetrieval: true, limit: 10, ...arm.overrides, q: test.question, workspaceId: target.workspaceId })) params.set(k,String(v));
  const url = new URL("/v1/search", config.base); url.search = params.toString();
  if (estimatedCostCents >= config.maxEstimatedCostCents) throw new Error("Cost bound reached");
  const started = Date.now();
  fs.writeFileSync(join(output, `${arm.id}-${test.id}-started.json`), JSON.stringify({ id: test.id, arm: arm.id, timestamp: new Date(started).toISOString(), request: { url: url.href }, status: "started", usage: "unknown until response or ledger reconciliation" }, null, 2), { flag: "wx" });
  const response = await fetch(url, { redirect: "error", headers: { Origin: config.base, Cookie: cookie }, signal: AbortSignal.timeout(60000) });
  const raw = await response.text();
  const record = { id: test.id, arm: arm.id, timestamp: new Date().toISOString(), request: { url: url.href }, status: response.status, ms: Date.now()-started, raw };
  fs.writeFileSync(join(output, `${arm.id}-${test.id}.json`), JSON.stringify(record,null,2), { flag:"wx" });
  if (!response.ok) throw new Error(`HTTP ${response.status}; trace preserved`);
  const body = JSON.parse(raw);
  if (!body.usage || !Number.isFinite(body.usage.costCents)) throw new Error("Missing usage; stop");
  estimatedCostCents += body.usage.costCents;
  rows.push({ id:test.id, score:score(test,body.results), ms:record.ms, sessionId:body.sessionId, usage:body.usage, responseSha256:hash(raw) });
  console.log(arm.id,test.id,rows.at(-1).score.correct ?? rows.at(-1).score.status);
 }
 fs.writeFileSync(join(output,arm.id+"-scores.json"),JSON.stringify(rows,null,2),{flag:"wx"});
}
fs.writeFileSync(join(output,"cost.json"),JSON.stringify({estimatedCostCents,billedLedgerReconciliation:"pending"}),{flag:"wx"});
