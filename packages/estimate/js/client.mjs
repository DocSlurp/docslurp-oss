// Page-side client for the estimate Web Worker (worker.mjs). The page posts File handles and renders events; the
// module, reads and probes stay on the worker thread.

import { EstimatorError } from "./error.mjs";

/** How long an aborted run may take to send its partial result before the worker is stopped outright. */
const ABORT_GRACE_MS = 1500;

function listen(worker, handler) {
  if (typeof worker.addEventListener === "function") {
    worker.addEventListener("message", handler);
    return () => worker.removeEventListener("message", handler);
  }
  // node:worker_threads (tests, Node hosts): an EventEmitter that passes the data itself.
  const wrapped = (data) => handler({ data });
  worker.on("message", wrapped);
  return () => worker.off("message", wrapped);
}

function onFailure(worker, handler) {
  if (typeof worker.addEventListener === "function") {
    worker.addEventListener("error", handler);
    worker.addEventListener("messageerror", handler);
    return () => {
      worker.removeEventListener("error", handler);
      worker.removeEventListener("messageerror", handler);
    };
  }
  worker.on("error", handler);
  return () => worker.off("error", handler);
}

/**
 * Wrap a worker started from `@docslurp/estimate/worker`, e.g. with Vite
 * `import EstimateWorker from "@docslurp/estimate/worker?worker"; createEstimateWorker(new EstimateWorker())`, or
 * `new Worker(new URL("@docslurp/estimate/worker", import.meta.url), { type: "module" })`.
 */
export function createEstimateWorker(worker, defaults = {}) {
  let nextId = 0;
  let dead = null;

  const client = {
    /**
     * `estimateFiles` on the worker thread: same options (minus `module`/`card`, which go in `defaults` or here),
     * same events through `onProgress`, same result. After an abort the worker gets `abortGraceMs` to return its
     * partial result; if it does not, it is terminated and the result is rebuilt from the events already received
     * (`quote: null`, the caller falls back to a size-only quote).
     */
    estimate(files, options = {}) {
      if (dead) return Promise.reject(dead);
      const id = ++nextId;
      const { signal, onProgress, abortGraceMs = ABORT_GRACE_MS, ...rest } = { ...defaults, ...options };
      const list = Array.from(files);
      const seen = new Map();
      let lastEvent = null;
      return new Promise((resolve, reject) => {
        let graceTimer = 0;
        const cleanup = [];
        const done = (fn, value) => {
          clearTimeout(graceTimer);
          for (const undo of cleanup.splice(0)) undo();
          fn(value);
        };
        cleanup.push(listen(worker, ({ data }) => {
          if (data?.id !== id) return;
          if (data.type === "event") {
            lastEvent = data.event;
            if (data.event.type === "file-done") seen.set(data.event.result.index, data.event.result);
            onProgress?.(data.event);
          } else if (data.type === "result") done(resolve, data.result);
          else if (data.type === "error") done(reject, new EstimatorError(data.error.code, data.error.message));
        }));
        cleanup.push(onFailure(worker, (event) => {
          dead = new EstimatorError("worker_failed", event?.message ?? "the estimate worker stopped");
          done(reject, dead);
        }));
        const abort = () => {
          worker.postMessage({ type: "abort", id });
          graceTimer = setTimeout(() => {
            client.terminate();
            done(resolve, partialFromEvents(list, seen, lastEvent));
          }, abortGraceMs);
        };
        if (signal) {
          if (signal.aborted) {
            done(resolve, partialFromEvents(list, seen, null));
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          cleanup.push(() => signal.removeEventListener("abort", abort));
        }
        worker.postMessage({ type: "estimate", id, files: list, options: rest });
      });
    },
    terminate() {
      dead ??= new EstimatorError("worker_failed", "the estimate worker was stopped");
      worker.terminate?.();
    },
  };
  return client;
}

/** A partial result from the file-done events received, when the worker could not send its own. */
function partialFromEvents(files, seen, lastEvent) {
  const results = files.map((file, index) => seen.get(index) ?? {
    index,
    name: file.name,
    size: file.size,
    ...(file.type ? { type: file.type } : {}),
    status: "skipped",
    reason: { code: "cancelled", message: "Not probed before the estimate was cancelled; priced from name, type and size." },
    probe: null,
    quoteFile: { name: file.name, size: file.size, ...(file.type ? { type: file.type } : {}) },
    measured: false,
    bytesRead: 0,
    plannedBytes: 0,
    readMs: 0,
    probeMs: null,
    elapsedMs: 0,
  });
  const sizeOnlyFiles = results.filter((result) => !result.measured).length;
  return { quote: null, files: results, stats: null, partial: true, cancelled: true, sizeOnlyFiles, lastEvent };
}
