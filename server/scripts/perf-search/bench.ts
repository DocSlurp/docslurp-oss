/**
 * Search latency/quality bench: tsx bench.ts <queries.json> <queryVectors.json> <label> <outDir> [n] [concurrency]
 * One process = one config (env). Phase 1 cold (first query after process start), then warm pass.
 * Records per-query totalMs + timings + result chunk ids.
 */
import { readFileSync, writeFileSync } from "node:fs";
const [qfile, vfile, label, outDir, nArg, concArg] = process.argv.slice(2);
const queries: any[] = JSON.parse(readFileSync(qfile!, "utf8"));
const vectors: Record<string, number[]> = JSON.parse(readFileSync(vfile!, "utf8"));
const N = Math.min(Number(nArg ?? 150), queries.length);
const conc = Number(concArg ?? 1);
const search = await import("../../src/services/search.js");
const session = await import("../../src/search/session.js");
const useVec = process.env.BENCH_QUERY_VECTOR !== "0";
const one = async (q: any) => {
  const t = performance.now();
  const r = await search.hybridSearch(q.q, "perfu", { limit: 10, ...(useVec ? { queryVector: vectors[q.id] } : {}), filters: { workspaceId: "perfw" } } as any);
  return { id: q.id, wall: performance.now() - t, timings: r.timings, ids: r.results.map((x: any) => `${x.citation.documentId}-${x.citation.chunkIndex}`), docs: r.results.map((x: any) => x.citation.documentId) };
};
const out: any = { label, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(LANCEDB|SEARCH|BENCH)/.test(k))), n: N, conc, cold: null as any, runs: [] as any[] };
out.cold = await one(queries[0]);
const rest = queries.slice(1, N);
const t0 = performance.now();
let i = 0;
await Promise.all(Array.from({ length: conc }, async () => { for (;;) { const q = rest[i++]; if (!q) return; out.runs.push(await one(q)); } }));
out.elapsedMs = performance.now() - t0;
await session.drainSearchSessionWrites();
const byId = new Map(queries.map((q) => [q.id, q]));
const ranks = out.runs.map((r: any) => { const q = byId.get(r.id); const k = r.ids.indexOf(q.chunkId); const dk = r.docs.indexOf(q.documentId); return { k, dk }; });
const rec = (f: (r: any) => number, K: number) => ranks.filter((r: any) => f(r) >= 0 && f(r) < K).length / ranks.length;
out.quality = { chunkRecall10: rec((r) => r.k, 10), chunkRecall5: rec((r) => r.k, 5), chunkMRR10: ranks.reduce((s: number, r: any) => s + (r.k >= 0 ? 1 / (r.k + 1) : 0), 0) / ranks.length, docRecall10: rec((r) => r.dk, 10),
  ndcg10: ranks.reduce((s: number, r: any) => s + (r.k >= 0 ? 1 / Math.log2(r.k + 2) : 0), 0) / ranks.length };
const walls = out.runs.map((r: any) => r.wall).sort((a: number, b: number) => a - b);
const pct = (p: number) => walls[Math.min(walls.length - 1, Math.floor(p * walls.length))];
out.latency = { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), mean: walls.reduce((a: number, b: number) => a + b, 0) / walls.length, coldMs: out.cold.wall };
const phases: Record<string, number[]> = {};
for (const r of out.runs) for (const [k, v] of Object.entries(r.timings ?? {})) (phases[k] ??= []).push(v as number);
out.phaseP50 = Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, v.sort((a, b) => a - b)[Math.floor(v.length / 2)]]));
writeFileSync(`${outDir}/run-${label}.json`, JSON.stringify(out));
console.log(label, JSON.stringify(out.latency), JSON.stringify(out.quality), JSON.stringify(out.phaseP50));
process.exit(0);
