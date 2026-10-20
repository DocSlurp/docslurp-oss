// Measures LanceDB search latency on S3-compatible storage with and without Session sizing,
// index/data prewarm and different read-consistency intervals. Every measurement runs in a fresh
// child process, so Lance's caches start empty, and drives the real lanceDbVectorSearch().
//
//   docker run -d --rm --name lance-bench-minio -p 127.0.0.1:9120:9000 \
//     -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin cgr.dev/chainguard/minio:latest server /data
//   cd server
//   BENCH_ENDPOINT=http://127.0.0.1:9120 BENCH_ROWS=50000 BENCH_DIM=1536 pnpm exec tsx scripts/lancedb-session-bench.ts seed
//   BENCH_ENDPOINT=http://127.0.0.1:9120 BENCH_DELAY_MS=0,40 pnpm exec tsx scripts/lancedb-session-bench.ts matrix
//
// Requests pass through an in-process counting proxy; BENCH_DELAY_MS adds that much latency to every
// request to imitate a remote object store (MinIO on loopback answers in about a millisecond).
// The proxy forwards headers unchanged, so SigV4 signatures made for the proxy host verify upstream.
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const endpoint = process.env.BENCH_ENDPOINT ?? "http://127.0.0.1:9120";
const bucket = process.env.BENCH_BUCKET ?? "lance-session-bench";
const orgId = "benchorg";
const model = "bench-embedding";
const credentials = { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" };
const dim = Number(process.env.BENCH_DIM ?? 1536);
const rows = Number(process.env.BENCH_ROWS ?? 50_000);
const lanceUri = (via: string) => `s3://${bucket}/lancedb?endpoint=${encodeURIComponent(via)}&region=us-east-1&allowHttp=true`;
const percentile = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? NaN;
const randomVector = () => Array.from({ length: dim }, () => Math.random() * 2 - 1);

function applyEnv(via: string) {
  Object.assign(process.env, { AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey, AWS_REGION: "us-east-1", LANCEDB_URI: lanceUri(via) });
}

async function locate() {
  const { VectorNamespaceManager, resolveLanceDbConfig } = await import("@docslurp/shared");
  const location = VectorNamespaceManager.getEmbeddingLocation(resolveLanceDbConfig().root, orgId, model, dim);
  return { ...location, shared: await import("@docslurp/shared") };
}

async function seed() {
  const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials });
  await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((error: { name?: string }) => { if (!/BucketAlready/.test(error.name ?? "")) throw error; });
  applyEnv(endpoint);
  const lancedb = await import("@lancedb/lancedb");
  const { uri, table: name } = await locate();
  const { resolveLanceDbConfig } = await import("@docslurp/shared");
  const db = await lancedb.connect(uri, { storageOptions: resolveLanceDbConfig().storageOptions });
  const batch = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({
    id: `chunk-${start + i}`, documentId: `doc-${Math.floor((start + i) / 100)}`, chunkIndex: (start + i) % 100, vector: randomVector(),
  }));
  const t0 = performance.now();
  const table = await db.createTable(name, batch(0, 5_000), { mode: "overwrite" });
  for (let start = 5_000; start < rows; start += 5_000) await table.add(batch(start, Math.min(5_000, rows - start)));
  console.log(`seeded rows=${rows} dim=${dim} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const t1 = performance.now();
  // Same index the worker builds (lancedb-maintenance.ts: vectorIndexConfig + id btree).
  await table.createIndex("vector", { config: lancedb.Index.hnswSq({ distanceType: "l2", numPartitions: Math.max(1, Math.ceil(rows / 1_000_000)) }), replace: true });
  await table.createIndex("id", { config: lancedb.Index.btree(), replace: true });
  await table.optimize();
  console.log(`indexed in ${((performance.now() - t1) / 1000).toFixed(1)}s indices=${JSON.stringify((await table.listIndices()).map((i) => [i.name, i.indexType, i.numSegments]))}`);
}

/** Forwards requests unchanged to the real endpoint after an artificial delay, counting them by object class. */
async function startProxy(delayMs: number) {
  const target = new URL(endpoint);
  const counts: Record<string, number> = {};
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const cls = req.method === "GET" || req.method === "HEAD" ? (/_versions\//.test(path) ? "versions" : /_latest/.test(path) ? "latest" : /\/_indices\//.test(path) ? "index" : /\/data\//.test(path) ? "data" : /_transactions\//.test(path) ? "txn" : req.method === "GET" && !path.split("/").slice(2).join("/") ? "list" : "other") : "write";
    counts[cls] = (counts[cls] ?? 0) + 1;
    counts.total = (counts.total ?? 0) + 1;
    if (delayMs > 0) await sleep(delayMs);
    const upstream = httpRequest({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, counts, close: () => server.close() };
}

async function query() {
  const delayMs = Number(process.env.BENCH_DELAY_MS ?? 0);
  const total = Number(process.env.BENCH_QUERIES ?? 300);
  const pauseMs = Number(process.env.BENCH_PAUSE_MS ?? 100);
  const proxy = await startProxy(delayMs);
  applyEnv(proxy.url);
  const { lanceDbVectorSearch, lanceDbSessionStats } = await import("../src/search/lancedb.js");
  let appended = 0;
  let ingest: NodeJS.Timeout | undefined;
  let appendTable: import("@lancedb/lancedb").Table | undefined;
  if (process.env.BENCH_INGEST === "1") {
    // A second connection straight to the store appends small batches like the worker's writer, with no Lance cache shared with the reader.
    const lancedb = await import("@lancedb/lancedb");
    const { uri, table: name, shared } = await locate();
    const direct = { ...shared.resolveLanceDbConfig().storageOptions, endpoint };
    appendTable = await (await lancedb.connect(uri, { storageOptions: direct })).openTable(name);
    ingest = setInterval(() => {
      const start = 10_000_000 + appended;
      appended += 40;
      void appendTable!.add(Array.from({ length: 40 }, (_, i) => ({ id: `ingest-${start + i}`, documentId: "ingest-doc", chunkIndex: i, vector: randomVector() }))).catch(() => undefined);
    }, 3_000);
  }
  const latencies: number[] = [];
  for (let i = 0; i < total; i++) {
    // One in three queries is scoped to a few documents, as workspace-scoped chat is.
    const documentIds = i % 3 === 2 ? Array.from({ length: 5 }, (_, k) => `doc-${(i * 7 + k * 13) % Math.max(1, Math.floor(rows / 100))}`) : undefined;
    const started = performance.now();
    await lanceDbVectorSearch({ orgId, embeddingModel: model, queryVector: randomVector(), documentIds, limit: 20 });
    latencies.push(performance.now() - started);
    if (pauseMs > 0) await sleep(pauseMs);
  }
  if (ingest) clearInterval(ingest);
  await sleep(200);
  const early = latencies.slice(1, 11);
  const steady = latencies.slice(40);
  const stats = lanceDbSessionStats();
  if (appendTable) await appendTable.delete(`"documentId" = 'ingest-doc'`).catch(() => undefined);
  console.log(JSON.stringify({
    firstMs: Math.round(latencies[0]!), earlyP50: Math.round(percentile(early, 0.5)), steadyP50: Math.round(percentile(steady, 0.5)),
    steadyP95: Math.round(percentile(steady, 0.95)), maxMs: Math.round(Math.max(...steady)), requests: proxy.counts,
    cachedMb: stats ? Math.round(stats.sizeBytes / 1048576) : null, appended,
  }));
  proxy.close();
  process.exit(0);
}

interface Variant { name: string; env: Record<string, string>; ingest?: boolean }
const LANCE_DEFAULTS = { LANCEDB_INDEX_CACHE_MB: "6144", LANCEDB_METADATA_CACHE_MB: "1024", LANCEDB_PREWARM_INDEX: "false" };
const variants: Variant[] = [
  { name: "A baseline (no Session, no prewarm, rc=10)", env: { ...LANCE_DEFAULTS } },
  { name: "B sized Session, no prewarm", env: { LANCEDB_PREWARM_INDEX: "false" } },
  { name: "C prewarm index (background)", env: {} },
  { name: "D prewarm index (blocking)", env: { LANCEDB_PREWARM_BLOCKING: "true" } },
  { name: "E prewarm index+data (blocking)", env: { LANCEDB_PREWARM_BLOCKING: "true", LANCEDB_PREWARM_DATA: "true" } },
  { name: "H tiny index cache (1 MB), no prewarm", env: { LANCEDB_INDEX_CACHE_MB: "1", LANCEDB_PREWARM_INDEX: "false" } },
  { name: "F baseline, rc=60", env: { ...LANCE_DEFAULTS, LANCEDB_READ_CONSISTENCY_SECONDS: "60" } },
  { name: "G prewarm (blocking), rc=60", env: { LANCEDB_PREWARM_BLOCKING: "true", LANCEDB_READ_CONSISTENCY_SECONDS: "60" } },
  { name: "A' baseline + ingest, rc=10", env: { ...LANCE_DEFAULTS }, ingest: true },
  { name: "D' prewarm (blocking) + ingest, rc=10", env: { LANCEDB_PREWARM_BLOCKING: "true" }, ingest: true },
  { name: "A'' baseline + ingest, rc=60", env: { ...LANCE_DEFAULTS, LANCEDB_READ_CONSISTENCY_SECONDS: "60" }, ingest: true },
  { name: "D'' prewarm (blocking) + ingest, rc=60", env: { LANCEDB_PREWARM_BLOCKING: "true", LANCEDB_READ_CONSISTENCY_SECONDS: "60" }, ingest: true },
];

function matrix() {
  const delays = (process.env.BENCH_DELAY_MS ?? "0,40").split(",");
  const reps = Number(process.env.BENCH_REPS ?? 3);
  const only = process.env.BENCH_ONLY;
  console.log(`| delay | variant | first (ms) | queries 2-11 p50 | steady p50 | steady p95 | steady max | reads/search (data / index / version) | cached MB |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const delay of delays) {
    for (const variant of variants) {
      if (only && !new RegExp(only).test(variant.name)) continue;
      const runs: Array<Record<string, any>> = [];
      for (let rep = 0; rep < reps; rep++) {
        const out = execFileSync(process.execPath, ["--import", "tsx", import.meta.filename, "query"], {
          env: { ...process.env, ...variant.env, BENCH_DELAY_MS: delay, ...(variant.ingest ? { BENCH_INGEST: "1" } : {}) }, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
        });
        runs.push(JSON.parse(out.trim().split("\n").pop()!));
      }
      const med = (key: string) => percentile(runs.map((r) => r[key]), 0.5);
      const queries = Number(process.env.BENCH_QUERIES ?? 300);
      const per = (cls: string[]) => (percentile(runs.map((r) => cls.reduce((sum, c) => sum + (r.requests[c] ?? 0), 0)), 0.5) / queries).toFixed(2);
      const gets = `${per(["data"])} / ${per(["index"])} / ${per(["list", "versions", "latest"])}`;
      console.log(`| ${delay} ms | ${variant.name} | ${med("firstMs")} | ${med("earlyP50")} | ${med("steadyP50")} | ${med("steadyP95")} | ${med("maxMs")} | ${gets} | ${med("cachedMb")} |`);
    }
  }
}

const mode = process.argv[2];
if (mode === "seed") await seed();
else if (mode === "query") await query();
else if (mode === "matrix") matrix();
else { console.error("usage: lancedb-session-bench.ts seed|query|matrix"); process.exit(2); }
