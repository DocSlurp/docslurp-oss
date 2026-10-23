import * as lancedb from "@lancedb/lancedb";
import { readFileSync } from "node:fs";
import { resolveLanceDbConfig } from "@docslurp/shared";
const OUT = process.argv[2]!;
const cfg = resolveLanceDbConfig();
const db = await lancedb.connect(`${cfg.root}/perforg/vectors/hash384/384`, cfg.storageOptions ? { storageOptions: cfg.storageOptions } : undefined);
const t = await db.openTable("chunks");
const qs: any[] = JSON.parse(readFileSync(`${OUT}/queries-dev.json`, "utf8")); const qv = JSON.parse(readFileSync(`${OUT}/query-vectors.json`, "utf8"));
const rows = await t.query().select(["documentId"]).limit(100000).toArray();
const docs = [...new Set(rows.map((r: any) => r.documentId))] as string[];
const filter = `"documentId" IN (${docs.map((d) => `'${d}'`).join(", ")})`;
const N = Number(process.argv[3] ?? 150);
const qq = qs.slice(0, N);
// scope A: whole workspace (all docs). scope B: 8 docs incl. the labelled one (low selectivity).
const scopeB = (q: any) => { const others = docs.filter((d) => d !== q.documentId).slice(Number(q.id.slice(1)) % 300, (Number(q.id.slice(1)) % 300) + 7); return [q.documentId, ...others]; };
const lit = (ds: string[]) => `"documentId" IN (${ds.map((d) => `'${d}'`).join(", ")})`;
const results: any[] = [];
for (const scope of ["all383", "docs8"]) for (const ef of [100, 200, 400, 800, 1500]) {
  const ms: number[] = []; let hit = 0, filled = 0;
  for (const q of qq) { const where = scope === "all383" ? filter : lit(scopeB(q));
    const s0 = performance.now(); const r = await t.vectorSearch(qv[q.id]).column("vector").where(where).limit(10).ef(ef).select(["id", "_distance"]).toArray(); ms.push(performance.now() - s0);
    if (r.some((x: any) => x.id === q.chunkId)) hit++; if (r.length >= 10) filled++; }
  ms.sort((a, b) => a - b);
  console.log(`${scope} ef=${String(ef).padEnd(5)} p50 ${ms[Math.floor(N / 2)]!.toFixed(1)} p95 ${ms[Math.floor(N * .95)]!.toFixed(1)} recall@10 ${(hit / N).toFixed(3)} filled10 ${(filled / N).toFixed(3)}`);
}
process.exit(0);
