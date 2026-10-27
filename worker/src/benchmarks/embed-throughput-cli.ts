/**
 * Local embedding throughput microbenchmark (no network, no database).
 *
 * Reads chunk texts from a JSON array file and embeds them through the same
 * LocalEmbeddingPool the worker uses, varying only batching and threading, so a
 * strategy change can be compared on chunks/min and on vector agreement
 * (cosine) against a reference run of the same texts.
 *
 *   tsx embed-throughput-cli.ts --texts chunks.json --out run.json [--ref ref.json]
 *     [--batch 32] [--sort none|length] [--pool 1] [--intra 8] [--dtype q8] [--limit 400] [--concurrency 1]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LocalEmbeddingPool } from "../stages/local-embedding-thread.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const texts: string[] = JSON.parse(readFileSync(arg("texts")!, "utf8")).slice(0, Number(arg("limit", "100000")));
const batch = Number(arg("batch", "32"));
const sort = arg("sort", "none");
const poolSize = Number(arg("pool", "1"));
const intra = Number(arg("intra", "8"));
const dtype = arg("dtype", "q8")!;
const concurrency = Number(arg("concurrency", String(poolSize)));
const model = "Xenova/bge-m3";
const cacheDir = join(homedir(), ".cache", "docslurp", "transformers");

const order = texts.map((_, i) => i);
if (sort === "length") order.sort((a, b) => texts[a].length - texts[b].length);
const batches: number[][] = [];
for (let i = 0; i < order.length; i += batch) batches.push(order.slice(i, i + batch));

const pool = new LocalEmbeddingPool({ size: poolSize, intraOpThreads: intra });
await pool.preload({ model, dtypes: [dtype], cacheDir, normalize: true });
const vectors: number[][] = new Array(texts.length);
let runMs = 0;
let next = 0;
const startedAt = Date.now();
const cpuStart = process.cpuUsage();
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < batches.length) {
      const ids = batches[next++];
      const r = await pool.embed({ model, dtypes: [dtype], cacheDir, texts: ids.map((i) => texts[i]), normalize: true });
      runMs += r.runMs;
      const dim = r.dims[1];
      ids.forEach((id, k) => (vectors[id] = Array.from(r.data.subarray(k * dim, (k + 1) * dim))));
    }
  }),
);
const wallMs = Date.now() - startedAt;
const cpu = process.cpuUsage(cpuStart);
const cpuMs = Math.round((cpu.user + cpu.system) / 1000);
await pool.close();

let minCos: number | null = null;
let meanCos: number | null = null;
const refPath = arg("ref");
if (refPath) {
  const ref: number[][] = JSON.parse(readFileSync(refPath, "utf8")).vectors;
  const cos = vectors.map((v, i) => v.reduce((s, x, d) => s + x * ref[i][d], 0));
  minCos = Math.min(...cos);
  meanCos = cos.reduce((s, x) => s + x, 0) / cos.length;
}
const chars = texts.reduce((s, t) => s + t.length, 0);
const summary = { batch, sort, poolSize, intra, dtype, concurrency, chunks: texts.length, chars, wallMs, cpuMs, cpuMsPerChunk: Math.round(cpuMs / texts.length), runMs, chunksPerMin: +((texts.length / wallMs) * 60000).toFixed(1), minCos, meanCos };
console.log(JSON.stringify(summary));
if (arg("out")) writeFileSync(arg("out")!, JSON.stringify({ summary, vectors: arg("keep") ? vectors : undefined }));
