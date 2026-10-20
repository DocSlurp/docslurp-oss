// Server-only. Opt-in tracing proxy for LanceDB's native (Rust object_store) S3 traffic.
import { createHash, createHmac } from "node:crypto";
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

// ---- Counters ----------------------------------------------------------------------------------------------------

const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

interface Aggregate { requests: number; errors: number; retries: number; bytesIn: number; bytesOut: number; hist: number[]; totalMs: number; ttfbMs: number }
const newAggregate = (): Aggregate => ({ requests: 0, errors: 0, retries: 0, bytesIn: 0, bytesOut: 0, hist: new Array(BUCKETS_MS.length + 1).fill(0), totalMs: 0, ttfbMs: 0 });

export class LanceS3Stats {
  readonly cumulative = newAggregate();
  window = newAggregate();
  readonly byOperation = new Map<string, number>();
  readonly byStatus = new Map<string, number>();
  readonly windowByOperation = new Map<string, number>();
  readonly windowByStatus = new Map<string, number>();
  /** Set by the proxy when the disk cache is on; its counters join the summary line and snapshot. */
  cache: DiskBlockCache | undefined;

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
    return { ...summarize(this.cumulative), byOperation: Object.fromEntries(this.byOperation), byOperationStatus: Object.fromEntries(this.byStatus), histogramMsBuckets: BUCKETS_MS, histogram: [...this.cumulative.hist], ...(this.cache ? { cache: this.cache.snapshot() } : {}) };
  }

  /** One-line summary of the window since the last call; resets the window. */
  summaryLine(windowSeconds: number): string {
    const w = summarize(this.window);
    const fmt = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(",") || "none";
    const line = `[lancedb-s3] window=${windowSeconds}s requests=${w.requests} errors=${w.errors} retries=${w.retries} bytes_in=${w.bytesIn} bytes_out=${w.bytesOut} `
      + `avg_ms=${w.avgMs} avg_ttfb_ms=${w.avgTtfbMs} p50_ms=${w.p50Ms} p95_ms=${w.p95Ms} p99_ms=${w.p99Ms} ops=${fmt(this.windowByOperation)} statuses=${fmt(this.windowByStatus)} `
      + `total_requests=${this.cumulative.requests}${this.cache ? ` ${this.cache.summaryFragment()}` : ""}`;
    this.window = newAggregate();
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

export interface LanceS3ProxyOptions { cache?: DiskBlockCache; endpoint?: string; region: string; credentials: Credentials; logIntervalMs?: number; stats?: LanceS3Stats; log?: (line: string) => void; maxSockets?: number }
export interface LanceS3Proxy { endpoint: string; port: number; close(): Promise<void>; stats: LanceS3Stats }

export async function startLanceS3Proxy(options: LanceS3ProxyOptions): Promise<LanceS3Proxy> {
  const upstreamUrl = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
  const target: UpstreamTarget = { protocol: upstreamUrl.protocol as "https:" | "http:", hostname: upstreamUrl.hostname, port: upstreamUrl.port || undefined, region: options.region };
  const provider = providerFor(upstreamUrl.hostname);
  const stats = options.stats ?? lanceS3Stats;
  const cache = options.cache;
  if (cache) stats.cache = cache;
  const namespace = `${upstreamUrl.hostname}:${upstreamUrl.port}`;
  const agentOptions = { keepAlive: true, noDelay: true, maxSockets: options.maxSockets ?? 256 };
  const agent = target.protocol === "https:" ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  // Fingerprints of recent failed requests: a repeat is almost certainly object_store's retry.
  const recentFailures = new Map<string, number>();
  const fingerprint = (req: IncomingMessage) => `${req.method} ${req.url} ${req.headers.range ?? ""}`;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    /** One signed, fully buffered upstream request for the cache. Only Range is forwarded, never client conditionals. */
    const bufferedUpstream = async (m: "GET" | "HEAD", range?: string): Promise<BufferedUpstream> => {
      const signed = await signUpstreamRequest(m, rawUrl, range ? { range } : {}, target, options.credentials);
      return await new Promise<BufferedUpstream>((resolve, reject) => {
        const upstream = send({ agent, protocol: signed.protocol, hostname: signed.hostname, port: signed.port, method: m, path: signed.path, headers: signed.headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on("error", reject);
        });
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
    const span = startDependencySpan(`lancedb.s3.${classified.operation}`, {
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
      stats.record({ operation: classified.operation, status, bytesIn, bytesOut, ttfbMs, totalMs, retry });
      span.end(error ?? (status === "error" ? new Error("aborted") : undefined));
    };
    try {
      if (cache && isImmutableLanceKey(classified.key) && classified.query.length === 0) {
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
      const signed = await signUpstreamRequest(method, rawUrl, req.headers, target, options.credentials);
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
      req.pipe(upstream);
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
  server.unref();
  return {
    endpoint: `http://127.0.0.1:${port}`, port, stats,
    close: async () => { if (timer) clearInterval(timer); agent.destroy(); await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); },
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

const ENDPOINT_KEYS = ["endpoint", "aws_endpoint", "aws_endpoint_url", "allow_http", "aws_allow_http", "virtual_hosted_style_request", "aws_virtual_hosted_style_request"];
const proxies = new Map<string, Promise<LanceS3Proxy>>();

function option(options: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) for (const [key, value] of Object.entries(options)) if (key.toLowerCase() === name) return value;
  return undefined;
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
  const endpoint = option(storageOptions, "endpoint", "aws_endpoint", "aws_endpoint_url");
  const key = JSON.stringify([endpoint ?? null, region, accessKeyId, secretAccessKey, sessionToken ?? null]);
  let proxy = proxies.get(key);
  if (!proxy) {
    const cacheConfig = lanceS3CacheConfig(env);
    proxy = startLanceS3Proxy({ endpoint, region, credentials: { accessKeyId, secretAccessKey, sessionToken }, cache: cacheConfig ? sharedDiskBlockCache(cacheConfig) : undefined });
    proxy.catch(() => proxies.delete(key));
    proxies.set(key, proxy);
    void proxy.then((started) => console.log(`[lancedb-s3] proxy ${started.endpoint} -> ${endpoint ?? `https://s3.${region}.amazonaws.com`} (path-style, summary every 60s${cacheConfig ? `, disk cache ${cacheConfig.dir} max ${(cacheConfig.maxBytes / 1024 ** 3).toFixed(1)} GB block ${cacheConfig.blockBytes / 1024} KB` : ""})`));
  }
  const { endpoint: proxied } = await proxy;
  const next = Object.fromEntries(Object.entries(storageOptions).filter(([name]) => !ENDPOINT_KEYS.includes(name.toLowerCase())));
  return { ...next, endpoint: proxied, allow_http: "true", virtual_hosted_style_request: "false" };
}
