// Benchmarks LanceDB search latency through the S3 proxy with the disk cache off, cold and warm.
// A delay shim in front of the endpoint adds a fixed per-request latency (no tc/netem needed) and counts requests.
//   LANCEDB_S3_TRACE_TEST_ENDPOINT=http://127.0.0.1:9000 BENCH_LATENCY_MS=40 pnpm exec tsx scripts/lancedb-s3-cache-bench.ts
// Optional: BENCH_ROWS, BENCH_DIM, BENCH_QUERIES, BENCH_BLOCK_KB, BENCH_BUCKET (existing bucket; BENCH_PREFIX is deleted afterwards).
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { connect } from "@lancedb/lancedb";
import { DiskBlockCache } from "@docslurp/shared/lancedb-s3-cache";
import { LanceS3Stats, startLanceS3Proxy } from "@docslurp/shared/lancedb-s3-trace";

const endpoint = process.env.LANCEDB_S3_TRACE_TEST_ENDPOINT ?? "http://127.0.0.1:9000";
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin" };
const region = process.env.AWS_REGION ?? "us-east-1";
const latencyMs = Number(process.env.BENCH_LATENCY_MS ?? 40);
const rowsN = Number(process.env.BENCH_ROWS ?? 100_000);
const dim = Number(process.env.BENCH_DIM ?? 128);
const queriesN = Number(process.env.BENCH_QUERIES ?? 100);
const blockBytes = Number(process.env.BENCH_BLOCK_KB ?? 1024) * 1024;
const ownBucket = !process.env.BENCH_BUCKET;
const bucket = process.env.BENCH_BUCKET ?? `lance-cache-bench-${Date.now()}`;
const prefix = process.env.BENCH_PREFIX ?? "s3burn-cache-bench";
const s3 = new S3Client({ endpoint, region, forcePathStyle: true, credentials });

// ---- delay + counting shim ---------------------------------------------------------------------------------------------
const up = new URL(endpoint);
const shimCounts = { GET: 0, HEAD: 0, PUT: 0, other: 0, bytes: 0 };
const shim = createServer((req, res) => {
  const m = req.method ?? "GET";
  if (m === "GET" && !/[?&](list-type|uploads|uploadId)/.test(req.url ?? "")) shimCounts.GET++; else if (m === "HEAD") shimCounts.HEAD++; else if (m === "PUT") shimCounts.PUT++; else shimCounts.other++;
  const forward = () => {
    const upstream = httpRequest({ hostname: up.hostname, port: up.port, method: m, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.on("data", (c: Buffer) => { shimCounts.bytes += c.length; });
      r.pipe(res);
    });
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  };
  req.pause();
  setTimeout(() => { forward(); req.resume(); }, latencyMs);
});
await new Promise<void>((resolve) => shim.listen(0, "127.0.0.1", resolve));
const shimEndpoint = `http://127.0.0.1:${(shim.address() as AddressInfo).port}`;
// The shim forwards the Host header it received, so the SigV4 signature made for the shim's address stays valid at the real endpoint.

// ---- dataset ----------------------------------------------------------------------------------------------------------
if (ownBucket) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
const vec = (id: number) => Array.from({ length: dim }, (_, d) => Math.sin((id + 1) * 0.37 * (d + 1)) + Math.cos(id * 0.011 * (d + 3)));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const root = `s3://${bucket}/${prefix}/${Date.now()}`;
const storage = (via: string) => ({ region, aws_access_key_id: credentials.accessKeyId, aws_secret_access_key: credentials.secretAccessKey, endpoint: via, allow_http: "true", virtual_hosted_style_request: "false" });

console.log(`dataset: ${rowsN} rows x dim ${dim}, ${queriesN} queries, shim latency ${latencyMs} ms/request, block ${blockBytes / 1024} KiB, bucket ${bucket}`);
const setup = await startLanceS3Proxy({ endpoint, region, credentials, logIntervalMs: 0, stats: new LanceS3Stats() });
{
  const db = await connect(root, { storageOptions: storage(setup.endpoint) });
  const batch = 20_000;
  let table;
  for (let start = 0; start < rowsN; start += batch) {
    const rows = Array.from({ length: Math.min(batch, rowsN - start) }, (_, i) => ({ id: start + i, text: `row ${start + i}`, vector: vec(start + i) }));
    table = start === 0 ? await db.createTable("docs", rows) : (await table!.add(rows), table!);
  }
  await table!.createIndex("vector", { config: (await import("@lancedb/lancedb")).Index.ivfPq({ numPartitions: 64, numSubVectors: Math.max(1, dim / 8) }) });
}
await setup.close();

// ---- measurement ------------------------------------------------------------------------------------------------------
type Mode = { label: string; cache?: DiskBlockCache };
const queryVecs = (seed: number) => Array.from({ length: queriesN }, (_, i) => vec(Math.floor(((seed + i * 7919) * 2654435761) % rowsN)));

async function pass(mode: Mode, scenario: "fresh-handle" | "steady", seed: number) {
  const stats = new LanceS3Stats();
  const proxy = await startLanceS3Proxy({ endpoint: shimEndpoint, region, credentials, logIntervalMs: 0, stats, cache: mode.cache });
  const before = { ...shimCounts };
  const lat: number[] = [];
  const open = async () => (await connect(root, { storageOptions: storage(proxy.endpoint) })).openTable("docs");
  let table = scenario === "steady" ? await open() : undefined;
  for (const q of queryVecs(seed)) {
    const t0 = performance.now();
    if (scenario === "fresh-handle") table = await open();
    const hits = await table!.search(q).limit(10).nprobes(8).select(["id", "text"]).toArray();
    lat.push(performance.now() - t0);
    if (hits.length !== 10) throw new Error("unexpected result size");
  }
  const counts = { GET: shimCounts.GET - before.GET, HEAD: shimCounts.HEAD - before.HEAD, other: shimCounts.other - before.other, MB: (shimCounts.bytes - before.bytes) / 1048576 };
  await proxy.close();
  return { lat, counts, proxyUpstream: stats.upstreamTotal };
}

const rowsOut: string[] = [];
const report = (scenario: string, label: string, r: Awaited<ReturnType<typeof pass>>) => {
  const total = r.counts.GET + r.counts.HEAD + r.counts.other;
  rowsOut.push(`| ${scenario} | ${label} | ${pct(r.lat, 0.5).toFixed(0)} | ${pct(r.lat, 0.95).toFixed(0)} | ${r.counts.GET} | ${r.counts.HEAD} | ${r.counts.other} | ${total} | ${r.counts.MB.toFixed(1)} |`);
  console.log(rowsOut[rowsOut.length - 1]);
};
const newCache = async () => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lance-bench-cache-"));
  return { dir, cache: new DiskBlockCache({ dir, maxBytes: 8 * 1024 ** 3, blockBytes, log: () => undefined }) };
};

console.log("| scenario | mode | p50 ms | p95 ms | upstream GET | HEAD | other | total requests | MB from origin |\n|---|---|---|---|---|---|---|---|---|");
for (const scenario of ["fresh-handle", "steady"] as const) {
  report(scenario, "cache off", await pass({ label: "off" }, scenario, 1));
  const { dir, cache } = await newCache();
  report(scenario, "cache cold (same queries)", await pass({ label: "cold", cache }, scenario, 1));
  report(scenario, "cache warm (same queries)", await pass({ label: "warm", cache }, scenario, 1));
  report(scenario, "cache warm (new queries)", await pass({ label: "warm2", cache }, scenario, 2));
  console.log(`  cache: ${(cache.sizeBytes / 1048576).toFixed(1)} MB on disk, ${cache.entries} files, hits=${cache.cumulative.hits} misses=${cache.cumulative.misses} fills=${cache.cumulative.fillRequests} evictions=${cache.cumulative.evictions}`);
  await rm(dir, { recursive: true, force: true });
}

// ---- cleanup ----------------------------------------------------------------------------------------------------------
for (let token: string | undefined; ;) {
  const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token }));
  const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
  if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
  token = page.NextContinuationToken;
  if (!token) break;
}
if (ownBucket) await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
shim.close(); shim.closeAllConnections();
