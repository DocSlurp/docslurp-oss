import { availableParallelism } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

/**
 * Local (transformers.js) embedding inference on a worker thread.
 *
 * onnxruntime-node runs `InferenceSession.run` synchronously on the calling
 * thread (its async `run` only defers the native call with setImmediate). On
 * the worker's main thread one BGE-M3 batch on a busy CPU blocked the event
 * loop for seconds to minutes: Temporal heartbeats, workflow tasks, run
 * heartbeats and Postgres connects all stalled (`write CONNECT_TIMEOUT`,
 * embed activities TIMED_OUT, internal research notes).
 * Here the model loads and runs in a bounded pool of dedicated threads
 * (`LocalEmbeddingPool`, DOCSLURP_LOCAL_EMBED_THREADS); each thread owns one
 * loaded model and runs one batch at a time, and concurrent documents queue
 * for a free thread instead of each loading or using their own session. The
 * main thread only posts texts and receives vectors, so it stays responsive.
 * ONNX Runtime's intra-op threads are capped per pool thread
 * (DOCSLURP_LOCAL_EMBED_INTRA_OP_THREADS, default cpus / pool size) so N
 * threads do not oversubscribe the machine.
 *
 * Each thread keeps at most one model loaded (a request for another model
 * replaces it), so memory stays at pool size x one model however many distinct
 * models the workspaces ask for. Results carry the thread's own measured model
 * load and run times, so callers' batch tuning and logs exclude queue wait.
 *
 * DOCSLURP_LOCAL_EMBED_THREAD=off restores in-process inference. If no
 * thread can start, the process falls back to in-process inference too.
 */

export interface ThreadEmbeddingRequest {
  model: string;
  /** Dtypes to try in order (the preferred one, then fp32). */
  dtypes: string[];
  cacheDir: string;
  /** Empty: only load the model (reports dtype and cacheHit). */
  texts: string[];
  normalize: boolean;
  /** Token pooling for the route (`?pooling=`); mean when absent. */
  pooling?: "mean" | "cls";
}

export interface ThreadEmbeddingResult {
  data: Float32Array;
  dims: number[];
  dtype: string;
  cacheHit: boolean;
  /** Time the thread spent loading the model for this request (0 when already loaded). */
  loadMs: number;
  /** Time the thread spent in the inference call itself, excluding queue wait and load. */
  runMs: number;
}

export function localEmbeddingThreadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.DOCSLURP_LOCAL_EMBED_THREAD ?? "on").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(value);
}

const MAX_POOL_SIZE = 16;

/** Threads in the pool: DOCSLURP_LOCAL_EMBED_THREADS, else min(2, cpus / 4), at least 1. */
export function localEmbeddingPoolSize(
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): number {
  const configured = Number(env.DOCSLURP_LOCAL_EMBED_THREADS);
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, MAX_POOL_SIZE);
  return Math.max(1, Math.min(2, Math.floor(cpus / 4)));
}

/** ONNX Runtime intra-op threads per pool thread: DOCSLURP_LOCAL_EMBED_INTRA_OP_THREADS, else cpus / pool size. */
export function localEmbeddingIntraOpThreads(
  poolSize: number,
  env: NodeJS.ProcessEnv = process.env,
  cpus: number = availableParallelism(),
): number {
  const configured = Number(env.DOCSLURP_LOCAL_EMBED_INTRA_OP_THREADS);
  if (Number.isInteger(configured) && configured >= 1) return configured;
  return Math.max(1, Math.floor(cpus / Math.max(1, poolSize)));
}

// An ES module served as a data: URL, so it needs no build step or file path
// (tsx, vitest and the compiled worker all load it the same way).
const THREAD_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
const transformers = await import(workerData.moduleUrl);
// One loaded model per thread: loading another model replaces (and disposes) the current one.
const pipelines = new Map();
async function load(model, dtypes, cacheDir) {
  const cached = pipelines.get(model);
  if (cached) return { ...(await cached), cacheHit: true, loadMs: 0 };
  const startedAt = Date.now();
  for (const [other, entry] of pipelines) {
    pipelines.delete(other);
    entry.then(({ pipeline }) => pipeline.dispose?.()).catch(() => {});
  }
  const created = (async () => {
    transformers.env.cacheDir = cacheDir;
    let lastError;
    for (const dtype of dtypes) {
      try {
        const options = { dtype, cache_dir: cacheDir };
        if (workerData.intraOpThreads > 0) options.session_options = { intraOpNumThreads: workerData.intraOpThreads };
        return { pipeline: await transformers.pipeline("feature-extraction", model, options), dtype };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("unable to load local transformers.js pipeline for " + model);
  })();
  pipelines.set(model, created);
  created.catch(() => pipelines.delete(model));
  return { ...(await created), cacheHit: false, loadMs: Date.now() - startedAt };
}
parentPort.on("message", async (message) => {
  try {
    const { pipeline, dtype, cacheHit, loadMs } = await load(message.model, message.dtypes, message.cacheDir);
    if (message.texts.length === 0) {
      parentPort.postMessage({ id: message.id, ok: true, data: new Float32Array(0), dims: [0], dtype, cacheHit, loadMs, runMs: 0 });
      return;
    }
    const runStartedAt = Date.now();
    const output = await pipeline(message.texts, { pooling: message.pooling ?? "mean", normalize: message.normalize });
    const runMs = Date.now() - runStartedAt;
    const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data ?? []);
    const copy = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    parentPort.postMessage({ id: message.id, ok: true, data: copy, dims: Array.from(output.dims ?? []), dtype, cacheHit, loadMs, runMs }, [copy.buffer]);
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? (error.stack || error.message) : String(error) });
  }
});
parentPort.postMessage({ ready: true });
`;

type Pending = {
  resolve: (result: ThreadEmbeddingResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

type ThreadMessage =
  | { ready: true }
  | { id: number; ok: true; data: Float32Array; dims: number[]; dtype: string; cacheHit: boolean; loadMs: number; runMs: number }
  | { id: number; ok: false; error: string };

function resolveTransformersUrl(): string {
  const resolver = (import.meta as ImportMeta & { resolve?: (specifier: string) => string }).resolve;
  if (typeof resolver === "function") {
    try {
      return resolver("@huggingface/transformers");
    } catch {
      // Fall through to the CommonJS resolver (e.g. under vite-node).
    }
  }
  return pathToFileURL(createRequire(import.meta.url).resolve("@huggingface/transformers")).href;
}

/** The thread died (native crash, OOM, uncaught error) while it had a request in flight. */
export class LocalEmbeddingThreadCrashError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LocalEmbeddingThreadCrashError";
  }
}

export interface LocalEmbeddingThreadOptions {
  /** ONNX Runtime intra-op threads for this thread's session; 0 or unset keeps the library default. */
  intraOpThreads?: number;
  name?: string;
}

export class LocalEmbeddingThread {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Set once a request completes; a thread that never served one is treated as unusable. */
  private served = false;
  private startupFailure: Error | null = null;

  constructor(
    private readonly moduleUrl: () => string = resolveTransformersUrl,
    private readonly options: LocalEmbeddingThreadOptions = {},
  ) {}

  /** True when the thread failed before serving a request (callers fall back to in-process). */
  get unusable(): boolean {
    return this.startupFailure !== null && !this.served;
  }

  embed(request: ThreadEmbeddingRequest, signal?: AbortSignal): Promise<ThreadEmbeddingResult> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    let worker: Worker;
    try {
      worker = this.ensureWorker();
    } catch (error) {
      // `new Worker` or the module resolver failed synchronously: reject this request
      // (callers must never see a throw) and remember it so the in-process fallback can engage.
      const failure = new LocalEmbeddingThreadCrashError(
        `${this.options.name ?? "local embedding thread"} could not start: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (!this.served) this.startupFailure = failure;
      return Promise.reject(failure);
    }
    const id = this.nextId++;
    return new Promise<ThreadEmbeddingResult>((resolve, reject) => {
      // The thread cannot interrupt a running batch; an abort stops waiting for it.
      const onAbort = () => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        entry.cleanup();
        reject(abortError(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        cleanup: () => {
          signal?.removeEventListener("abort", onAbort);
          if (this.pending.size === 0) this.worker?.unref();
        },
      });
      worker.ref();
      try {
        worker.postMessage({ id, ...request });
      } catch (error) {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry?.cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.cleanup();
      entry.reject(new Error("local embedding thread closed"));
    }
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(THREAD_SOURCE)}`), {
      workerData: { moduleUrl: this.moduleUrl(), intraOpThreads: this.options.intraOpThreads ?? 0 },
      name: this.options.name ?? "docslurp-local-embedding",
    });
    worker.unref();
    worker.on("message", (message: ThreadMessage) => {
      if ("ready" in message) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      entry.cleanup();
      if (message.ok) {
        this.served = true;
        entry.resolve({
          data: message.data,
          dims: message.dims,
          dtype: message.dtype,
          cacheHit: message.cacheHit,
          loadMs: message.loadMs,
          runMs: message.runMs,
        });
      } else {
        entry.reject(new Error(message.error));
      }
    });
    const fail = (error: Error) => {
      if (this.worker === worker) this.worker = null;
      if (!this.served) this.startupFailure = error;
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        entry.cleanup();
        entry.reject(error);
      }
    };
    const label = this.options.name ?? "local embedding thread";
    worker.on("error", (error) =>
      fail(new LocalEmbeddingThreadCrashError(`${label} crashed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })),
    );
    worker.on("exit", (code) => {
      if (this.worker === worker) fail(new LocalEmbeddingThreadCrashError(`${label} exited unexpectedly with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

interface PoolSlot {
  index: number;
  thread: LocalEmbeddingThread;
  /** True from dispatch until the thread itself answers (an aborted caller does not free it). */
  busy: boolean;
  /** Models this slot's current worker has loaded; cleared when the worker dies. */
  loaded: Set<string>;
}

interface PoolJob {
  request: ThreadEmbeddingRequest;
  resolve: (result: ThreadEmbeddingResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
  cleanup: () => void;
}

export interface LocalEmbeddingPoolOptions {
  size?: number;
  intraOpThreads?: number;
  moduleUrl?: () => string;
}

/**
 * A bounded pool of embedding threads. Each thread owns one loaded model and
 * runs one batch at a time; further requests wait in a FIFO queue, so the
 * pool size (not the number of concurrent documents) bounds both CPU use and
 * the number of model copies in memory. A thread that dies rejects its
 * in-flight request with a `LocalEmbeddingThreadCrashError` and is respawned
 * by the next request routed to its slot.
 */
export class LocalEmbeddingPool {
  readonly size: number;
  readonly intraOpThreads: number;
  private readonly slots: PoolSlot[];
  private readonly queue: PoolJob[] = [];
  private closed = false;

  constructor(options: LocalEmbeddingPoolOptions = {}) {
    this.size = Math.max(1, Math.floor(options.size ?? localEmbeddingPoolSize()));
    this.intraOpThreads = Math.max(1, Math.floor(options.intraOpThreads ?? localEmbeddingIntraOpThreads(this.size)));
    this.slots = Array.from({ length: this.size }, (_, index) => ({
      index,
      thread: new LocalEmbeddingThread(options.moduleUrl, {
        intraOpThreads: this.intraOpThreads,
        name: `docslurp-local-embedding-${index + 1}`,
      }),
      busy: false,
      loaded: new Set<string>(),
    }));
  }

  /** True when no thread can start (callers fall back to in-process inference). */
  get unusable(): boolean {
    return this.slots.every((slot) => slot.thread.unusable);
  }

  /** Requests currently waiting for a free thread. */
  get queued(): number {
    return this.queue.length;
  }

  /** Threads currently running a batch. */
  get active(): number {
    return this.slots.filter((slot) => slot.busy).length;
  }

  embed(request: ThreadEmbeddingRequest, signal?: AbortSignal): Promise<ThreadEmbeddingResult> {
    if (this.closed) return Promise.reject(new Error("local embedding pool closed"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<ThreadEmbeddingResult>((resolve, reject) => {
      const job: PoolJob = {
        request,
        settled: false,
        resolve: (result) => settle(() => resolve(result)),
        reject: (error) => settle(() => reject(error)),
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      };
      const settle = (finish: () => void) => {
        if (job.settled) return;
        job.settled = true;
        job.cleanup();
        finish();
      };
      // A queued request just leaves the queue. One already on a thread cannot be
      // interrupted: the caller stops waiting and the thread frees its slot when done.
      const onAbort = () => {
        const queued = this.queue.indexOf(job);
        if (queued >= 0) this.queue.splice(queued, 1);
        job.reject(abortError(signal!));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(job);
      this.dispatch();
    });
  }

  /** Loads the model on every thread (e.g. at worker start-up) so the first batches do not pay for it. */
  async preload(request: Omit<ThreadEmbeddingRequest, "texts">, signal?: AbortSignal): Promise<void> {
    // One load job per slot; the queue hands them out to idle slots as they free up,
    // and the per-slot `loaded` set steers each job to a slot that lacks the model.
    const loads = this.slots.map(() => this.embed({ ...request, texts: [] }, signal));
    await Promise.all(loads);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("local embedding pool closed");
    for (const job of this.queue.splice(0)) job.reject(error);
    await Promise.all(this.slots.map((slot) => slot.thread.close()));
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0]!;
      const slot = this.pickSlot(next.request);
      if (!slot) {
        // Nothing can ever run these: every thread failed to start.
        if (this.unusable) {
          for (const job of this.queue.splice(0)) job.reject(new Error("no local embedding thread could start"));
        }
        return;
      }
      this.queue.shift();
      this.run(slot, next);
    }
  }

  private pickSlot(request: ThreadEmbeddingRequest): PoolSlot | null {
    const idle = this.slots.filter((slot) => !slot.busy && !slot.thread.unusable);
    if (request.texts.length === 0) {
      // A load goes where the model is missing; if every idle slot has it, any idle slot answers.
      return idle.find((slot) => !slot.loaded.has(request.model)) ?? idle[0] ?? null;
    }
    // Batches prefer a thread that already holds the model, but never wait for one
    // while another thread is idle (it loads the model once and keeps it).
    return idle.find((slot) => slot.loaded.has(request.model)) ?? idle[0] ?? null;
  }

  private run(slot: PoolSlot, job: PoolJob): void {
    slot.busy = true;
    let attempt: Promise<ThreadEmbeddingResult>;
    try {
      attempt = slot.thread.embed(job.request);
    } catch (error) {
      // embed() reports failures by rejecting; a throw must still free the slot below.
      attempt = Promise.reject(error);
    }
    attempt.then(
      (result) => {
        // A thread keeps one model, so loading this one dropped any other.
        slot.loaded.clear();
        slot.loaded.add(job.request.model);
        job.resolve(result);
      },
      (error: unknown) => {
        // This thread could not start at all; another one may still serve the request.
        if (slot.thread.unusable && !this.unusable && !job.settled) {
          this.queue.unshift(job);
          return;
        }
        if (error instanceof LocalEmbeddingThreadCrashError) {
          slot.loaded.clear();
          console.warn(`[embed] ${error.message}; respawning on the next request`);
        }
        job.reject(error instanceof Error ? error : new Error(String(error)));
      },
    ).finally(() => {
      slot.busy = false;
      try {
        this.dispatch();
      } catch (error) {
        // Never leave a dequeued job unsettled or surface an unhandled rejection.
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const queued of this.queue.splice(0)) queued.reject(failure);
      }
    }).catch(() => undefined);
  }
}

let sharedPool: LocalEmbeddingPool | null = null;

/** The process-wide embedding pool (at most `size` model copies per process). */
export function sharedLocalEmbeddingPool(): LocalEmbeddingPool {
  sharedPool ??= new LocalEmbeddingPool();
  return sharedPool;
}

/** Terminates the process-wide pool (worker shutdown); a later request creates a fresh one. */
export async function closeSharedLocalEmbeddingPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  await pool?.close();
}
