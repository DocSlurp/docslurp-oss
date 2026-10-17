#!/usr/bin/env node
// An explicit adapter owns service access. This runner never reads .env or chooses a provider.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, v, i, all) => i % 2 ? pairs : [...pairs, [v.replace(/^--/, ""), all[i + 1]]], []));
for (const name of ["dataset", "scenario", "adapter", "config", "output"]) if (!args[name]) throw new Error(`--${name} required`);
const [dataset, scenario, config] = await Promise.all([args.dataset, args.scenario, args.config].map(async p => JSON.parse(await readFile(p, "utf8"))));
if (scenario.datasetSha256 !== dataset.versionSha256) throw new Error("Dataset/scenario mismatch");
if (!config.index?.chunks || !config.pipeline) throw new Error("Actual index chunks and complete pipeline config required");
if (config.pipeline.mode === "hybrid" && (!config.pipeline.lexical || !config.pipeline.vector || !config.pipeline.fusion)) throw new Error("Hybrid needs lexical, vector, fusion configuration");
if (config.index.pages !== scenario.actualPages || config.index.documents !== scenario.documentCount) throw new Error("Indexed corpus counts do not match scenario");
const { retrieve } = await import(pathToFileURL(resolve(args.adapter)));
if (typeof retrieve !== "function") throw new Error("Adapter must export retrieve(query, config)");
const queries = scenario.queryIds.map(id => dataset.queries.find(q => q.id === id));
if (queries.some(q => !q)) throw new Error("Missing query labels");
const results = [];
// Sequential baseline makes latency interpretable and caps accidental provider concurrency.
for (const q of queries) {
  const start = performance.now();
  // Do not pass labels, expected answers, relevance pages, or answerability to the system.
  const result = await retrieve({ id: q.id, question: q.question, corpusDocuments: scenario.documents }, config);
  results.push({ ...result, queryId: q.id, latencyMs: performance.now() - start });
}
await writeFile(args.output, JSON.stringify({ datasetSha256: dataset.versionSha256, scenarioSha256: scenario.versionSha256, ...config, results }, null, 2) + "\n", { flag: "wx" });
