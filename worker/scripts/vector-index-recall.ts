/** Local-only, bounded reindex/recall comparison. Never reads customer text or
 * changes a live table. Run with --database PATH --table NAME --output PATH.
 * Queries are real held-out corpus vectors, not sampled vectors still indexed.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import * as lance from "@lancedb/lancedb";
import { lanceDbQueryTuning } from "@docslurp/shared/lancedb-query-tuning";
import { vectorIndexPartitions } from "../src/stages/lancedb-vector-index.js";

const { values } = parseArgs({ options: { database: { type: "string" }, table: { type: "string" }, output: { type: "string" }, tuned: { type: "boolean", default: false }, "query-offset": { type: "string", default: "0" }, probes: { type: "string" } } });
if (!values.database || !values.table || !values.output || /:\/\//.test(values.database) || /:\/\//.test(values.output)) throw new Error("Provide local --database, --table and --output paths");
if (![0, 0.5, 1].includes(Number(values["query-offset"])) || values.probes && (!Number.isSafeInteger(Number(values.probes)) || Number(values.probes) < 1 || Number(values.probes) > 4096)) throw new Error("Invalid query offset or probe budget");
const policies = { unfiltered: lanceDbQueryTuning(10, 0), filtered: lanceDbQueryTuning(10, 8), overrideProbes: values.probes ? Number(values.probes) : null };
const sourceDb = await lance.connect(resolve(values.database));
const source = await sourceDb.openTable(values.table);
const count = await source.countRows();
if (count < 128 || count > 100_000) throw new Error("Recall corpus must have 128..100000 rows");
const original = await source.query().select(["id", "documentId", "vector"]).limit(100_000).toArray();
const rows = original.map((row) => ({ id: String(row.id), documentId: String(row.documentId), vector: Array.from(row.vector as Iterable<number>) }));
const held = new Set(Array.from({ length: 64 }, (_, i) => Math.floor((i + Number(values["query-offset"]) * 0.5) * rows.length / 64)));
const queries = rows.filter((_, i) => held.has(i));
const training = rows.filter((_, i) => !held.has(i));
await mkdir(resolve(values.output), { recursive: true });
const db = await lance.connect(resolve(values.output, "indexes"));
const arms: Record<string, lance.Table> = {};
for (const [name, partitions] of [["legacy", Math.max(1, Math.ceil(training.length / 1_000_000))], ["partitioned", vectorIndexPartitions(training.length)]] as const) {
  const table = await db.createTable(name, training, { mode: "create" });
  const start = performance.now();
  await table.createIndex("vector", { config: lance.Index.hnswSq({ distanceType: "l2", numPartitions: partitions }) });
  arms[name] = table;
  console.log(JSON.stringify({ phase: "build", arm: name, rows: training.length, partitions, ms: Math.round(performance.now() - start) }));
}
const docs = [...new Set(training.map((r) => r.documentId))];
const results: Array<Record<string, unknown>> = [];
for (let i = 0; i < queries.length; i++) {
  const query = queries[i]!;
  const docSet = new Set([query.documentId, ...Array.from({ length: 7 }, (_, j) => docs[(i * 17 + j) % docs.length]!) ]);
  const filter = `"documentId" IN (${[...docSet].map((d) => `'${d.replaceAll("'", "''")}'`).join(",")})`;
  for (const [scope, where] of [["all", undefined], ["documents", filter]] as const) {
    const search = (table: lance.Table, exact: boolean, tuned = false) => {
      let q = table.vectorSearch(query.vector).distanceType("l2").column("vector").limit(10).select(["id", "documentId", "_distance"]);
      if (where) q = q.where(where).ef(Math.ceil(Math.min(Math.max(100, docSet.size * 10), 1_000) * 1.5));
      if (tuned) {
        const policy = lanceDbQueryTuning(10, where ? docSet.size : 0);
        q = q.ef(policy.ef).refineFactor(policy.refineFactor).nprobes(!where && values.probes ? Number(values.probes) : policy.nprobes);
      }
      if (exact) q = q.bypassVectorIndex();
      return q.toArray();
    };
    const exact = await search(arms.legacy!, true);
    if (!exact.length) throw new Error("Empty exact query cannot establish recall");
    const ids = new Set(exact.map((r) => r.id));
    for (const [arm, table] of Object.entries(arms)) {
      const start = performance.now();
      const got = await search(table, false, values.tuned && arm === "partitioned");
      if (got.length !== exact.length || where && got.some((r) => !docSet.has(String(r.documentId)))) throw new Error("Result count or tenant/document scope mismatch");
      results.push({ query: i, phase: i < 32 ? "screen" : "confirm", arm, scope, ms: performance.now() - start,
        recall10: got.filter((r) => ids.has(r.id)).length / exact.length });
    }
  }
}
const summaries = [];
for (const phase of ["screen", "confirm"]) for (const scope of ["all", "documents"]) for (const arm of Object.keys(arms)) {
  const slice = results.filter((r) => r.phase === phase && r.scope === scope && r.arm === arm);
  const times = slice.map((r) => Number(r.ms)).sort((a,b) => a-b);
  summaries.push({ phase, scope, arm, queries: slice.length, recall10: slice.reduce((s,r) => s + Number(r.recall10),0)/slice.length,
    p50Ms: times[Math.floor(times.length/2)], p95Ms: times[Math.ceil(times.length*.95)-1] });
}
await writeFile(resolve(values.output, "recall.json"), JSON.stringify({ policies, rows: training.length, dimension: training[0]!.vector.length, partitions: vectorIndexPartitions(training.length), results, summaries }, null, 2));
const gates = ["screen", "confirm"].flatMap((phase) => ["all", "documents"].map((scope) => {
  const baseline = summaries.find((r) => r.phase === phase && r.scope === scope && r.arm === "legacy")!;
  const candidate = summaries.find((r) => r.phase === phase && r.scope === scope && r.arm === "partitioned")!;
  return { phase, scope, passed: candidate.recall10 >= 0.95 && candidate.recall10 >= baseline.recall10 - 0.01 };
}));
await writeFile(resolve(values.output, "gates.json"), JSON.stringify({ gates, passed: gates.every((g) => g.passed), tuned: values.tuned, policies }, null, 2));
console.log(JSON.stringify({ phase: "recall", summaries, gates }));
if (!gates.every((g) => g.passed)) process.exitCode = 1;
for (const t of Object.values(arms)) t.close();
source.close();sourceDb.close();db.close();
