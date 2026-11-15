// Server-only. Opt-in tracing proxy for LanceDB's native (Rust object_store) S3 traffic.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { Agent as HttpAgent } from "node:http";
import type { AddressInfo } from "node:net";
import { SignatureV4 } from "@smithy/signature-v4";
import type { HttpRequest as SmithyRequest } from "@smithy/types";
import { startDependencySpan } from "./telemetry.js";
import { DiskBlockCache, invalidateCachedObject, isImmutableLanceKey, lanceS3CacheConfig, serveCachedRequest, sharedDiskBlockCache, type BufferedUpstream } from "./lancedb-s3-cache.js";

/**
 * LANCEDB_S3_TRACE=1 starts an in-process localhost proxy and points Lance's
 * object store at it. The proxy re-signs each request (SigV4, the host changes),
 * streams bodies in both directions, forwards every other header unchanged
 * (If-Match / If-None-Match carry the commit protocol) and emits one dependency
 * span per request. Lance's own SDK is not hookable, so this is the only way to
 * see its requests. Default off; see docs/dependency-tracing.md for overhead.
 *
 * LANCEDB_S3_CACHE_DIR starts the same proxy with a read-through disk cache for Lance's immutable files (see
 * lancedb-s3-cache.ts), independent of tracing.
 */

export type LanceS3Operation = "GetObject" | "HeadObject" | "PutObject" | "CopyObject" | "DeleteObject" | "DeleteObjects" | "ListObjectsV2" | "ListMultipartUploads"
  | "ListParts" | "CreateMultipartUpload" | "UploadPart" | "UploadPartCopy" | "CompleteMultipartUpload" | "AbortMultipartUpload" | "HeadBucket" | "Other";

export interface ClassifiedRequest { operation: LanceS3Operation; bucket: string; key: string; query: Array<[string, string]> }

export function parseQuery(search: string): Array<[string, string]> {
  if (!search) return [];
  return search.split("&").filter(Boolean).map((pair) => {
    const eq = pair.indexOf("=");
    const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
    return eq < 0 ? [decode(pair), ""] : [decode(pair.slice(0, eq)), decode(pair.slice(eq + 1))];
  });
}

/** Maps a path-style S3 request to its API operation. */
export function classifyS3Request(method: string, rawUrl: string, headers: IncomingHttpHeaders = {}): ClassifiedRequest {
  const q = rawUrl.indexOf("?");
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = parseQuery(q < 0 ? "" : rawUrl.slice(q + 1));
  const has = (name: string) => query.some(([key]) => key === name);
  const [, bucketRaw = "", ...rest] = path.split("/");
  const bucket = decodeURIComponent(bucketRaw);
  const key = rest.join("/");
  let operation: LanceS3Operation = "Other";
  const m = method.toUpperCase();
  if (!key) {
    if (m === "GET") operation = has("uploads") ? "ListMultipartUploads" : "ListObjectsV2";
    else if (m === "HEAD") operation = "HeadBucket";
    else if (m === "POST" && has("delete")) operation = "DeleteObjects";
  } else if (m === "GET") operation = has("uploadId") ? "ListParts" : "GetObject";
  else if (m === "HEAD") operation = "HeadObject";
  else if (m === "PUT") {
    const copy = headers["x-amz-copy-source"] !== undefined;
    operation = has("uploadId") && has("partNumber") ? (copy ? "UploadPartCopy" : "UploadPart") : copy ? "CopyObject" : "PutObject";
  } else if (m === "POST") operation = has("uploads") ? "CreateMultipartUpload" : has("uploadId") ? "CompleteMultipartUpload" : "Other";
  else if (m === "DELETE") operation = has("uploadId") ? "AbortMultipartUpload" : "DeleteObject";
  return { operation, bucket, key, query };
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

class NodeSha256 {
  private hash;
  constructor(private secret?: string | ArrayBuffer | ArrayBufferView) { this.hash = secret === undefined ? createHash("sha256") : createHmac("sha256", Buffer.from(secret as Uint8Array)); }
  update(data: string | ArrayBuffer | ArrayBufferView): void { this.hash.update(typeof data === "string" ? data : Buffer.from(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data))); }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.hash.digest()); }
  reset(): void { this.hash = this.secret === undefined ? createHash("sha256") : createHmac("sha256", Buffer.from(this.secret as Uint8Array)); }
}

/** Headers that must not be forwarded (hop-by-hop, or re-derived by the signer). */
const DROPPED_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "expect", "authorization",
  "x-amz-date", "x-amz-security-token", "accept-encoding", "user-agent"]);

export interface UpstreamTarget { protocol: "https:" | "http:"; hostname: string; port?: string; region: string }
export interface Credentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface SignedUpstreamRequest { protocol: string; hostname: string; port?: number; method: string; path: string; headers: Record<string, string> }

/** Re-signs a client request for the real endpoint. Conditional and range headers pass through untouched. */
export async function signUpstreamRequest(
  method: string, rawUrl: string, incoming: IncomingHttpHeaders, target: UpstreamTarget, credentials: Credentials, now: Date = new Date(),
): Promise<SignedUpstreamRequest> {
  const q = rawUrl.indexOf("?");
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const queryPairs = parseQuery(q < 0 ? "" : rawUrl.slice(q + 1));
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of queryPairs) {
    const existing = query[key];
    query[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
  }
  const headers: Record<string, string> = { host: target.port ? `${target.hostname}:${target.port}` : target.hostname };
  for (const [name, value] of Object.entries(incoming)) {
    if (DROPPED_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }
  // The body is forwarded byte-for-byte, so Lance's own payload hash (or UNSIGNED-PAYLOAD) stays valid.
  headers["x-amz-content-sha256"] ??= "UNSIGNED-PAYLOAD";
  if (/^STREAMING-/.test(headers["x-amz-content-sha256"])) throw new Error("aws-chunked streaming payloads cannot be re-signed");
  const signer = new SignatureV4({ service: "s3", region: target.region, sha256: NodeSha256 as never, uriEscapePath: false, applyChecksum: false, credentials });
  const request: SmithyRequest = { method, protocol: target.protocol, hostname: target.hostname, port: target.port ? Number(target.port) : undefined, path, query, headers };
  const signed = await signer.sign(request, { signingDate: now });
  const search = queryPairs.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join("&");
  return { protocol: target.protocol, hostname: target.hostname, port: target.port ? Number(target.port) : undefined, method, path: search ? `${path}?${search}` : path, headers: signed.headers as Record<string, string> };
}

// ---- Object classes and search-scoped read counts -----------------------------------------------------------------

/** Lance object classes. Bounded set: safe for attributes and log fields. */
export type LanceObjectClass = "list" | "latest" | "versions" | "transactions" | "indices" | "data" | "deletions" | "other";
export const LANCE_OBJECT_CLASSES: readonly LanceObjectClass[] = ["list", "latest", "versions", "transactions", "indices", "data", "deletions", "other"];

/** Classifies a request by the Lance dataset file it touches. Bucket-level listings are `list` (Lance's latest-version lookup). */
export function lanceObjectClass(operation: LanceS3Operation, key: string): LanceObjectClass {
  if (operation === "ListObjectsV2" || operation === "ListMultipartUploads" || operation === "ListParts") return "list";
  const segments = key.split("/");
  const last = segments[segments.length - 1] ?? "";
  if (last.startsWith("_latest")) return "latest";
  const dir = (name: string) => segments.slice(0, -1).includes(name);
  if (dir("_versions")) return "versions";
  if (dir("_transactions")) return "transactions";
  if (dir("_indices")) return "indices";
  if (dir("_deletions")) return "deletions";
  if (dir("data")) return "data";
  return "other";
}

export type RangeSizeBucket = "full" | "le4k" | "le64k" | "le1m" | "gt1m";
export const RANGE_SIZE_BUCKETS: readonly RangeSizeBucket[] = ["full", "le4k", "le64k", "le1m", "gt1m"];

/** Buckets the requested byte range (`Range: bytes=a-b`); requests without a closed range are `full`. */
export function rangeSizeBucket(range: string | undefined): RangeSizeBucket {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range?.trim() ?? "");
  if (!match) return "full";
  const size = Number(match[2]) - Number(match[1]) + 1;
  return size <= 4096 ? "le4k" : size <= 65536 ? "le64k" : size <= 1048576 ? "le1m" : "gt1m";
}

export interface SearchReadCounts {
  requests: number;
  bytes: number;
  /** Sum of request durations (not wall time: requests run in parallel). */
  requestMs: number;
  byClass: Partial<Record<LanceObjectClass, number>>;
  bySize: Partial<Record<RangeSizeBucket, number>>;
  /** Another search was in flight at some point: the proxy cannot tell whose request it was, so each overlapping scope counts it. */
  overlapped: boolean;
}

interface SearchReadScope extends SearchReadCounts { ended: boolean }
const activeSearchScopes = new Set<SearchReadScope>();

/**
 * Counts the proxied Lance requests that start while a search runs. Lance issues requests from native threads, so
 * AsyncLocalStorage cannot carry the search identity; attribution is by time window. Overlapping searches each count
 * the shared requests and are flagged `overlapped`. Costs nothing when the tracing proxy is off (no requests arrive).
 */
export function beginSearchReadScope(): { end(): SearchReadCounts } {
  const scope: SearchReadScope = { requests: 0, bytes: 0, requestMs: 0, byClass: {}, bySize: {}, overlapped: false, ended: false };
  if (activeSearchScopes.size > 0) { scope.overlapped = true; for (const other of activeSearchScopes) other.overlapped = true; }
  activeSearchScopes.add(scope);
  return {
    end() {
      if (!scope.ended) { scope.ended = true; activeSearchScopes.delete(scope); }
      return { ...scope, byClass: { ...scope.byClass }, bySize: { ...scope.bySize } };
    },
  };
}

/** Called by the proxy when a request starts. Returns the scopes to credit with its bytes and duration when it finishes. */
function creditSearchScopes(cls: LanceObjectClass, size: RangeSizeBucket): SearchReadScope[] {
  if (activeSearchScopes.size === 0) return [];
  const credited = [...activeSearchScopes];
  for (const scope of credited) {
    scope.requests++;
    scope.byClass[cls] = (scope.byClass[cls] ?? 0) + 1;
    scope.bySize[size] = (scope.bySize[size] ?? 0) + 1;
  }
  return credited;
}

/** Span attributes for one search's reads: totals plus one bounded `docslurp.lancedb.s3.requests.<class>` per class seen. */
export function searchReadAttributes(counts: SearchReadCounts): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    "docslurp.lancedb.s3.requests": counts.requests, "docslurp.lancedb.s3.bytes": counts.bytes,
    "docslurp.lancedb.s3.request_ms": Math.round(counts.requestMs), "docslurp.lancedb.s3.overlapped": counts.overlapped,
  };
  for (const cls of LANCE_OBJECT_CLASSES) if (counts.byClass[cls]) attributes[`docslurp.lancedb.s3.requests.${cls}`] = counts.byClass[cls]!;
  for (const size of RANGE_SIZE_BUCKETS) if (counts.bySize[size]) attributes[`docslurp.lancedb.s3.range.${size}`] = counts.bySize[size]!;
  return attributes;
}

/**
 * Runs a LanceDB search inside a dependency span that also carries the search's own S3 request counts by object class.
 * Counts are only non-zero when LANCEDB_S3_TRACE routes Lance through the proxy; attributes are omitted otherwise.
 */
export async function withLanceSearchSpan<T>(name: string, attributes: Record<string, string | number | boolean>, run: () => Promise<T>, stats: LanceS3Stats = lanceS3Stats): Promise<T> {
  const span = startDependencySpan(name, attributes);
  const reads = beginSearchReadScope();
  let failure: unknown;
  try { return await span.run(run); }
  catch (error) { failure = error; throw error; }
  finally {
    const counts = reads.end();
    if (counts.requests > 0) { span.set(searchReadAttributes(counts)); stats.recordSearch(counts); }
    span.end(failure);
  }
}

// ---- Counters ----------------------------------------------------------------------------------------------------

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

interface Aggregate { requests: number; errors: number; retries: number; bytesIn: number; bytesOut: number; hist: number[]; totalMs: number; ttfbMs: number }
const newAggregate = (): Aggregate => ({ requests: 0, errors: 0, retries: 0, bytesIn: 0, bytesOut: 0, hist: new Array(BUCKETS_MS.length + 1).fill(0), totalMs: 0, ttfbMs: 0 });

interface SearchAggregate { searches: number; overlapped: number; requests: number; byClass: Map<string, number> }
const newSearchAggregate = (): SearchAggregate => ({ searches: 0, overlapped: 0, requests: 0, byClass: new Map() });

export class LanceS3Stats {
  readonly cumulative = newAggregate();
  window = newAggregate();
  readonly byOperation = new Map<string, number>();
  readonly byStatus = new Map<string, number>();
  readonly windowByOperation = new Map<string, number>();
  readonly windowByStatus = new Map<string, number>();
  /** Set by the proxy when the disk cache is on; its counters join the summary line and snapshot. */
  cache: DiskBlockCache | undefined;
  /** Requests actually sent to the object store, by operation (client requests served from the cache are not included). */
  readonly upstreamByOperation = new Map<string, number>();
  windowUpstream = 0;
  upstreamTotal = 0;
  /** Requests the proxy refused (no caller secret, or a bucket it does not serve). Anything above zero deserves a look. */
  refused = 0;
  upstream(operation: string): void {
    this.upstreamByOperation.set(operation, (this.upstreamByOperation.get(operation) ?? 0) + 1);
    this.upstreamTotal++; this.windowUpstream++;
  }

  /** Searches that made at least one proxied request, with their requests by object class (window and cumulative). */
  windowSearch = newSearchAggregate();
  readonly cumulativeSearch = newSearchAggregate();

  recordSearch(counts: SearchReadCounts): void {
    for (const agg of [this.windowSearch, this.cumulativeSearch]) {
      agg.searches++;
      if (counts.overlapped) agg.overlapped++;
      agg.requests += counts.requests;
      for (const [cls, n] of Object.entries(counts.byClass)) agg.byClass.set(cls, (agg.byClass.get(cls) ?? 0) + n);
    }
  }

  record(sample: { operation: string; status: number | "error"; bytesIn: number; bytesOut: number; ttfbMs: number; totalMs: number; retry: boolean }): void {
    const bucket = BUCKETS_MS.findIndex((limit) => sample.totalMs <= limit);
    const index = bucket < 0 ? BUCKETS_MS.length : bucket;
    const failed = sample.status === "error" || sample.status >= 500;
    for (const [aggregate, ops, statuses] of [[this.cumulative, this.byOperation, this.byStatus], [this.window, this.windowByOperation, this.windowByStatus]] as const) {
      aggregate.requests++;
      if (failed) aggregate.errors++;
      if (sample.retry) aggregate.retries++;
      aggregate.bytesIn += sample.bytesIn;
      aggregate.bytesOut += sample.bytesOut;
      aggregate.hist[index]++;
      aggregate.totalMs += sample.totalMs;
      aggregate.ttfbMs += sample.ttfbMs;
      ops.set(sample.operation, (ops.get(sample.operation) ?? 0) + 1);
      const statusKey = `${sample.operation}:${sample.status}`;
      statuses.set(statusKey, (statuses.get(statusKey) ?? 0) + 1);
    }
  }

  snapshot() {
    return { ...summarize(this.cumulative), byOperation: Object.fromEntries(this.byOperation), byOperationStatus: Object.fromEntries(this.byStatus), histogramMsBuckets: BUCKETS_MS, histogram: [...this.cumulative.hist],
      searches: this.cumulativeSearch.searches, searchOverlapped: this.cumulativeSearch.overlapped, searchRequests: this.cumulativeSearch.requests, searchByClass: Object.fromEntries(this.cumulativeSearch.byClass),
      upstreamRequests: this.upstreamTotal, upstreamByOperation: Object.fromEntries(this.upstreamByOperation), ...(this.cache ? { cache: this.cache.snapshot() } : {}) };
  }

  /** One-line summary of the window since the last call; resets the window. */
  summaryLine(windowSeconds: number): string {
    const w = summarize(this.window);
    const fmt = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(",") || "none";
    const line = `[lancedb-s3] window=${windowSeconds}s requests=${w.requests} errors=${w.errors} retries=${w.retries} bytes_in=${w.bytesIn} bytes_out=${w.bytesOut} `
      + `avg_ms=${w.avgMs} avg_ttfb_ms=${w.avgTtfbMs} p50_ms=${w.p50Ms} p95_ms=${w.p95Ms} p99_ms=${w.p99Ms} ops=${fmt(this.windowByOperation)} statuses=${fmt(this.windowByStatus)} `
      + `total_requests=${this.cumulative.requests} upstream_requests=${this.windowUpstream} refused=${this.refused}`
      + (this.windowSearch.searches ? ` searches=${this.windowSearch.searches} search_overlapped=${this.windowSearch.overlapped} search_requests=${this.windowSearch.requests} search_by_class=${fmt(this.windowSearch.byClass)}` : "")
      + (this.cache ? ` ${this.cache.summaryFragment()}` : "");
    this.window = newAggregate();
    this.windowUpstream = 0;
    this.windowSearch = newSearchAggregate();
    this.windowByOperation.clear();
    this.windowByStatus.clear();
    return line;
  }
}

function quantile(hist: number[], q: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= q * total) return i < BUCKETS_MS.length ? BUCKETS_MS[i] : BUCKETS_MS[BUCKETS_MS.length - 1] * 2; // upper bucket bound
  }
  return 0;
}

function summarize(a: Aggregate) {
  const n = a.requests || 1;
  return { requests: a.requests, errors: a.errors, retries: a.retries, bytesIn: a.bytesIn, bytesOut: a.bytesOut, avgMs: Math.round(a.totalMs / n), avgTtfbMs: Math.round(a.ttfbMs / n),
    p50Ms: quantile(a.hist, 0.5), p95Ms: quantile(a.hist, 0.95), p99Ms: quantile(a.hist, 0.99) };
}

export const lanceS3Stats = new LanceS3Stats();
/** Cumulative counters for a debug endpoint. */
export function getLanceS3TraceStats() { return lanceS3Stats.snapshot(); }

// ---- Proxy ------------------------------------------------------------------------------------------------------

function providerFor(host: string): string {
  return host.endsWith("backblazeb2.com") ? "backblaze" : host.endsWith("tigris.dev") ? "tigris" : host.endsWith("r2.cloudflarestorage.com") ? "cloudflare-r2" : host.endsWith("amazonaws.com") ? "aws" : "s3-compatible";
}

/** First two key segments, hashed per segment would hide structure we want; truncate instead so spans stay bounded. */
export function keyPrefix(key: string): string {
  const parts = key.split("/");
  const prefix = parts.slice(0, 3).join("/");
  return prefix.length > 96 ? prefix.slice(0, 96) : prefix;
}

/** S3 allows 1,000 keys per bulk delete; Lance keys are well under 1 KiB each. */
const MAX_BULK_DELETE_BYTES = 2 * 1024 * 1024;

/** The whole request body, or undefined once it exceeds `limit` (the rest is left unread). */
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Object keys named by a DeleteObjects body. */
export function bulkDeleteKeys(body: Buffer): string[] {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const unescape = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
    name.startsWith("#x") || name.startsWith("#X") ? String.fromCodePoint(Number.parseInt(name.slice(2), 16))
      : name.startsWith("#") ? String.fromCodePoint(Number.parseInt(name.slice(1), 10))
        : entities[name.toLowerCase()] ?? whole);
  return [...body.toString("utf8").matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => unescape(match[1] ?? ""));
}

export interface LanceS3ProxyOptions { cache?: DiskBlockCache; endpoint?: string; region: string; credentials: Credentials; logIntervalMs?: number; /** `bucket/first-key-segment` roots the proxy may reach (`bucket/` for a whole bucket); omitted means any (tests). */ roots?: Iterable<string>; stats?: LanceS3Stats; log?: (line: string) => void; maxSockets?: number }
export interface LanceS3Proxy {
  /** Loopback address only; authentication is carried in a header, never in a URL. */
  endpoint: string;
  /** Ephemeral local credentials; never log these or pass them upstream. */
  credentials: Credentials & { sessionToken: string };
  /** The listener's address, safe for logs. */
  address: string;
  port: number;
  /** Let requests under this bucket and first key segment through ("" for the whole bucket). A proxy started with `roots` refuses everything else. */
  allowRoot(bucket: string, segment: string): void;
  close(): Promise<void>;
  stats: LanceS3Stats;
}

export async function startLanceS3Proxy(options: LanceS3ProxyOptions): Promise<LanceS3Proxy> {
  const upstreamUrl = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
  const target: UpstreamTarget = { protocol: upstreamUrl.protocol as "https:" | "http:", hostname: upstreamUrl.hostname, port: upstreamUrl.port || undefined, region: options.region };
  const provider = providerFor(upstreamUrl.hostname);
  const stats = options.stats ?? lanceS3Stats;
  const cache = options.cache;
  if (cache) stats.cache = cache;
  // Cached bytes and authorization leases belong to one credential identity.
  // A less privileged/revoked caller must never inherit another proxy's lease.
  const namespace = createHash("sha256").update(JSON.stringify([upstreamUrl.origin, options.region, options.credentials.accessKeyId, options.credentials.secretAccessKey, options.credentials.sessionToken ?? null])).digest("hex");
  const agentOptions = { keepAlive: true, noDelay: true, maxSockets: options.maxSockets ?? 256 };
  const agent = target.protocol === "https:" ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  // Fingerprints of recent failed requests: a repeat is almost certainly object_store's retry.
  const recentFailures = new Map<string, number>();
  const fingerprint = (req: IncomingMessage) => `${req.method} ${req.url} ${req.headers.range ?? ""}`;

  // object_store sends a session token in x-amz-security-token. Use an ephemeral local
  // bearer there rather than a path capability: native errors include URLs. The real
  // credentials stay here; signUpstreamRequest strips local auth before signing upstream.
  const credentials = { accessKeyId: "lance-loopback", secretAccessKey: randomBytes(32).toString("hex"), sessionToken: randomBytes(32).toString("hex") };
  const tokenBytes = Buffer.from(credentials.sessionToken);
  const roots = options.roots ? new Set(options.roots) : undefined;
  const refuse = (res: ServerResponse, reason: string, status = 403): void => {
    stats.refused += 1;
    res.writeHead(status, { "content-type": "text/plain", connection: "close" });
    res.end(`lancedb-s3 proxy refused: ${reason}`);
  };
  /** Whether `bucket` + `key` (still percent-encoded, as it will be sent) lies under an allowed root. Throws on malformed encoding. */
  const underRoot = (bucket: string, key: string): boolean => {
    if (!roots) return true;
    const segments = key.split("/").map((segment) => decodeURIComponent(segment));
    // The store, not this check, would resolve a dot segment: never forward one.
    if (segments.some((segment) => segment === "." || segment === "..") || bucket === "." || bucket === ".." || bucket.includes("/")) return false;
    return roots.has(`${bucket}/`) || roots.has(`${bucket}/${segments[0] ?? ""}`);
  };
  /** The request, and a copy source if it names one, stay inside the Lance roots this proxy was started for. */
  const allowed = (method: string, rawUrl: string, headers: IncomingHttpHeaders): boolean => {
    if (!roots) return true;
    const classified = classifyS3Request(method, rawUrl, headers);
    const source = headers["x-amz-copy-source"];
    if (source !== undefined) {
      if (typeof source !== "string") return false;
      const [sourcePath = ""] = source.replace(/^\//, "").split("?");
      const [sourceBucket = "", ...sourceKey] = sourcePath.split("/");
      if (!underRoot(decodeURIComponent(sourceBucket), sourceKey.join("/"))) return false;
    }
    if (classified.key) return underRoot(classified.bucket, classified.key);
    // Bucket-level requests: a bulk delete (its keys are checked one by one once its body is read), or a
    // listing of a prefix under an allowed root. Nothing else.
    if (classified.operation === "DeleteObjects") return [...roots].some((entry) => entry.startsWith(`${classified.bucket}/`));
    if (classified.operation !== "ListObjectsV2") return false;
    const prefix = classified.query.find(([name]) => name === "prefix")?.[1] ?? "";
    return underRoot(classified.bucket, prefix.split("/").map(encodeURIComponent).join("/"));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const incomingUrl = req.url ?? "/";
    const presentedToken = req.headers["x-amz-security-token"];
    const presented = Buffer.from(typeof presentedToken === "string" ? presentedToken : "");
    if (presented.length !== tokenBytes.length || !timingSafeEqual(presented, tokenBytes)) { req.resume(); return refuse(res, "caller not recognized"); }
    const rawUrl = incomingUrl;
    let inside: boolean;
    try { inside = allowed(method, rawUrl, req.headers); } catch { req.resume(); return refuse(res, "malformed request path", 400); }
    if (!inside) { req.resume(); return refuse(res, "outside this proxy's Lance roots"); }
    /** One signed, fully buffered upstream request for the cache. Only Range is forwarded, never client conditionals. */
    const bufferedUpstream = async (m: "GET" | "HEAD", range?: string): Promise<BufferedUpstream> => {
      const signed = await signUpstreamRequest(m, rawUrl, range ? { range } : {}, target, options.credentials);
      stats.upstream(m === "GET" ? "GetObject" : "HeadObject");
      return await new Promise<BufferedUpstream>((resolve, reject) => {
        const upstream = send({ agent, protocol: signed.protocol, hostname: signed.hostname, port: signed.port, method: m, path: signed.path, headers: signed.headers }, (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          const maxBytes = m === "HEAD" ? 64 * 1024 : Math.min(32 * 1024 * 1024, (cache?.maxSpanBlocks ?? 32) * (cache?.blockBytes ?? 1024 * 1024));
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) { response.destroy(new Error("S3 cache upstream response too large")); return; }
            chunks.push(chunk);
          });
          response.on("end", () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on("error", reject);
        });
        upstream.setTimeout(15_000, () => upstream.destroy(new Error("S3 cache upstream timeout")));
        upstream.on("error", reject);
        upstream.end();
      });
    };
    const classified = classifyS3Request(method, rawUrl, req.headers);
    const finger = fingerprint(req);
    const failedAt = recentFailures.get(finger);
    const retry = failedAt !== undefined && Date.now() - failedAt < 120_000;
    const condition = req.headers["if-none-match"] !== undefined ? "if-none-match" : req.headers["if-match"] !== undefined ? "if-match" : undefined;
    const started = performance.now();
    const objectClass = lanceObjectClass(classified.operation, classified.key);
    const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const credited = creditSearchScopes(objectClass, rangeSizeBucket(rangeHeader));
    const span = startDependencySpan(`lancedb.s3.${classified.operation}`, {
      "docslurp.lancedb.object_class": objectClass,
      "docslurp.storage.system": "lancedb-s3", "rpc.system": "aws-api", "rpc.service": "S3", "rpc.method": classified.operation,
      "docslurp.dependency.type": "s3", "docslurp.dependency.provider": provider, "docslurp.dependency.operation": classified.operation, "docslurp.dependency.phase": "native",
      "server.address": target.hostname, "aws.s3.bucket": classified.bucket, "docslurp.s3.key_prefix": keyPrefix(classified.key),
      "http.request.method": method, "http.request.header.range": typeof req.headers.range === "string" ? req.headers.range : undefined,
      "docslurp.s3.condition": condition, "http.request.resend_count": retry ? 1 : undefined, "docslurp.lancedb_s3.retry_suspected": retry,
    });
    let bytesIn = 0, bytesOut = 0, ttfbMs = 0, status: number | "error" = "error", finished = false;
    let cacheOutcome: string | undefined, cacheBytes = 0, cacheFilled = 0, cacheUpstream = 0;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      const totalMs = performance.now() - started;
      span.set({ "http.request.body.size": bytesIn, "http.response.body.size": bytesOut, "docslurp.s3.ttfb_ms": Math.round(ttfbMs), "docslurp.s3.duration_ms": Math.round(totalMs), ...(typeof status === "number" ? { "http.response.status_code": status } : {}),
        ...(cacheOutcome ? { "docslurp.lancedb_s3.cache": cacheOutcome, "docslurp.lancedb_s3.cache.bytes_served": cacheBytes, "docslurp.lancedb_s3.cache.bytes_filled": cacheFilled, "docslurp.lancedb_s3.cache.upstream_requests": cacheUpstream } : {}) });
      const failed = status === "error" || status >= 500 || status === 429;
      if (failed) recentFailures.set(finger, Date.now()); else recentFailures.delete(finger);
      if (recentFailures.size > 1000) for (const [k, t] of recentFailures) if (Date.now() - t > 120_000) recentFailures.delete(k);
      for (const scope of credited) { scope.bytes += bytesOut; scope.requestMs += totalMs; }
      stats.record({ operation: classified.operation, status, bytesIn, bytesOut, ttfbMs, totalMs, retry });
      span.end(error ?? (status === "error" ? new Error("aborted") : undefined));
    };
    try {
      if (cache && (objectClass === "data" || objectClass === "indices") && isImmutableLanceKey(classified.key) && classified.query.length === 0) {
        if ((classified.operation === "GetObject" || classified.operation === "HeadObject") && !(req.headers.range && classified.operation === "HeadObject")) {
          res.on("close", () => { if (!finished) finish(new Error("client closed")); });
          const fetchUpstream = (m: "GET" | "HEAD", range?: string) => bufferedUpstream(m, range);
          const result = await serveCachedRequest({ cache, namespace, method, bucket: classified.bucket, key: classified.key, headers: req.headers, fetchUpstream });
          if (result.kind === "response") {
            cacheOutcome = result.outcome; cacheBytes = result.bytesFromCache; cacheFilled = result.bytesFilled; cacheUpstream = result.upstreamRequests;
            status = result.status; ttfbMs = performance.now() - started; bytesOut = result.body.length;
            res.writeHead(status, { ...result.headers, "x-docslurp-cache": result.outcome });
            res.end(method === "HEAD" ? undefined : result.body);
            finish();
            return;
          }
          cacheOutcome = "bypass";
        } else if (classified.operation === "PutObject" || classified.operation === "DeleteObject" || classified.operation === "CopyObject") {
          // Lance never rewrites these paths, but a write or delete through the proxy must not leave a stale copy behind.
          await invalidateCachedObject(cache, namespace, classified.bucket, classified.key);
        }
      }
      // A bulk delete names its keys in the body: hold each to the roots, and drop any cached copy.
      let bulkDelete: Buffer | undefined;
      if (classified.operation === "DeleteObjects") {
        bulkDelete = await readBody(req, MAX_BULK_DELETE_BYTES);
        const keys = bulkDelete ? bulkDeleteKeys(bulkDelete) : undefined;
        if (!keys?.length || !keys.every((key) => underRoot(classified.bucket, key.split("/").map(encodeURIComponent).join("/")))) {
          req.resume();
          refuse(res, keys ? "bulk delete outside this proxy's Lance roots" : "bulk delete body too large");
          status = 403;
          finish();
          return;
        }
        if (cache) for (const key of keys) if (isImmutableLanceKey(key)) await invalidateCachedObject(cache, namespace, classified.bucket, key);
        bytesIn += bulkDelete!.length;
      }
      const signed = await signUpstreamRequest(method, rawUrl, req.headers, target, options.credentials);
      stats.upstream(classified.operation);
      const upstream = send({ agent, protocol: signed.protocol, hostname: signed.hostname, port: signed.port, method, path: signed.path, headers: signed.headers }, (response) => {
        ttfbMs = performance.now() - started;
        status = response.statusCode ?? 502;
        const outHeaders = { ...response.headers };
        delete outHeaders.connection; delete outHeaders["keep-alive"];
        res.writeHead(status, response.statusMessage, outHeaders);
        response.on("data", (chunk: Buffer) => { bytesOut += chunk.length; });
        response.on("end", () => finish());
        response.on("error", (error) => { status = "error"; finish(error); res.destroy(error); });
        response.pipe(res);
      });
      upstream.setTimeout(15_000, () => upstream.destroy(new Error("S3 proxy upstream timeout")));
      upstream.on("error", (error) => {
        if (res.headersSent) { res.destroy(error); finish(error); return; }
        status = "error";
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`lancedb-s3 trace proxy upstream error: ${error.message}`);
        finish(error);
      });
      req.on("data", (chunk: Buffer) => { bytesIn += chunk.length; });
      req.on("aborted", () => { upstream.destroy(); finish(new Error("client aborted")); });
      res.on("close", () => { if (!finished) { upstream.destroy(); finish(new Error("client closed")); } });
      if (bulkDelete) upstream.end(bulkDelete); else req.pipe(upstream);
    } catch (error) {
      status = "error";
      if (!res.headersSent) { res.writeHead(502, { "content-type": "text/plain" }); res.end(`lancedb-s3 trace proxy error: ${error instanceof Error ? error.message : String(error)}`); }
      finish(error);
    }
  };

  const server: Server = createServer({ noDelay: true, keepAlive: true }, (req, res) => { void handle(req, res); });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as AddressInfo).port;
  const intervalMs = options.logIntervalMs ?? 60_000;
  const log = options.log ?? ((line: string) => console.log(line));
  const timer = intervalMs > 0 ? setInterval(() => log(stats.summaryLine(Math.round(intervalMs / 1000))), intervalMs) : undefined;
  timer?.unref();
  // Bound retention of untouched deleted objects too: they otherwise never get
  // a read-time validation and could remain on disk until space eviction.
  const cacheTimer = cache ? setInterval(() => { void cache.expireIdleObjects().catch(() => undefined); }, 30_000) : undefined;
  cacheTimer?.unref();
  server.unref();
  return {
    credentials, endpoint: `http://127.0.0.1:${port}`, address: `http://127.0.0.1:${port}`, port, stats,
    allowRoot: (bucket: string, segment: string) => { roots?.add(`${bucket}/${segment}`); },
    close: async () => { if (timer) clearInterval(timer); if (cacheTimer) clearInterval(cacheTimer); agent.destroy(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}

// ---- Wiring ------------------------------------------------------------------------------------------------------

export function lanceS3TraceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.LANCEDB_S3_TRACE?.trim() ?? "");
}

/** The proxy runs when tracing or the disk cache is on. */
export function lanceS3ProxyEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return lanceS3TraceEnabled(env) || lanceS3CacheConfig(env) !== undefined;
}

const ENDPOINT_KEYS = [
  "endpoint", "endpoint_url", "aws_endpoint", "aws_endpoint_url", "aws_endpoint_url_s3", "allow_http", "aws_allow_http",
  "virtual_hosted_style_request", "aws_virtual_hosted_style_request",
  // A forward proxy option would carry the loopback requests off the host.
  "proxy_url", "proxy_ca_certificate", "proxy_excludes", "aws_proxy_url", "aws_proxy_ca_certificate", "aws_proxy_excludes",
];

/**
 * An HTTP forward proxy from the environment that would also take requests for 127.0.0.1, read the way
 * Lance's HTTP client reads it (lancedb 0.41): NO_PROXY when it is set at all, even empty, otherwise
 * no_proxy; and only a literal 127.0.0.1 entry counts, since that client does not honour "*" for it.
 */
function forwardProxyForLoopback(env: Record<string, string | undefined>): string | undefined {
  const name = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].find((candidate) => env[candidate]?.trim());
  if (!name) return undefined;
  const excluded = (env.NO_PROXY !== undefined ? env.NO_PROXY : env.no_proxy ?? "").split(",").map((entry) => entry.trim());
  return excluded.includes("127.0.0.1") ? undefined : name;
}

function originOf(endpoint: string): string {
  try { return new URL(endpoint).origin; } catch { return "(unparsable endpoint)"; }
}

const usableCaches = new Map<string, Promise<DiskBlockCache | undefined>>();
/** The shared disk cache once its directory is usable; undefined (logged once, loudly) when it is not: reads then go uncached. */
function usableDiskCache(config: NonNullable<ReturnType<typeof lanceS3CacheConfig>>): Promise<DiskBlockCache | undefined> {
  let usable = usableCaches.get(config.dir);
  if (!usable) {
    const cache = sharedDiskBlockCache(config);
    usable = cache.ready.then(() => cache, (error: unknown) => {
      console.error(`[lancedb-s3] disk cache ${config.dir} is unusable, searching WITHOUT it: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    usableCaches.set(config.dir, usable);
  }
  return usable;
}
const proxies = new Map<string, Promise<LanceS3Proxy>>();

function option(options: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) for (const [key, value] of Object.entries(options)) if (key.toLowerCase() === name) return value;
  return undefined;
}

/**
 * Storage options that send Lance to a local proxy at `proxied` instead of the store's own endpoint.
 * Lance reads AWS_ENDPOINT_URL_S3 from the process environment and prefers it to `endpoint`, so a host that
 * sets it (common with S3-compatible stores) would send every request past the proxy: tracing and the disk
 * cache would see nothing. The option of the same name wins over the variable (lancedb 0.41;
 * lancedb-s3-proxy-env.test.ts holds it to that).
 */
export function lanceS3ProxyStorageOptions(storageOptions: Record<string, string>, proxied: string, credentials: Credentials & { sessionToken: string }): Record<string, string> {
  const next = Object.fromEntries(Object.entries(storageOptions).filter(([name]) => !ENDPOINT_KEYS.includes(name.toLowerCase()) && !["aws_access_key_id", "access_key_id", "aws_secret_access_key", "secret_access_key", "aws_session_token", "session_token", "aws_skip_signature", "skip_signature"].includes(name.toLowerCase())));
  return { ...next, aws_access_key_id: credentials.accessKeyId, aws_secret_access_key: credentials.secretAccessKey, aws_session_token: credentials.sessionToken, aws_skip_signature: "false", endpoint: proxied, aws_endpoint_url_s3: proxied, allow_http: "true", virtual_hosted_style_request: "false" };
}

/**
 * When LANCEDB_S3_TRACE or LANCEDB_S3_CACHE_DIR is set and the Lance root is s3:// (or s3+ddb://, whose data store
 * is S3), returns storage options that route Lance through the local proxy (started once per upstream endpoint and
 * credential set). Otherwise returns the options unchanged.
 */
export async function withLanceS3Proxy(uri: string, storageOptions: Record<string, string> | undefined, env: Record<string, string | undefined> = process.env): Promise<Record<string, string> | undefined> {
  if (!storageOptions || !lanceS3ProxyEnabled(env) || !/^s3(a|\+ddb)?:\/\//.test(uri)) return storageOptions;
  const accessKeyId = option(storageOptions, "aws_access_key_id", "access_key_id") ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = option(storageOptions, "aws_secret_access_key", "secret_access_key") ?? env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    console.warn("[lancedb-s3] LANCEDB_S3_TRACE / LANCEDB_S3_CACHE_DIR need explicit credentials (storage URI userinfo or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY); proxy, tracing and cache disabled");
    return storageOptions;
  }
  const sessionToken = option(storageOptions, "aws_session_token", "session_token") ?? env.AWS_SESSION_TOKEN;
  const region = option(storageOptions, "region", "aws_region") ?? env.AWS_REGION ?? "us-east-1";
  const forwardProxy = forwardProxyForLoopback(env);
  if (forwardProxy) {
    console.warn(`[lancedb-s3] ${forwardProxy} is set and NO_PROXY does not list 127.0.0.1: Lance would send its loopback requests to that proxy; proxy, tracing and cache disabled`);
    return storageOptions;
  }
  // The endpoint a direct Lance connection would use, in Lance's own order (lancedb 0.41, observed): turning
  // the proxy on must never send this store's credentials, or its reads and writes, to a different host.
  const endpoint = env.AWS_ENDPOINT_URL_S3?.trim()
    || option(storageOptions, "aws_endpoint_url_s3", "endpoint", "endpoint_url", "aws_endpoint", "aws_endpoint_url")
    || env.AWS_ENDPOINT?.trim() || env.AWS_ENDPOINT_URL?.trim() || undefined;
  const root = /^s3(?:a|\+ddb)?:\/\/([^/?]+)\/?([^/?]*)/.exec(uri);
  if (!root?.[1]) return storageOptions;
  const key = JSON.stringify([endpoint ?? null, region, accessKeyId, secretAccessKey, sessionToken ?? null]);
  let proxy = proxies.get(key);
  if (!proxy) {
    const cacheConfig = lanceS3CacheConfig(env);
    proxy = (cacheConfig ? usableDiskCache(cacheConfig) : Promise.resolve(undefined)).then((cache) => startLanceS3Proxy({ endpoint, region, credentials: { accessKeyId, secretAccessKey, sessionToken }, cache, roots: [] }));
    proxy.catch(() => proxies.delete(key));
    proxies.set(key, proxy);
    void proxy.then((started) => console.log(`[lancedb-s3] proxy ${started.address} -> ${endpoint ? originOf(endpoint) : `https://s3.${region}.amazonaws.com`} (path-style, summary every 60s${cacheConfig ? `, disk cache ${cacheConfig.dir} max ${(cacheConfig.maxBytes / 1024 ** 3).toFixed(1)} GB block ${cacheConfig.blockBytes / 1024} KB` : ""})`));
  }
  const started = await proxy;
  started.allowRoot(root[1], root[2] ?? "");
  return lanceS3ProxyStorageOptions(storageOptions, started.endpoint, started.credentials);
}
