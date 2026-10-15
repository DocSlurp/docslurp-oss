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
 * Here the model loads and runs in one dedicated thread per process; the main
 * thread only posts texts and receives vectors, so it stays responsive.
 *
 * DOCSLURP_LOCAL_EMBED_THREAD=off restores in-process inference. If the
 * thread cannot start, the process falls back to in-process inference too.
 */

export interface ThreadEmbeddingRequest {
  model: string;
  /** Dtypes to try in order (the preferred one, then fp32). */
  dtypes: string[];
  cacheDir: string;
  /** Empty: only load the model (reports dtype and cacheHit). */
  texts: string[];
  normalize: boolean;
}

export interface ThreadEmbeddingResult {
  data: Float32Array;
  dims: number[];
  dtype: string;
  cacheHit: boolean;
}

export function localEmbeddingThreadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env.DOCSLURP_LOCAL_EMBED_THREAD ?? "on").trim().toLowerCase();
  return !["off", "false", "0", "no"].includes(value);
}

// An ES module served as a data: URL, so it needs no build step or file path
// (tsx, vitest and the compiled worker all load it the same way).
const THREAD_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
const transformers = await import(workerData.moduleUrl);
const pipelines = new Map();
async function load(model, dtypes, cacheDir) {
  const cached = pipelines.get(model);
  if (cached) return { ...(await cached), cacheHit: true };
  const created = (async () => {
    transformers.env.cacheDir = cacheDir;
    let lastError;
    for (const dtype of dtypes) {
      try {
        return { pipeline: await transformers.pipeline("feature-extraction", model, { dtype, cache_dir: cacheDir }), dtype };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("unable to load local transformers.js pipeline for " + model);
  })();
  pipelines.set(model, created);
  created.catch(() => pipelines.delete(model));
  return { ...(await created), cacheHit: false };
}
parentPort.on("message", async (message) => {
  try {
    const { pipeline, dtype, cacheHit } = await load(message.model, message.dtypes, message.cacheDir);
    if (message.texts.length === 0) {
      parentPort.postMessage({ id: message.id, ok: true, data: new Float32Array(0), dims: [0], dtype, cacheHit });
      return;
    }
    const output = await pipeline(message.texts, { pooling: "mean", normalize: message.normalize });
    const data = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data ?? []);
    const copy = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    parentPort.postMessage({ id: message.id, ok: true, data: copy, dims: Array.from(output.dims ?? []), dtype, cacheHit }, [copy.buffer]);
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
  | { id: number; ok: true; data: Float32Array; dims: number[]; dtype: string; cacheHit: boolean }
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

export class LocalEmbeddingThread {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** Set once a request completes; a thread that never served one is treated as unusable. */
  private served = false;
  private startupFailure: Error | null = null;

  constructor(private readonly moduleUrl: () => string = resolveTransformersUrl) {}

  /** True when the thread failed before serving a request (callers fall back to in-process). */
  get unusable(): boolean {
    return this.startupFailure !== null && !this.served;
  }

  embed(request: ThreadEmbeddingRequest, signal?: AbortSignal): Promise<ThreadEmbeddingResult> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const worker = this.ensureWorker();
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
      worker.postMessage({ id, ...request });
    });
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(THREAD_SOURCE)}`), {
      workerData: { moduleUrl: this.moduleUrl() },
      name: "docslurp-local-embedding",
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
        entry.resolve({ data: message.data, dims: message.dims, dtype: message.dtype, cacheHit: message.cacheHit });
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
    worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => {
      if (this.worker === worker || this.pending.size > 0) fail(new Error(`local embedding thread exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

let sharedThread: LocalEmbeddingThread | null = null;

/** The process-wide embedding thread (one model copy per process, as before). */
export function sharedLocalEmbeddingThread(): LocalEmbeddingThread {
  sharedThread ??= new LocalEmbeddingThread();
  return sharedThread;
}
