import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { connect } from "@lancedb/lancedb";
import { DiskBlockCache } from "@docslurp/shared/lancedb-s3-cache";
import { LanceS3Stats, startLanceS3Proxy, type LanceS3Proxy } from "@docslurp/shared/lancedb-s3-trace";
import { afterAll, beforeAll, expect, it } from "vitest";

// Needs MinIO (`pnpm db:up`); skipped when unreachable. Override with LANCEDB_S3_TRACE_TEST_ENDPOINT.
const endpoint = process.env.LANCEDB_S3_TRACE_TEST_ENDPOINT ?? "http://127.0.0.1:9000";
const credentials = { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "minioadmin", secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "minioadmin" };
const reachable = await fetch(`${endpoint}/minio/health/live`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

const bucket = `lance-cache-${Date.now()}`;
const BLOCK = 4096;
const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials });
const body = randomBytes(100_000);
const DATA_KEY = "tbl.lance/data/f1.lance";
const MANIFEST_KEY = "tbl.lance/_versions/1.manifest";
let dirs: string[] = [];
const proxies: LanceS3Proxy[] = [];

async function startProxy(maxBytes = 50 * 1024 * 1024) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "lance-cache-it-"));
  dirs.push(dir);
  const cache = new DiskBlockCache({ dir, maxBytes, blockBytes: BLOCK, log: () => undefined });
  const proxy = await startLanceS3Proxy({ endpoint, region: "us-east-1", credentials, logIntervalMs: 0, cache, stats: new LanceS3Stats() });
  proxies.push(proxy);
  return { proxy, cache };
}
const getRange = async (proxy: LanceS3Proxy, key: string, range?: string) => {
  const res = await fetch(`${proxy.endpoint}/${bucket}/${key}`, { headers: range ? { range } : {} });
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};

beforeAll(async () => {
  if (!reachable) return;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: DATA_KEY, Body: body }));
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY, Body: "v1" }));
});
afterAll(async () => { await Promise.all(proxies.map((p) => p.close())); await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

it.skipIf(!reachable)("returns correct bytes and headers for overlapping ranges, caching only immutable paths", async () => {
  const { proxy, cache } = await startProxy();
  const ranges: Array<[number, number]> = [[0, 99], [50, 5000], [4000, 4100], [4096, 8191], [99_000, 99_999], [90_000, 200_000]];
  for (const [start, end] of ranges) {
    const { res, bytes } = await getRange(proxy, DATA_KEY, `bytes=${start}-${end}`);
    const last = Math.min(end, body.length - 1);
    expect(res.status).toBe(206);
    expect(bytes.equals(body.subarray(start, last + 1)), `${start}-${end}`).toBe(true);
    expect(res.headers.get("content-range")).toBe(`bytes ${start}-${last}/${body.length}`);
    expect(Number(res.headers.get("content-length"))).toBe(last - start + 1);
    expect(res.headers.get("etag")).toBeTruthy();
  }
  const filled = cache.cumulative.fillRequests;
  // Everything above is now cached: overlapping and repeated ranges cost no upstream requests.
  for (const [start, end] of [[10, 20], [4090, 4100], [91_000, 91_001], [95_000, 99_999]]) {
    const { res, bytes } = await getRange(proxy, DATA_KEY, `bytes=${start}-${end}`);
    expect(res.headers.get("x-docslurp-cache")).toBe("hit");
    expect(bytes.equals(body.subarray(start, end + 1))).toBe(true);
  }
  expect((await getRange(proxy, DATA_KEY, "bytes=-10")).bytes.equals(body.subarray(body.length - 10))).toBe(true);
  const whole = await getRange(proxy, DATA_KEY);
  expect(whole.res.status).toBe(200);
  expect(whole.bytes.equals(body)).toBe(true);
  expect(cache.cumulative.fillRequests).toBeGreaterThan(filled); // the whole-object read fetched the gaps once
  const settled = cache.cumulative.fillRequests;
  expect((await getRange(proxy, DATA_KEY)).res.headers.get("x-docslurp-cache")).toBe("hit");
  expect(cache.cumulative.fillRequests).toBe(settled);
  const head = await fetch(`${proxy.endpoint}/${bucket}/${DATA_KEY}`, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe(String(body.length));

  // Mutable paths are never cached: an overwrite is visible immediately.
  const entries = cache.entries;
  expect((await getRange(proxy, MANIFEST_KEY, "bytes=0-1")).bytes.toString()).toBe("v1");
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: MANIFEST_KEY, Body: "v2" }));
  expect((await getRange(proxy, MANIFEST_KEY, "bytes=0-1")).bytes.toString()).toBe("v2");
  expect(cache.entries).toBe(entries);
  // Origin errors pass through unchanged and uncached.
  const missing = await getRange(proxy, "tbl.lance/data/nope.lance", "bytes=0-9");
  expect(missing.res.status).toBe(404);
  expect(cache.entries).toBe(entries);
  // A write through the proxy drops the stale copy.
  const put = await fetch(`${proxy.endpoint}/${bucket}/${DATA_KEY}`, { method: "PUT", body });
  expect(put.status).toBe(200);
  expect(cache.entries).toBeLessThan(entries);
});

it.skipIf(!reachable)("stays within the size limit under eviction and still returns correct bytes", async () => {
  const limit = BLOCK * 8 + 1024;
  const { proxy, cache } = await startProxy(limit);
  for (let round = 0; round < 3; round++) {
    for (let start = 0; start < body.length; start += 7000) {
      const end = Math.min(body.length - 1, start + 6999);
      const { bytes } = await getRange(proxy, DATA_KEY, `bytes=${start}-${end}`);
      expect(bytes.equals(body.subarray(start, end + 1)), `${start}`).toBe(true);
      expect(cache.sizeBytes).toBeLessThanOrEqual(limit);
    }
  }
  expect(cache.cumulative.evictions).toBeGreaterThan(0);
  expect(proxy.stats.summaryLine(60)).toMatch(/cache_hits=\d+ cache_misses=\d+ .*cache_evictions=[1-9]/);
});

it.skipIf(!reachable)("a real Lance table queried through the cache returns the same results as uncached, then serves from disk", async () => {
  const lanceBucket = `lance-cache-tbl-${Date.now()}`;
  await s3.send(new CreateBucketCommand({ Bucket: lanceBucket }));
  const direct = await startLanceS3Proxy({ endpoint, region: "us-east-1", credentials, logIntervalMs: 0, stats: new LanceS3Stats() });
  proxies.push(direct);
  const { proxy: cached, cache } = await startProxy();
  const options = (via: LanceS3Proxy) => ({ region: "us-east-1", aws_access_key_id: credentials.accessKeyId, aws_secret_access_key: credentials.secretAccessKey, endpoint: via.endpoint, allow_http: "true", virtual_hosted_style_request: "false" });
  const dim = 32;
  const rows = Array.from({ length: 3000 }, (_, id) => ({ id, vector: Array.from({ length: dim }, (_, d) => Math.sin((id + 1) * (d + 1))) }));
  const writer = await connect(`s3://${lanceBucket}/idx`, { storageOptions: options(direct) });
  const table = await writer.createTable("docs", rows, { mode: "overwrite" });
  await table.add(rows.slice(0, 10).map((r) => ({ ...r, id: r.id + 10_000 })));

  const queries = [3, 77, 1500, 2999].map((id) => rows[id].vector);
  const search = async (via: LanceS3Proxy) => {
    const t = await (await connect(`s3://${lanceBucket}/idx`, { storageOptions: options(via) })).openTable("docs");
    const out: unknown[] = [];
    for (const q of queries) out.push((await t.search(q).limit(5).toArray()).map((r) => [r.id, Number(r._distance).toFixed(6)]));
    out.push(await t.countRows(), (await t.query().where("id < 20").select(["id"]).toArray()).map((r) => r.id).sort((a, b) => a - b));
    return out;
  };
  const baseline = await search(direct);
  const cold = await search(cached);
  expect(cold).toEqual(baseline);
  expect(cache.cumulative.fillRequests).toBeGreaterThan(0);
  const fills = cache.cumulative.fillRequests;
  const warm = await search(cached);
  expect(warm).toEqual(baseline);
  expect(cache.cumulative.fillRequests).toBe(fills); // every immutable read came from disk
  expect(cache.cumulative.hits).toBeGreaterThan(0);
  // Lance's mutable and conditional traffic still flows: a new commit through the cached proxy is visible to readers.
  const t2 = await (await connect(`s3://${lanceBucket}/idx`, { storageOptions: options(cached) })).openTable("docs");
  await t2.add([{ id: 99_999, vector: rows[0].vector }]);
  expect(await (await (await connect(`s3://${lanceBucket}/idx`, { storageOptions: options(direct) })).openTable("docs")).countRows()).toBe(3011);
  expect(await t2.countRows()).toBe(3011);
}, 120_000);
