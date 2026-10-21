import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { detectImageLayoutAtEndpoint, type ImageLayoutEndpointOptions, type ImageLayoutResult } from "./image-layout.js";

export interface RoutingLayoutObserverConfig extends Omit<ImageLayoutEndpointOptions, "onRequest"> {
  expectedArtifactSha256: string;
  timeoutMs: number;
  maxPages: number;
  maxBytes: number;
  concurrency: number;
  queueCapacity: number;
  /** Unknown compute pricing must remain null, never silently become free. */
  hourlyCostUsd: number | null;
}

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}: expected integer ${min}..${max}`);
  return parsed;
}

/** Operator-only configuration. Invalid enabled configuration fails closed at startup. */
export function readLayoutObserverConfig(env: NodeJS.ProcessEnv = process.env): RoutingLayoutObserverConfig | null {
  const mode = env.PAGE_ROUTER_LAYOUT ?? "off";
  if (mode === "off") return null;
  if (mode !== "shadow") throw new Error("PAGE_ROUTER_LAYOUT must be off or shadow");
  const required = (suffix: string): string => {
    const value = env[`PAGE_ROUTER_LAYOUT_${suffix}`]?.trim();
    if (!value) throw new Error(`PAGE_ROUTER_LAYOUT_${suffix} is required in shadow mode`);
    return value;
  };
  const endpoint = required("ENDPOINT");
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/layout" || url.search || url.hash) {
    throw new Error("Layout endpoint must be http://127.0.0.1:<port>/layout with no credentials or query");
  }
  const expectedArtifactSha256 = required("ARTIFACT_SHA256");
  if (!/^[0-9a-f]{64}$/.test(expectedArtifactSha256)) throw new Error("Invalid layout artifact SHA256");
  const device = env.PAGE_ROUTER_LAYOUT_DEVICE ?? "cpu";
  if (device !== "cpu" && device !== "cuda") throw new Error("Invalid layout device");
  const rawCost = env.PAGE_ROUTER_LAYOUT_HOURLY_COST_USD;
  const hourlyCostUsd = rawCost === undefined ? null : Number(rawCost);
  if (hourlyCostUsd !== null && (!rawCost?.trim() || !Number.isFinite(hourlyCostUsd) || hourlyCostUsd <= 0)) {
    throw new Error("Layout hourly cost must be a positive finite USD amount or omitted");
  }
  return {
    endpoint, expectedModelId: required("MODEL_ID"), expectedRevision: required("REVISION"), expectedArtifactSha256, device,
    timeoutMs: integer(env.PAGE_ROUTER_LAYOUT_TIMEOUT_MS, 2000, 1, 60_000, "layout timeout"),
    maxPages: integer(env.PAGE_ROUTER_LAYOUT_MAX_PAGES, 4, 1, 100, "layout maximum pages"),
    maxBytes: integer(env.PAGE_ROUTER_LAYOUT_MAX_BYTES, 25 * 1024 * 1024, 1, 25 * 1024 * 1024, "layout maximum bytes"),
    concurrency: integer(env.PAGE_ROUTER_LAYOUT_CONCURRENCY, 1, 1, 8, "layout concurrency"),
    queueCapacity: integer(env.PAGE_ROUTER_LAYOUT_QUEUE_CAPACITY, 8, 0, 64, "layout queue capacity"),
    hourlyCostUsd,
  };
}

export interface RoutingLayoutObservation {
  result: ImageLayoutResult;
  /** True only for a completed cached result, not a joined in-flight request. */
  cacheHit: boolean;
  /** True only for the caller that created this successful service job. */
  inferencePerformed: boolean;
  /** Unique opaque ID per service job; cached results retain their original ID. */
  inferenceKey: string;
  elapsedMs: number;
  inputBytes: number;
}
interface Job {
  inferenceKey: string;
  onRequest?: (event: { inferenceKey: string; inputBytes: number }) => void;
  key: string;
  payload: Buffer;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (reason: unknown) => void;
  waiters: number;
  settled: boolean;
}

/**
 * Per-worker bounded shadow observer; never changes routing decisions.
 * Single-flight work has one deadline starting at enqueue, including queue time.
 * Each caller may cancel independently. Work is cancelled when its last caller
 * leaves; joining a job does not extend its original deadline. Cache stores JSON
 * so callers cannot mutate other callers' results. No source bytes are cached.
 * Aborting HTTP does not guarantee that the resident Python process stops inference.
 * A cancelled creator has no successful usage receipt; callers must retain failures
 * as unknown compute, and must not interpret absence of a receipt as zero usage.
 * onRequest belongs to the creator and runs once immediately before HTTP dispatch,
 * including attempts that later fail. Cache hits and joining callers do not invoke
 * it. A synchronous callback exception prevents dispatch (accounting fails closed).
 * maxPages is enforced by the calling stage, since only it knows page ownership.
 */
export class RoutingLayoutObserver {
  readonly config: Readonly<RoutingLayoutObserverConfig>;
  private readonly identity: string;
  private readonly cache = new Map<string, { json: string; bytes: number; inferenceKey: string }>();
  private cacheBytes = 0;
  private readonly jobs = new Map<string, Job>();
  private readonly queue: Job[] = [];
  private active = 0;

  constructor(config: RoutingLayoutObserverConfig) {
    // Validate programmatic construction through the same strict operator boundary.
    this.config = Object.freeze(readLayoutObserverConfig({
      PAGE_ROUTER_LAYOUT: "shadow", PAGE_ROUTER_LAYOUT_ENDPOINT: config.endpoint,
      PAGE_ROUTER_LAYOUT_MODEL_ID: config.expectedModelId, PAGE_ROUTER_LAYOUT_REVISION: config.expectedRevision,
      PAGE_ROUTER_LAYOUT_ARTIFACT_SHA256: config.expectedArtifactSha256, PAGE_ROUTER_LAYOUT_DEVICE: config.device,
      PAGE_ROUTER_LAYOUT_TIMEOUT_MS: String(config.timeoutMs), PAGE_ROUTER_LAYOUT_MAX_PAGES: String(config.maxPages),
      PAGE_ROUTER_LAYOUT_MAX_BYTES: String(config.maxBytes), PAGE_ROUTER_LAYOUT_CONCURRENCY: String(config.concurrency),
      PAGE_ROUTER_LAYOUT_QUEUE_CAPACITY: String(config.queueCapacity),
      ...(config.hourlyCostUsd === null ? {} : { PAGE_ROUTER_LAYOUT_HOURLY_COST_USD: String(config.hourlyCostUsd) }),
    })!);
    this.identity = JSON.stringify(this.config);
  }

  async observe({ scopeKey, payload, signal, onRequest }: { scopeKey: string; payload: Buffer; signal?: AbortSignal; onRequest?: (event: { inferenceKey: string; inputBytes: number }) => void }): Promise<RoutingLayoutObservation> {
    const started = performance.now();
    if (!scopeKey.trim() || scopeKey.length > 1024) throw new Error("Layout observation requires a bounded tenant scope key");
    if (signal?.aborted) throw signal.reason ?? new Error("Layout observation aborted");
    if (!payload.byteLength || payload.byteLength > this.config.maxBytes) throw new Error("Layout observation payload exceeds configured byte bounds");
    const key = createHash("sha256").update(JSON.stringify([scopeKey, this.identity])).update(payload).digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { result: JSON.parse(cached.json) as ImageLayoutResult, cacheHit: true, inferencePerformed: false, inferenceKey: cached.inferenceKey, elapsedMs: performance.now() - started, inputBytes: payload.byteLength };
    }
    let job = this.jobs.get(key);
    const inferencePerformed = !job;
    if (!job) {
      if (this.active >= this.config.concurrency && this.queue.length >= this.config.queueCapacity) throw new Error("Layout observation queue is full");
      let resolve!: Job["resolve"];
      let reject!: Job["reject"];
      const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      const controller = new AbortController();
      job = { key, inferenceKey: randomUUID(), onRequest, payload: Buffer.from(payload), controller, promise, resolve, reject, waiters: 0, settled: false,
        timer: setTimeout(() => controller.abort(new Error("Layout observation deadline exceeded")), this.config.timeoutMs) };
      this.jobs.set(key, job);
      const current = job;
      controller.signal.addEventListener("abort", () => this.finish(current, undefined, controller.signal.reason), { once: true });
      this.queue.push(job);
    }
    const current = job;
    current.waiters++;
    const result = new Promise<string>((resolve, reject) => {
      const aborted = () => reject(signal?.reason ?? new Error("Layout observation aborted"));
      signal?.addEventListener("abort", aborted, { once: true });
      current.promise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", aborted));
    });
    this.drain();
    try {
      const json = await result;
      return { result: JSON.parse(json) as ImageLayoutResult, cacheHit: false, inferencePerformed, inferenceKey: current.inferenceKey, elapsedMs: performance.now() - started, inputBytes: payload.byteLength };
    } finally {
      current.waiters--;
      if (!current.waiters && !current.settled) current.controller.abort(new Error("Layout observation has no remaining callers"));
    }
  }

  private drain(): void {
    while (this.active < this.config.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.settled) continue;
      this.active++;
      void detectImageLayoutAtEndpoint(job.payload, { ...this.config, onRequest: () => job.onRequest?.({ inferenceKey: job.inferenceKey, inputBytes: job.payload.byteLength }) }, job.controller.signal)
        .then((result) => this.finish(job, JSON.stringify(result)), (error: unknown) => this.finish(job, undefined, error))
        .finally(() => { this.active--; this.drain(); });
    }
  }

  private finish(job: Job, json?: string, error?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
    const queued = this.queue.indexOf(job);
    if (queued >= 0) this.queue.splice(queued, 1);
    if (json !== undefined) {
      const bytes = Buffer.byteLength(json);
      if (bytes <= 16 * 1024 * 1024) {
        while (this.cache.size >= 64 || this.cacheBytes + bytes > 16 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value!;
          this.cacheBytes -= this.cache.get(oldest)!.bytes;
          this.cache.delete(oldest);
        }
        this.cache.set(job.key, { json, bytes, inferenceKey: job.inferenceKey });
        this.cacheBytes += bytes;
      }
      job.resolve(json);
    } else job.reject(error ?? new Error("Layout observation failed"));
  }
}
