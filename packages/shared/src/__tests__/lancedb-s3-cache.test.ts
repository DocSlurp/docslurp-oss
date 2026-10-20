import { mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DiskBlockCache, blockLength, blockSpan, consecutiveRuns, isImmutableLanceKey, lanceS3CacheConfig, parseByteRange, resolveRange, serveCachedRequest,
  type BufferedUpstream, type CachedResult,
} from "../lancedb-s3-cache.js";

const KEY = "org/t.lance/data/abc.lance";
const B = 16;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "s3cache-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** An in-memory S3 object store that records every upstream request. */
function fakeUpstream(objects: Record<string, Buffer>, etag = '"e1"') {
  const calls: string[] = [];
  const fetchUpstream = async (method: "GET" | "HEAD", range?: string): Promise<BufferedUpstream> => {
    calls.push(`${method} ${range ?? ""}`);
    const body = objects[KEY];
    if (!body) return { status: 404, headers: {}, body: Buffer.from("<Error/>") };
    const headers = { etag, "last-modified": "Wed, 01 Jan 2026 00:00:00 GMT", "content-type": "application/octet-stream" };
    if (method === "HEAD") return { status: 200, headers: { ...headers, "content-length": String(body.length) }, body: Buffer.alloc(0) };
    const parsed = parseByteRange(range!)!;
    const r = resolveRange(parsed, body.length);
    if (!r) return { status: 416, headers: {}, body: Buffer.from("<Error/>") };
    return { status: 206, headers: { ...headers, "content-range": `bytes ${r.start}-${r.end}/${body.length}` }, body: body.subarray(r.start, r.end + 1) };
  };
  return { calls, fetchUpstream };
}

const object = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
const cacheOf = (maxBytes = 1_000_000) => new DiskBlockCache({ dir, maxBytes, blockBytes: B, log: () => undefined });

async function get(cache: DiskBlockCache, upstream: ReturnType<typeof fakeUpstream>, range?: string, extra: { key?: string; headers?: Record<string, string>; method?: string } = {}): Promise<CachedResult> {
  return await serveCachedRequest({
    cache, namespace: "ns", method: extra.method ?? "GET", bucket: "bkt", key: extra.key ?? KEY,
    headers: { ...(range ? { range } : {}), ...(extra.headers ?? {}) }, fetchUpstream: upstream.fetchUpstream,
  });
}
const bytes = (r: CachedResult) => { if (r.kind !== "response") throw new Error(`expected response, got ${r.reason}`); return r; };

describe("range math", () => {
  it("parses single byte ranges and rejects the rest", () => {
    expect(parseByteRange("bytes=0-9")).toEqual({ kind: "bounded", start: 0, end: 9 });
    expect(parseByteRange("bytes=5-")).toEqual({ kind: "open", start: 5 });
    expect(parseByteRange("bytes=-7")).toEqual({ kind: "suffix", length: 7 });
    for (const bad of ["bytes=0-1,4-5", "bytes=-", "bytes=9-1", "bytes=-0", "items=0-1", "bytes=a-b", ""]) expect(parseByteRange(bad), bad).toBeUndefined();
  });
  it("resolves ranges against a size", () => {
    expect(resolveRange({ kind: "bounded", start: 10, end: 500 }, 100)).toEqual({ start: 10, end: 99 });
    expect(resolveRange({ kind: "open", start: 90 }, 100)).toEqual({ start: 90, end: 99 });
    expect(resolveRange({ kind: "suffix", length: 7 }, 100)).toEqual({ start: 93, end: 99 });
    expect(resolveRange({ kind: "suffix", length: 700 }, 100)).toEqual({ start: 0, end: 99 });
    expect(resolveRange({ kind: "open", start: 100 }, 100)).toBeUndefined();
    expect(resolveRange({ kind: "bounded", start: 0, end: 1 }, 0)).toBeUndefined();
  });
  it("computes aligned block spans, lengths and runs", () => {
    expect(blockSpan(0, 15, 16)).toEqual({ first: 0, last: 0 });
    expect(blockSpan(15, 16, 16)).toEqual({ first: 0, last: 1 });
    expect(blockSpan(32, 47, 16)).toEqual({ first: 2, last: 2 });
    expect(blockLength(6, 100, 16)).toBe(4);
    expect(blockLength(7, 100, 16)).toBe(0);
    expect(blockLength(0, 100, 16)).toBe(16);
    expect(consecutiveRuns([0, 1, 2, 5, 7, 8])).toEqual([[0, 2], [5, 5], [7, 8]]);
  });
  it("only treats data/ and _indices/ files inside a .lance dataset as immutable", () => {
    for (const key of ["t.lance/data/x.lance", "lancedb/org/t.lance/_indices/u/index.idx", "data/lancedb/t.lance/data/x.lance"]) expect(isImmutableLanceKey(key), key).toBe(true);
    for (const key of ["t.lance/_versions/1.manifest", "t.lance/_latest.manifest", "t.lance/_transactions/0-u.txn", "t.lance/_deletions/1.arrow", "data/lancedb/t.lance/_versions/1.manifest", "data/x.lance", "t.lance/data/", "t.lance/data"]) expect(isImmutableLanceKey(key), key).toBe(false);
  });
  it("reads cache settings from the environment", () => {
    expect(lanceS3CacheConfig({})).toBeUndefined();
    expect(lanceS3CacheConfig({ LANCEDB_S3_CACHE_DIR: "/c", LANCEDB_S3_CACHE_MAX_GB: "2" })).toMatchObject({ dir: "/c", maxBytes: 2 * 1024 ** 3, blockBytes: 1024 * 1024 });
    expect(lanceS3CacheConfig({ LANCEDB_S3_CACHE_DIR: "/c" })?.maxBytes).toBe(10 * 1024 ** 3);
    expect(lanceS3CacheConfig({ LANCEDB_S3_CACHE_DIR: "/c", LANCEDB_S3_CACHE_MAX_GB: "0" })).toBeUndefined();
  });
});

describe("serveCachedRequest", () => {
  it("serves exact bytes with correct headers and answers overlapping ranges from cache", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    const a = bytes(await get(cache, up, "bytes=10-40"));
    expect(a.status).toBe(206);
    expect([...a.body]).toEqual([...object.subarray(10, 41)]);
    expect(a.headers["content-range"]).toBe("bytes 10-40/100");
    expect(a.headers["content-length"]).toBe("31");
    expect(a.headers.etag).toBe('"e1"');
    expect(a.outcome).toBe("miss");
    expect(up.calls).toEqual(["GET bytes=0-47"]); // one aligned request covering blocks 0..2
    const before = up.calls.length;
    for (const [range, from, to] of [["bytes=20-30", 20, 30], ["bytes=0-0", 0, 0], ["bytes=15-16", 15, 16], ["bytes=47-47", 47, 47]] as const) {
      const r = bytes(await get(cache, up, range));
      expect(r.outcome, range).toBe("hit");
      expect([...r.body], range).toEqual([...object.subarray(from, to + 1)]);
      expect(r.headers["content-range"]).toBe(`bytes ${from}-${to}/100`);
    }
    expect(up.calls.length).toBe(before);
    // Partly cached: only the missing aligned run is fetched.
    const c = bytes(await get(cache, up, "bytes=40-70"));
    expect(c.outcome).toBe("miss");
    expect([...c.body]).toEqual([...object.subarray(40, 71)]);
    expect(up.calls.slice(before)).toEqual(["GET bytes=48-79"]);
  });

  it("clamps the end block, resolves suffix and open ranges, serves whole objects as 200", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    const tail = bytes(await get(cache, up, "bytes=-10"));
    expect(tail.status).toBe(206);
    expect([...tail.body]).toEqual([...object.subarray(90)]);
    expect(tail.headers["content-range"]).toBe("bytes 90-99/100");
    const open = bytes(await get(cache, up, "bytes=95-"));
    expect([...open.body]).toEqual([...object.subarray(95)]);
    const beyond = bytes(await get(cache, up, "bytes=96-5000"));
    expect(beyond.headers["content-range"]).toBe("bytes 96-99/100");
    const full = bytes(await get(cache, up));
    expect(full.status).toBe(200);
    expect(full.headers["content-range"]).toBeUndefined();
    expect([...full.body]).toEqual([...object]);
    expect(bytes(await get(cache, up)).outcome).toBe("hit");
  });

  it("answers HEAD from metadata and records it on first sight", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    const first = bytes(await get(cache, up, undefined, { method: "HEAD" }));
    expect(first.status).toBe(200);
    expect(up.calls).toEqual(["HEAD "]);
    const second = bytes(await get(cache, up, undefined, { method: "HEAD" }));
    expect(second.outcome).toBe("hit");
    expect(second.headers["content-length"]).toBe("100");
    expect(second.headers.etag).toBe('"e1"');
    expect(second.body.length).toBe(0);
    expect(up.calls.length).toBe(1);
    // The size learned from HEAD lets a suffix range resolve without a probe.
    const tail = bytes(await get(cache, up, "bytes=-4"));
    expect(up.calls).toEqual(["HEAD ", "GET bytes=96-111"]);
    expect([...tail.body]).toEqual([...object.subarray(96)]);
  });

  it("never caches mutable paths, conditional requests, unsupported ranges or non-2xx answers", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    for (const key of ["org/t.lance/_versions/3.manifest", "org/t.lance/_latest.manifest", "org/t.lance/_transactions/0-u.txn"]) {
      expect((await get(cache, up, "bytes=0-9", { key })).kind).toBe("bypass");
    }
    expect((await get(cache, up, "bytes=0-9", { headers: { "if-none-match": '"x"' } })).kind).toBe("bypass");
    expect((await get(cache, up, "bytes=0-9", { headers: { "if-match": '"x"' } })).kind).toBe("bypass");
    expect((await get(cache, up, "bytes=0-1,4-5")).kind).toBe("bypass");
    expect(up.calls).toEqual([]);
    expect(cache.entries).toBe(0);
    // Errors from the origin are returned untouched and leave nothing behind.
    const missing = fakeUpstream({});
    const notFound = bytes(await get(cache, missing, "bytes=0-9"));
    expect(notFound.status).toBe(404);
    expect(notFound.outcome).toBe("upstream");
    expect(cache.entries).toBe(0);
    // Range past the end: the cache defers to the origin's 416 instead of inventing one.
    await get(cache, up, "bytes=0-9");
    expect((await get(cache, up, "bytes=500-600")).kind).toBe("bypass");
  });

  it("treats truncated or missing block files as misses and refetches correct bytes", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    await get(cache, up, "bytes=0-47");
    const files: string[] = [];
    const walk = async (d: string) => { for (const e of await readdir(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) await walk(p); else files.push(p); } };
    await walk(dir);
    const block1 = files.find((f) => f.endsWith("/1"))!;
    const block2 = files.find((f) => f.endsWith("/2"))!;
    await truncate(block1, 5);
    await rm(block2);
    up.calls.length = 0;
    const r = bytes(await get(cache, up, "bytes=0-47"));
    expect([...r.body]).toEqual([...object.subarray(0, 48)]);
    expect(r.outcome).toBe("miss");
    expect(up.calls).toEqual(["GET bytes=16-47"]);
    expect(bytes(await get(cache, up, "bytes=0-47")).outcome).toBe("hit");
    // Garbage metadata is also just a miss.
    const meta = files.find((f) => f.endsWith("meta.json"))!;
    await writeFile(meta, "{not json");
    const again = new DiskBlockCache({ dir, maxBytes: 1_000_000, blockBytes: B, log: () => undefined });
    await again.ready;
    expect([...bytes(await get(again, up, "bytes=3-9")).body]).toEqual([...object.subarray(3, 10)]);
  });

  it("coalesces concurrent identical misses into one upstream request", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    await get(cache, up, "bytes=0-0"); // learn the size so the requests below race on the same block
    up.calls.length = 0;
    const results = await Promise.all(Array.from({ length: 8 }, () => get(cache, up, "bytes=32-40")));
    for (const r of results) expect([...bytes(r).body]).toEqual([...object.subarray(32, 41)]);
    expect(up.calls.length).toBe(1);
  });

  it("drops an object whose ETag changed upstream", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object }, '"e1"');
    await get(cache, up, "bytes=0-15");
    const changed = Buffer.from(Array.from({ length: 100 }, (_, i) => 200 - i));
    const up2 = fakeUpstream({ [KEY]: changed }, '"e2"');
    await get(cache, up2, "bytes=16-31"); // fills block 1 from the new object
    const r = bytes(await get(cache, up2, "bytes=0-31"));
    expect([...r.body]).toEqual([...changed.subarray(0, 32)]);
    expect(r.headers.etag).toBe('"e2"');
  });
});

describe("DiskBlockCache", () => {
  it("evicts least recently used files at the size limit", async () => {
    const probe = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    await get(probe, up, "bytes=0-15");
    const metaBytes = probe.sizeBytes - B;
    await rm(dir, { recursive: true, force: true });
    const cache = cacheOf(metaBytes + B * 3); // room for the metadata and three blocks
    await get(cache, up, "bytes=0-15");   // block 0
    await get(cache, up, "bytes=16-31");  // block 1
    await get(cache, up, "bytes=0-15");   // touch block 0 so block 1 is the oldest
    await get(cache, up, "bytes=32-47");  // block 2
    await get(cache, up, "bytes=48-63");  // block 3, pushes past the limit
    expect(cache.sizeBytes).toBeLessThanOrEqual(cache.maxBytes);
    expect(cache.cumulative.evictions).toBeGreaterThan(0);
    expect(cache.hasBlock(DiskBlockCache.objectId("ns", "bkt", KEY), 1)).toBe(false);
    expect(cache.hasBlock(DiskBlockCache.objectId("ns", "bkt", KEY), 3)).toBe(true);
    // Evicted data is simply refetched, with correct bytes.
    expect([...bytes(await get(cache, up, "bytes=16-31")).body]).toEqual([...object.subarray(16, 32)]);
  });

  it("rebuilds its index from disk on start, removes temp files and trims to the limit", async () => {
    const first = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    await get(first, up, "bytes=0-95");
    const size = first.sizeBytes;
    const id = DiskBlockCache.objectId("ns", "bkt", KEY);
    await writeFile(join(dir, id.slice(0, 2), id, "3.tmp-1-dead"), "partial");
    const second = new DiskBlockCache({ dir, maxBytes: 1_000_000, blockBytes: B, log: () => undefined });
    await second.ready;
    expect(second.sizeBytes).toBe(size);
    expect(second.hasBlock(id, 5)).toBe(true);
    expect((await readdir(join(dir, id.slice(0, 2), id))).some((f) => f.includes(".tmp-"))).toBe(false);
    up.calls.length = 0;
    expect(bytes(await get(second, up, "bytes=20-70")).outcome).toBe("hit");
    expect(up.calls).toEqual([]);
    const small = new DiskBlockCache({ dir, maxBytes: 64, blockBytes: B, log: () => undefined });
    await small.ready;
    expect(small.sizeBytes).toBeLessThanOrEqual(64);
  });

  it("reports window counters in the summary fragment and resets them", async () => {
    const cache = cacheOf(); const up = fakeUpstream({ [KEY]: object });
    await get(cache, up, "bytes=0-15");
    await get(cache, up, "bytes=0-15");
    const line = cache.summaryFragment();
    expect(line).toContain("cache_hits=1 cache_misses=1 cache_hit_ratio=0.50");
    expect(line).toContain("cache_bytes_served=16");
    expect(cache.summaryFragment()).toContain("cache_hits=0 cache_misses=0");
    expect(cache.cumulative.hits).toBe(1);
  });
});
