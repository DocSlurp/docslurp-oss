// Web Worker entry for @docslurp/estimate: the module, file reads and profiles run on this thread, and progress is
// posted to the page, which only renders it. Use it through `createEstimateWorker` (client.mjs).
//
//   page -> worker  { type: "estimate", id, files: File[], options }   Files are handles: no bytes are copied.
//                   { type: "abort", id }
//   worker -> page  { type: "event", id, event } ... then { type: "result", id, result } or { type: "error", id, error }

import { createEstimator, estimateFiles } from "./index.mjs";

/**
 * Serve profile requests on `port` (a worker global, or any object with `postMessage` and `addEventListener`).
 * One estimator, and so one wasm memory, per worker; a different module replaces it.
 */
export function attachEstimateWorker(port) {
  let current = null;
  const runs = new Map();

  async function estimatorFor(options) {
    const key = JSON.stringify([options.module ?? null]);
    if (!current || current.key !== key) current = { key, estimator: createEstimator({ ...(options.module ? { module: options.module } : {}) }) };
    try {
      return await current.estimator;
    } catch (error) {
      current = null;
      throw error;
    }
  }

  port.addEventListener("message", async (message) => {
    const data = message.data;
    if (data?.type === "abort") {
      runs.get(data.id)?.abort();
      return;
    }
    if (data?.type !== "estimate") return;
    const controller = new AbortController();
    runs.set(data.id, controller);
    const { module, ...options } = data.options ?? {};
    try {
      const estimator = await estimatorFor({ module });
      const result = await estimateFiles(estimator, data.files, {
        ...options,
        signal: controller.signal,
        onProgress: (event) => {
          // The final result travels once, in the "result" message.
          if (event.type === "done") {
            const { result: _result, ...rest } = event;
            port.postMessage({ type: "event", id: data.id, event: rest });
          } else port.postMessage({ type: "event", id: data.id, event });
        },
      });
      port.postMessage({ type: "result", id: data.id, result });
    } catch (error) {
      port.postMessage({ type: "error", id: data.id, error: { code: error?.code ?? "worker_failed", message: error?.message ?? String(error) } });
    } finally {
      runs.delete(data.id);
    }
  });
  port.postMessage({ type: "ready" });
}

// Started as a dedicated worker: serve its global scope.
if (typeof globalThis.WorkerGlobalScope !== "undefined" && globalThis instanceof globalThis.WorkerGlobalScope) attachEstimateWorker(globalThis);
