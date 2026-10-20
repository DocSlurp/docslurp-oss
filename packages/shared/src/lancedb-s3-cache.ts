// Server-only. Read-through disk cache for the immutable files Lance reads through the localhost S3 proxy.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IncomingHttpHeaders } from "node:http";

/**
 * Lance never rewrites `data/*.lance` or `_indices/**`: a new version adds files and `_versions/` manifests, and
 * cleanup deletes whole files. A cached byte range of an immutable object cannot go stale, so there is no TTL and no
 * invalidation protocol. Everything else (`_versions/`, `_latest`, `_transactions/`, `_deletions/`, LIST, writes,
 * multipart) is never cached.
 *
 * Objects are cached as fixed-size aligned blocks, so overlapping and adjacent ranges share entries. Each cached
 * object also has a small metadata record (size, ETag, Last-Modified, Content-Type) that lets the cache resolve
 * `bytes=-n` / `bytes=a-` ranges, answer HEAD, and serve exactly the requested bytes with correct Content-Range.
 *
 * Safety nets for the immutability assumption: the proxy drops an object's entries when it sees a DELETE or PUT for it,
 * and a fill whose ETag differs from the cached metadata discards the object's old blocks before storing new ones.
 */

export const DEFAULT_BLOCK_BYTES = 1024 * 1024;
/** A request spanning more than this many blocks streams through uncached (scans of whole large files). */
export const DEFAULT_MAX_SPAN_BLOCKS = 32;

/** Lance dataset directories end in `.lance`; only their `data/` and `_indices/` children are immutable. */
export function isImmutableLanceKey(key: string): boolean {
  return /(^|\/)[^/]+\.lance\/(data|_indices)\/[^/]/.test(key);
}

// ---- Range math --------------------------------------------------------------------------------------------------

export type ParsedRange = { kind: "bounded"; start: number; end: number } | { kind: "open"; start: number } | { kind: "suffix"; length: number };

/** Parses a single `bytes=` range. Returns undefined for multi-range, malformed or unsupported units. */
export function parseByteRange(header: string): ParsedRange | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined;
  const [, a, b] = match;
  if (a === "" && b === "") return undefined;
  if (a === "") return Number(b) > 0 ? { kind: "suffix", length: Number(b) } : undefined;
  const start = Number(a);
  if (b === "") return { kind: "open", start };
  const end = Number(b);
  return end >= start ? { kind: "bounded", start, end } : undefined;
}

/** Resolves a range against a known object size to inclusive byte offsets; undefined when unsatisfiable (416). */
export function resolveRange(range: ParsedRange, size: number): { start: number; end: number } | undefined {
  if (size <= 0) return undefined;
  if (range.kind === "suffix") return { start: Math.max(0, size - range.length), end: size - 1 };
  if (range.start >= size) return undefined;
  return { start: range.start, end: range.kind === "open" ? size - 1 : Math.min(range.end, size - 1) };
}

/** Inclusive block indexes covering the inclusive byte range. */
export function blockSpan(start: number, end: number, blockBytes: number): { first: number; last: number } {
  return { first: Math.floor(start / blockBytes), last: Math.floor(end / blockBytes) };
}

/** Expected byte length of block `index` for an object of `size` bytes. */
export function blockLength(index: number, size: number, blockBytes: number): number {
  return Math.max(0, Math.min(blockBytes, size - index * blockBytes));
}

/** Groups sorted block indexes into inclusive consecutive runs. */
export function consecutiveRuns(indexes: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const index of indexes) {
    const last = runs[runs.length - 1];
    if (last && last[1] === index - 1) last[1] = index; else runs.push([index, index]);
  }
  return runs;
}

// ---- Disk cache ---------------------------------------------------------------------------------------------------

export interface ObjectMeta { size: number; etag?: string; lastModified?: string; contentType?: string; bucket: string; key: string }

interface IndexEntry { size: number; touchedAt: number }

export interface CacheCounters { hits: number; misses: number; bypass: number; bytesServed: number; bytesFilled: number; fillRequests: number; evictions: number; evictedBytes: number }
const newCounters = (): CacheCounters => ({ hits: 0, misses: 0, bypass: 0, bytesServed: 0, bytesFilled: 0, fillRequests: 0, evictions: 0, evictedBytes: 0 });

export interface DiskBlockCacheOptions { dir: string; maxBytes: number; blockBytes?: number; maxSpanBlocks?: number; log?: (line: string) => void }

const TEMP_MARK = ".tmp-";
const TOUCH_INTERVAL_MS = 60_000;

export class DiskBlockCache {
  readonly dir: string;
  readonly maxBytes: number;
  readonly blockBytes: number;
  readonly maxSpanBlocks: number;
  readonly cumulative = newCounters();
  window = newCounters();
  /** Insertion order is LRU order: the first key is the least recently used. */
  private readonly index = new Map<string, IndexEntry>();
  private totalBytes = 0;
  private readonly metaMemory = new Map<string, ObjectMeta>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private evicting: Promise<void> | undefined;
  private warnedWriteFailure = false;
  readonly ready: Promise<void>;
  private readonly log: (line: string) => void;

  constructor(options: DiskBlockCacheOptions) {
    this.dir = resolve(options.dir);
    this.maxBytes = Math.max(0, Math.floor(options.maxBytes));
    this.blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES;
    this.maxSpanBlocks = options.maxSpanBlocks ?? DEFAULT_MAX_SPAN_BLOCKS;
    this.log = options.log ?? ((line) => console.log(line));
    this.ready = this.scan();
  }

  get sizeBytes(): number { return this.totalBytes; }
  get entries(): number { return this.index.size; }

  static objectId(namespace: string, bucket: string, key: string): string {
    return createHash("sha256").update(namespace).update("\0").update(bucket).update("\0").update(key).digest("hex");
  }

  private rel(id: string, name: string): string { return `${id.slice(0, 2)}/${id}/${name}`; }
  private abs(rel: string): string { return join(this.dir, rel); }

  /** Rebuilds the LRU index from disk (oldest mtime first), drops leftover temp files and trims to the size limit. */
  private async scan(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const found: Array<{ rel: string; size: number; mtimeMs: number }> = [];
    const walk = async (relDir: string): Promise<void> => {
      for (const dirent of await readdir(join(this.dir, relDir), { withFileTypes: true }).catch(() => [])) {
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) await walk(rel);
        else if (dirent.name.includes(TEMP_MARK)) await unlink(this.abs(rel)).catch(() => undefined);
        else {
          const info = await stat(this.abs(rel)).catch(() => undefined);
          if (info?.isFile()) found.push({ rel, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    };
    await walk("");
    found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of found) { this.index.set(file.rel, { size: file.size, touchedAt: file.mtimeMs }); this.totalBytes += file.size; }
    await this.evictToLimit();
  }

  private touch(rel: string): void {
    const entry = this.index.get(rel);
    if (!entry) return;
    this.index.delete(rel);
    this.index.set(rel, entry);
    const now = Date.now();
    if (now - entry.touchedAt > TOUCH_INTERVAL_MS) {
      entry.touchedAt = now;
      // Persist recency so a restart rebuilds a useful LRU order. Best effort.
      void utimes(this.abs(rel), new Date(now), new Date(now)).catch(() => undefined);
    }
  }

  private async put(rel: string, data: Buffer): Promise<void> {
    const path = this.abs(rel);
    const temp = `${path}${TEMP_MARK}${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(temp, data);
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if (!this.warnedWriteFailure) { this.warnedWriteFailure = true; this.log(`[lancedb-s3] cache write failed (serving uncached): ${error instanceof Error ? error.message : String(error)}`); }
      return;
    }
    const previous = this.index.get(rel);
    if (previous) { this.totalBytes -= previous.size; this.index.delete(rel); }
    this.index.set(rel, { size: data.length, touchedAt: Date.now() });
    this.totalBytes += data.length;
    await this.evictToLimit();
  }

  private async remove(rel: string): Promise<void> {
    const entry = this.index.get(rel);
    if (entry) { this.index.delete(rel); this.totalBytes -= entry.size; }
    await unlink(this.abs(rel)).catch(() => undefined);
  }

  /** Evicts least-recently-used files until the total is within the limit. Serialised so concurrent writers cannot over-evict. */
  private evictToLimit(): Promise<void> {
    const run = async () => {
      while (this.totalBytes > this.maxBytes) {
        const oldest = this.index.entries().next();
        if (oldest.done) break;
        const [rel, entry] = oldest.value;
        this.index.delete(rel);
        this.totalBytes -= entry.size;
        this.cumulative.evictions++; this.window.evictions++;
        this.cumulative.evictedBytes += entry.size; this.window.evictedBytes += entry.size;
        if (rel.endsWith("/meta.json")) this.metaMemory.delete(rel.split("/")[1]);
        await unlink(this.abs(rel)).catch(() => undefined);
      }
    };
    this.evicting = (this.evicting ?? Promise.resolve()).then(run, run);
    return this.evicting;
  }

  // ---- Object metadata

  async getMeta(id: string): Promise<ObjectMeta | undefined> {
    const rel = this.rel(id, "meta.json");
    if (!this.index.has(rel)) return undefined;
    const cached = this.metaMemory.get(id);
    if (cached) { this.touch(rel); return cached; }
    try {
      const meta = JSON.parse(await readFile(this.abs(rel), "utf8")) as ObjectMeta;
      if (!Number.isSafeInteger(meta.size) || meta.size < 0) throw new Error("bad meta");
      this.metaMemory.set(id, meta);
      this.touch(rel);
      return meta;
    } catch {
      await this.remove(rel);
      return undefined;
    }
  }

  async setMeta(id: string, meta: ObjectMeta): Promise<void> {
    const existing = this.metaMemory.get(id) ?? (await this.getMeta(id));
    if (existing && existing.size === meta.size && existing.etag === meta.etag) { return; }
    if (existing) await this.dropObject(id); // size or ETag changed: the old blocks no longer describe this object
    this.metaMemory.set(id, meta);
    await this.put(this.rel(id, "meta.json"), Buffer.from(JSON.stringify(meta)));
  }

  /** Drops every cached file of an object (after a DELETE or PUT through the proxy, or an ETag change). */
  async dropObject(id: string): Promise<void> {
    this.metaMemory.delete(id);
    const prefix = `${id.slice(0, 2)}/${id}/`;
    for (const rel of [...this.index.keys()]) if (rel.startsWith(prefix)) await this.remove(rel);
  }

  // ---- Blocks

  hasBlock(id: string, index: number): boolean { return this.index.has(this.rel(id, String(index))); }

  /** Reads a cached block. A missing, short or unreadable file is a miss and is removed. */
  async readBlock(id: string, index: number, expectedLength: number): Promise<Buffer | undefined> {
    const rel = this.rel(id, String(index));
    if (!this.index.has(rel)) return undefined;
    try {
      const data = await readFile(this.abs(rel));
      if (data.length !== expectedLength) throw new Error("length mismatch");
      this.touch(rel);
      return data;
    } catch {
      await this.remove(rel);
      return undefined;
    }
  }

  async writeBlock(id: string, index: number, data: Buffer): Promise<void> { await this.put(this.rel(id, String(index)), data); }

  /** Coalesces concurrent fetches of the same block: the first caller runs `load`, others await its result. */
  coalesce(id: string, index: number, load: () => Promise<Buffer>): Promise<Buffer> {
    const key = `${id}/${index}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = load().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  // ---- Reporting

  snapshot() { return { ...this.cumulative, sizeBytes: this.totalBytes, maxBytes: this.maxBytes, entries: this.index.size, blockBytes: this.blockBytes }; }

  /** Summary fragment for the window since the last call; resets the window. */
  summaryFragment(): string {
    const w = this.window;
    this.window = newCounters();
    const lookups = w.hits + w.misses;
    return `cache_hits=${w.hits} cache_misses=${w.misses} cache_hit_ratio=${lookups ? (w.hits / lookups).toFixed(2) : "n/a"} cache_bypass=${w.bypass} cache_bytes_served=${w.bytesServed} `
      + `cache_bytes_filled=${w.bytesFilled} cache_fill_requests=${w.fillRequests} cache_evictions=${w.evictions} cache_evicted_bytes=${w.evictedBytes} `
      + `cache_size_bytes=${this.totalBytes} cache_max_bytes=${this.maxBytes}`;
  }

  count(field: keyof CacheCounters, amount = 1): void { this.cumulative[field] += amount; this.window[field] += amount; }
}

// ---- Request handling ---------------------------------------------------------------------------------------------

export interface BufferedUpstream { status: number; headers: IncomingHttpHeaders; body: Buffer }

export interface CachedRequest {
  cache: DiskBlockCache;
  /** Distinguishes upstreams that share bucket names, for example the S3 endpoint host. */
  namespace: string;
  method: string;
  bucket: string;
  key: string;
  headers: IncomingHttpHeaders;
  /** Performs one signed upstream request. Called with a GET plus Range header, or a HEAD. */
  fetchUpstream(method: "GET" | "HEAD", range?: string): Promise<BufferedUpstream>;
}

export type CachedResult =
  | { kind: "bypass"; reason: string }
  | { kind: "response"; status: number; headers: Record<string, string>; body: Buffer; outcome: "hit" | "miss" | "upstream"; bytesFromCache: number; bytesFilled: number; upstreamRequests: number };

const CONDITIONAL_HEADERS = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range"];

function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }

function metaFromUpstream(request: CachedRequest, upstream: BufferedUpstream): ObjectMeta | undefined {
  const contentRange = headerValue(upstream.headers["content-range"]);
  const total = contentRange ? /\/(\d+)$/.exec(contentRange)?.[1] : headerValue(upstream.headers["content-length"]);
  if (total === undefined) return undefined;
  return { size: Number(total), etag: headerValue(upstream.headers.etag), lastModified: headerValue(upstream.headers["last-modified"]), contentType: headerValue(upstream.headers["content-type"]), bucket: request.bucket, key: request.key };
}

function responseHeaders(meta: ObjectMeta, length: number, contentRange?: string): Record<string, string> {
  const headers: Record<string, string> = { "accept-ranges": "bytes", "content-length": String(length), "content-type": meta.contentType ?? "application/octet-stream" };
  if (meta.etag) headers.etag = meta.etag;
  if (meta.lastModified) headers["last-modified"] = meta.lastModified;
  if (contentRange) headers["content-range"] = contentRange;
  return headers;
}

function passthrough(upstream: BufferedUpstream, upstreamRequests: number, bytesFilled = 0): CachedResult {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined || ["connection", "keep-alive", "transfer-encoding"].includes(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return { kind: "response", status: upstream.status, headers, body: upstream.body, outcome: "upstream", bytesFromCache: 0, bytesFilled, upstreamRequests };
}

/**
 * Serves one GET or HEAD for an immutable Lance object from the cache, filling missing aligned blocks from upstream.
 * Returns `bypass` when the request is not safely cacheable (the caller streams it through untouched). Non-2xx
 * upstream answers are returned as-is and never stored.
 */
export async function serveCachedRequest(request: CachedRequest): Promise<CachedResult> {
  const { cache } = request;
  await cache.ready;
  const bypass = (reason: string): CachedResult => { cache.count("bypass"); return { kind: "bypass", reason }; };
  if (cache.maxBytes <= 0) return { kind: "bypass", reason: "disabled" };
  if (request.method !== "GET" && request.method !== "HEAD") return { kind: "bypass", reason: "method" };
  if (!isImmutableLanceKey(request.key)) return { kind: "bypass", reason: "mutable-path" };
  if (CONDITIONAL_HEADERS.some((name) => request.headers[name] !== undefined)) return bypass("conditional");
  if (Object.keys(request.headers).some((name) => name.startsWith("x-amz-server-side-encryption-customer-"))) return bypass("sse-c");
  const id = DiskBlockCache.objectId(request.namespace, request.bucket, request.key);
  const B = cache.blockBytes;
  let upstreamRequests = 0, bytesFilled = 0;

  if (request.method === "HEAD") {
    const meta = await cache.getMeta(id);
    if (meta) {
      cache.count("hits");
      return { kind: "response", status: 200, headers: responseHeaders(meta, meta.size), body: Buffer.alloc(0), outcome: "hit", bytesFromCache: 0, bytesFilled: 0, upstreamRequests: 0 };
    }
    cache.count("misses");
    const upstream = await request.fetchUpstream("HEAD");
    if (upstream.status === 200) {
      const fresh = metaFromUpstream(request, upstream);
      if (fresh && Number.isSafeInteger(fresh.size)) await cache.setMeta(id, fresh);
    }
    return passthrough(upstream, 1);
  }

  const rangeHeader = headerValue(request.headers.range);
  let parsed: ParsedRange | undefined;
  if (rangeHeader !== undefined) {
    parsed = parseByteRange(rangeHeader);
    if (!parsed) return bypass("range-unsupported");
  }

  /** Fetches blocks [first, last] with one aligned upstream request, stores them and returns the buffers. */
  const fill = async (first: number, last: number): Promise<{ blocks: Map<number, Buffer>; error?: BufferedUpstream }> => {
    const blocks = new Map<number, Buffer>();
    let failure: BufferedUpstream | undefined;
    const upstreamRange = `bytes=${first * B}-${last * B + B - 1}`;
    // One shared request per run; each block registers in the coalescing table so concurrent identical misses wait for it.
    let runPromise: Promise<Map<number, Buffer>> | undefined;
    const runOnce = (): Promise<Map<number, Buffer>> => (runPromise ??= (async () => {
      const upstream = await request.fetchUpstream("GET", upstreamRange);
      upstreamRequests++;
      cache.count("fillRequests");
      if (upstream.status !== 206) { failure = upstream; throw new UpstreamFailure(); }
      const meta = metaFromUpstream(request, upstream);
      const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headerValue(upstream.headers["content-range"]) ?? "");
      if (!meta || !contentRange || Number(contentRange[1]) !== first * B || Number(contentRange[2]) - Number(contentRange[1]) + 1 !== upstream.body.length) throw new Error("unexpected upstream range response");
      await cache.setMeta(id, meta);
      const out = new Map<number, Buffer>();
      const writes: Promise<void>[] = [];
      for (let index = first; index <= last; index++) {
        const length = blockLength(index, meta.size, B);
        const offset = (index - first) * B;
        if (length === 0) continue;
        const data = upstream.body.subarray(offset, offset + length);
        if (data.length !== length) throw new Error("short upstream block");
        out.set(index, data);
        writes.push(cache.writeBlock(id, index, Buffer.from(data)));
      }
      await Promise.all(writes);
      bytesFilled += upstream.body.length;
      cache.count("bytesFilled", upstream.body.length);
      return out;
    })());
    try {
      const parts = await Promise.all(Array.from({ length: last - first + 1 }, (_, i) => cache.coalesce(id, first + i, async () => {
        const out = await runOnce();
        return out.get(first + i) ?? Buffer.alloc(0);
      })));
      parts.forEach((data, i) => { if (data.length) blocks.set(first + i, data); });
    } catch (error) {
      if (error instanceof UpstreamFailure && failure) return { blocks, error: failure };
      throw error;
    }
    return { blocks };
  };

  let meta = await cache.getMeta(id);
  if (!meta) {
    // Unknown size: the first block teaches us the size, and it is useful data anyway.
    const probeFirst = parsed?.kind === "bounded" ? Math.floor(parsed.start / B) : 0;
    const probeLast = parsed?.kind === "bounded" ? Math.floor(parsed.end / B) : 0;
    if (probeLast - probeFirst + 1 > cache.maxSpanBlocks) return bypass("span-too-large");
    const first = await fill(probeFirst, probeLast);
    if (first.error) return passthrough(first.error, upstreamRequests, bytesFilled);
    meta = await cache.getMeta(id);
    if (!meta) return bypass("meta-unavailable");
    return await finish(meta, first.blocks);
  }
  return await finish(meta, new Map());

  async function finish(known: ObjectMeta, have: Map<number, Buffer>): Promise<CachedResult> {
    let range: { start: number; end: number } | undefined;
    if (parsed) range = resolveRange(parsed, known.size);
    else if (known.size > 0) range = { start: 0, end: known.size - 1 };
    if (!range) return bypass("unsatisfiable"); // let the origin answer 416 or an empty object
    const { first, last } = blockSpan(range.start, range.end, B);
    if (last - first + 1 > cache.maxSpanBlocks) return bypass("span-too-large");
    const wanted: number[] = [];
    for (let index = first; index <= last; index++) if (!have.has(index)) wanted.push(index);
    const missing: number[] = [];
    let fromDisk = 0;
    await Promise.all(wanted.map(async (index) => {
      const data = cache.hasBlock(id, index) ? await cache.readBlock(id, index, blockLength(index, known.size, B)) : undefined;
      if (data) { have.set(index, data); fromDisk += data.length; } else missing.push(index);
    }));
    for (const [runStart, runEnd] of consecutiveRuns(missing.sort((a, b) => a - b)).flatMap(([s, e]) => splitRun(s, e, cache.maxSpanBlocks))) {
      const filled = await fill(runStart, runEnd);
      if (filled.error) return passthrough(filled.error, upstreamRequests, bytesFilled);
      for (const [index, data] of filled.blocks) have.set(index, data);
    }
    // An ETag change during a fill drops the old object: re-read the metadata so headers match the bytes served.
    const current = (await cache.getMeta(id)) ?? known;
    if (current.size !== known.size || current.etag !== known.etag) return bypass("object-changed");
    const parts: Buffer[] = [];
    for (let index = first; index <= last; index++) {
      const data = have.get(index);
      if (!data) return bypass("block-missing");
      const from = index === first ? range.start - index * B : 0;
      const to = index === last ? range.end - index * B + 1 : data.length;
      parts.push(data.subarray(from, to));
    }
    const body = Buffer.concat(parts);
    const hit = upstreamRequests === 0;
    cache.count(hit ? "hits" : "misses");
    if (hit) cache.count("bytesServed", body.length);
    const status = parsed ? 206 : 200;
    const headers = responseHeaders(known, body.length, parsed ? `bytes ${range.start}-${range.end}/${known.size}` : undefined);
    return { kind: "response", status, headers, body, outcome: hit ? "hit" : "miss", bytesFromCache: hit ? body.length : fromDisk, bytesFilled, upstreamRequests };
  }
}

class UpstreamFailure extends Error {}

function splitRun(start: number, end: number, maxBlocks: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let s = start; s <= end; s += maxBlocks) out.push([s, Math.min(end, s + maxBlocks - 1)]);
  return out;
}

/** Drops the cached copy of an object after the proxy sees a DELETE or PUT for it. */
export async function invalidateCachedObject(cache: DiskBlockCache, namespace: string, bucket: string, key: string): Promise<void> {
  await cache.ready;
  await cache.dropObject(DiskBlockCache.objectId(namespace, bucket, key));
}

// ---- Configuration ------------------------------------------------------------------------------------------------

export interface LanceS3CacheConfig { dir: string; maxBytes: number; blockBytes: number }

/** LANCEDB_S3_CACHE_DIR enables the cache; LANCEDB_S3_CACHE_MAX_GB (default 10) bounds it; LANCEDB_S3_CACHE_BLOCK_KB (default 1024) sets the block size. */
export function lanceS3CacheConfig(env: Record<string, string | undefined> = process.env): LanceS3CacheConfig | undefined {
  const dir = env.LANCEDB_S3_CACHE_DIR?.trim();
  if (!dir) return undefined;
  const gb = Number(env.LANCEDB_S3_CACHE_MAX_GB?.trim() || 10);
  const blockKb = Number(env.LANCEDB_S3_CACHE_BLOCK_KB?.trim() || DEFAULT_BLOCK_BYTES / 1024);
  if (!Number.isFinite(gb) || gb <= 0) { console.warn(`[lancedb-s3] LANCEDB_S3_CACHE_MAX_GB=${env.LANCEDB_S3_CACHE_MAX_GB} is not a positive number; cache disabled`); return undefined; }
  return { dir, maxBytes: Math.floor(gb * 1024 ** 3), blockBytes: Number.isFinite(blockKb) && blockKb >= 4 ? Math.floor(blockKb * 1024) : DEFAULT_BLOCK_BYTES };
}

const caches = new Map<string, DiskBlockCache>();
/** One cache instance per directory, shared by every proxy in the process so size accounting stays consistent. */
export function sharedDiskBlockCache(config: LanceS3CacheConfig): DiskBlockCache {
  const dir = resolve(config.dir);
  let cache = caches.get(dir);
  if (!cache) { cache = new DiskBlockCache({ dir, maxBytes: config.maxBytes, blockBytes: config.blockBytes }); caches.set(dir, cache); }
  return cache;
}
export async function rmCacheDirForTests(dir: string): Promise<void> { caches.delete(resolve(dir)); await rm(dir, { recursive: true, force: true }); }
