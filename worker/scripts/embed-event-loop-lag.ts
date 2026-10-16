/**
 * Event-loop lag while the real local embedding model runs (bge-m3 via transformers.js).
 *
 *   nice -n 10 pnpm --filter @docslurp/worker exec tsx scripts/embed-event-loop-lag.ts \
 *     [--docs 4] [--chunks 12] [--batch 4]
 *
 * Embeds `--docs` documents of `--chunks` short passages concurrently through the production
 * path (`embedTextChunks`, as docConcurrency does) and samples the main thread's event loop
 * (10 ms timer drift) while it runs. Re-run with DOCSLURP_LOCAL_EMBED_THREAD=off for the old
 * in-process behaviour, and with DOCSLURP_LOCAL_EMBED_THREADS=N to size the pool:
 *
 *   DOCSLURP_LOCAL_EMBED_THREAD=off pnpm --filter @docslurp/worker exec tsx scripts/embed-event-loop-lag.ts
 *
 * The model must already be cached under ~/.cache/docslurp/transformers (a first run
 * downloads it). Keep --docs x --chunks small: the machine is shared.
 */
import { performance } from "node:perf_hooks";

import { fromEnv } from "../src/config.js";
import { embedTextChunks, warmLocalEmbedding } from "../src/stages/embedding-runtime.js";
import { closeSharedLocalEmbeddingPool, localEmbeddingIntraOpThreads, localEmbeddingPoolSize } from "../src/stages/local-embedding-thread.js";
import type { EmbeddingProfile } from "../src/models.js";

function numberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const docs = numberFlag("docs", 4);
const chunksPerDoc = numberFlag("chunks", 12);
const batchSize = numberFlag("batch", 4);
const threaded = !["off", "false", "0", "no"].includes((process.env.DOCSLURP_LOCAL_EMBED_THREAD ?? "on").toLowerCase());

const profile: EmbeddingProfile = {
  profile: "good-fast-local",
  target: "local",
  modelUri: "llm://transformers.js/Xenova/bge-m3",
  runtime: "local",
  provider: "transformers.js",
  model: "Xenova/bge-m3",
  baseUrl: null,
  dimensions: 1024,
  task: "document",
  normalize: true,
  batchSize,
  lateChunking: false,
  lateChunkingWindow: 2,
};

const passage = (doc: number, n: number) =>
  `Document ${doc}, passage ${n}: the quarterly report compares throughput, cost per page and retrieval latency across ingestion workers, with notes on queueing, batching and memory use.`;

const warmStartedAt = performance.now();
await warmLocalEmbedding(profile.model);
console.log(`model warm ms=${Math.round(performance.now() - warmStartedAt)}`);

const lags: number[] = [];
let last = performance.now();
const timer = setInterval(() => {
  const now = performance.now();
  lags.push(Math.max(0, now - last - 10));
  last = now;
}, 10);

const startedAt = performance.now();
const peakRss = { value: process.memoryUsage().rss };
const rssTimer = setInterval(() => { peakRss.value = Math.max(peakRss.value, process.memoryUsage().rss); }, 250);
const cpuStart = process.cpuUsage();
await Promise.all(
  Array.from({ length: docs }, async (_, doc) => {
    const result = await embedTextChunks({
      chunks: Array.from({ length: chunksPerDoc }, (_, n) => passage(doc, n)),
      profile,
      config: fromEnv(),
      privacyMode: "standard",
    });
    if (result.vectors.length !== chunksPerDoc) throw new Error("unexpected vector count");
  }),
);
const elapsedMs = performance.now() - startedAt;
// A loop blocked until the very end never ran the timer; count that final gap.
lags.push(Math.max(0, performance.now() - last - 10));
clearInterval(timer);
clearInterval(rssTimer);
const cpu = process.cpuUsage(cpuStart);

const sorted = [...lags].sort((a, b) => a - b);
const pct = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0);
const poolSize = localEmbeddingPoolSize();
console.log(JSON.stringify({
  mode: threaded ? `pool x${poolSize} (intra-op ${localEmbeddingIntraOpThreads(poolSize)})` : "in-process",
  docs, chunksPerDoc, batchSize,
  elapsedMs: Math.round(elapsedMs),
  lagMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: Math.round(sorted.at(-1) ?? 0) },
  processCpuMs: Math.round((cpu.user + cpu.system) / 1000),
  peakRssMb: Math.round(peakRss.value / 1024 / 1024),
}));
await closeSharedLocalEmbeddingPool();
