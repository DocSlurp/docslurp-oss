/**
 * Recall of the scope-bench table (run scope-bench.ts first, same env): IN-list prefilter vs
 * no filter, both at the scoped ef, against an exact flat scan; BM25 compared by score.
 */
import * as lancedb from "@lancedb/lancedb";
import { VectorNamespaceManager, resolveLanceDbConfig } from "@docslurp/shared";
const DOCS = Number(process.env.DOCS ?? 10_000), DIM = Number(process.env.DIM ?? 768), N = Number(process.env.QUERIES ?? 40);
const location = VectorNamespaceManager.getEmbeddingLocation(resolveLanceDbConfig().root, "bench-org", "bench-project", "bench/embed", DIM);
const table = await (await lancedb.connect(location.uri)).openTable(location.table);
const ids = Array.from({ length: DOCS }, (_, i) => `'bench-doc-${i}'`).join(", ");
let seed = 99; const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const WORDS = ["pump", "valve", "seal", "torque", "bearing", "gasket", "filter", "impeller", "coupling", "flange", "rotor", "shaft", "earnings", "expansion", "harbor", "orbit"];
let inHit = 0, outHit = 0, ftsSame = 0;
for (let q = 0; q < N; q += 1) {
  const v = Array.from({ length: DIM }, () => rand() - 0.5);
  const truth = new Set((await table.vectorSearch(v).column("vector").bypassVectorIndex().limit(20).select(["id", "_distance"]).toArray()).map((r: any) => r.id));
  const viaIn = await table.vectorSearch(v).column("vector").where(`"documentId" IN (${ids})`).ef(1500).limit(20).select(["id", "_distance"]).toArray();
  const viaNone = await table.vectorSearch(v).column("vector").ef(1500).limit(40).select(["id", "_distance"]).toArray();
  inHit += viaIn.filter((r: any) => truth.has(r.id)).length;
  outHit += viaNone.slice(0, 20).filter((r: any) => truth.has(r.id)).length;
  const term = `${WORDS[q % 16]} ${WORDS[(q * 7 + 3) % 16]}`;
  const a = (await table.query().fullTextSearch(term, { columns: "text" }).where(`"documentId" IN (${ids})`).limit(20).select(["id", "_score"]).toArray()).map((r: any) => r._score.toFixed(4));
  const b = (await table.query().fullTextSearch(term, { columns: "text" }).limit(40).select(["id", "_score"]).toArray()).slice(0, 20).map((r: any) => r._score.toFixed(4));
  if (JSON.stringify(a) === JSON.stringify(b)) ftsSame += 1;
}
console.log(`vector recall@20 vs exact: IN-list ${(inHit / N / 20 * 100).toFixed(1)}%, no filter ${(outHit / N / 20 * 100).toFixed(1)}%`);
console.log(`BM25 top-20 score lists identical: ${ftsSame}/${N}`);
process.exit(0);
