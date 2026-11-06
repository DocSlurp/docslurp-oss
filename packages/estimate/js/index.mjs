// @docslurp/estimate: the offline DocSlurp file profiler. Measure files on this machine (type, pages, PDF page facts,
// media duration) and send the profiles to POST /v1/uploads/estimate for a quote; nothing here prices anything. One
// WebAssembly module with a plain JSON ABI (src/abi.rs); this file loads it in browsers, Node, Deno and edge runtimes.

import { blobSource, eventStream, runEstimate } from "./run.mjs";

export { yieldToEventLoop } from "./run.mjs";

const WASM_URL = new URL("../dist/docslurp_estimate.wasm", import.meta.url);
/** The module's imported memory, in 64 KiB pages: 16 MiB initial, 256 MiB maximum (.cargo/config.toml). */
const MEMORY_INITIAL_PAGES = 256;
const MEMORY_MAXIMUM_PAGES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

import { EstimatorError } from "./error.mjs";

export { EstimatorError };

async function compile(source) {
  if (source instanceof WebAssembly.Module) return source;
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return WebAssembly.compile(source);
  const url = source === undefined ? WASM_URL : source instanceof URL ? source : new URL(String(source), import.meta.url);
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return WebAssembly.compile(await readFile(url));
  }
  const response = await fetch(url);
  if (!response.ok) throw new EstimatorError("invalid_request", `could not load the estimator module (${response.status})`);
  return typeof WebAssembly.compileStreaming === "function" && response.headers.get("content-type")?.startsWith("application/wasm")
    ? WebAssembly.compileStreaming(response)
    : WebAssembly.compile(await response.arrayBuffer());
}

/**
 * Create an estimator. `module` is a compiled `WebAssembly.Module` (Cloudflare Workers: `import wasm from
 * "@docslurp/estimate/docslurp_estimate.wasm"`), the module's bytes, or a URL; by default the bundled file next to
 * this package.
 */
export async function createEstimator(options = {}) {
  const module = await compile(options.module);
  // One bounded memory for the estimator's lifetime: after a trap it is zeroed and the module instantiated into it
  // again, so hostile files cost at most this memory, never a fresh allocation per crash.
  const memory = new WebAssembly.Memory({ initial: MEMORY_INITIAL_PAGES, maximum: MEMORY_MAXIMUM_PAGES });
  const instantiate = () => new WebAssembly.Instance(module, { env: { memory } });
  let instance = instantiate();
  const health = { calls: 0, crashes: 0, resets: 0 };

  function call(name, ...inputs) {
    const exports = instance.exports;
    let packed;
    health.calls += 1;
    try {
      const args = [];
      for (const input of inputs) {
        if (!input || input.byteLength === 0) {
          args.push(0, 0);
          continue;
        }
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength);
        const pointer = exports.ds_alloc(bytes.byteLength);
        new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
        args.push(pointer, bytes.byteLength);
      }
      packed = BigInt.asUintN(64, BigInt(exports[name](...args)));
      // Inputs are freed by zeroing on the next reset if a call traps; on success, free them now.
      for (let index = 0; index < args.length; index += 2) if (args[index + 1] > 0) exports.ds_free(args[index], args[index + 1]);
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        // A trap (a panic, an input larger than the memory, or a file that hit the memory cap) leaves the heap
        // inconsistent: zero the memory and instantiate the module into it again, exactly as on first load.
        health.crashes += 1;
        new Uint8Array(memory.buffer).fill(0);
        instance = instantiate();
        health.resets += 1;
        throw new EstimatorError("crashed", `the estimator stopped on this input (${error.message})`);
      }
      throw error;
    }
    const pointer = Number(packed >> 32n);
    const length = Number(packed & 0xffffffffn);
    const json = decoder.decode(new Uint8Array(memory.buffer, pointer, length));
    exports.ds_free(pointer, length);
    const envelope = JSON.parse(json);
    if (!envelope.ok) throw new EstimatorError(envelope.error.code, envelope.error.message);
    return envelope.value;
  }

  const json = (value) => encoder.encode(JSON.stringify(value));
  const meta = (file) => ({ name: file.name, ...(file.type ? { type: file.type } : {}), size: file.size });

  const estimator = {
    /** `{ profileSchema, profiler }`: the profile shape and profiler version this module emits. */
    info() {
      return call("ds_info");
    },
    /** Bytes `profile` needs of a file: `{ head, tail }` (head === size means the whole file). */
    readPlan(file) {
      return call("ds_read_plan", json(meta(file)));
    },
    /** Profile a file from its first bytes (`head`) and, for large media, its last bytes (`tail`). */
    profile(file, head, tail) {
      return call("ds_probe", json(meta(file)), head, tail);
    },
    /** Read and profile a `Blob`/`File` (browsers, Deno, Node 20+), reading only the bytes the profile needs. */
    async profileBlob(blob, name = blob.name) {
      const file = { name, type: blob.type, size: blob.size };
      const plan = estimator.readPlan(file);
      const head = new Uint8Array(await blob.slice(0, plan.head).arrayBuffer());
      const tail = plan.tail > 0 ? new Uint8Array(await blob.slice(blob.size - plan.tail).arrayBuffer()) : undefined;
      return estimator.profile(file, head, tail);
    },
    /** Profile files with progress events, cancellation and per-file fallbacks; see `estimateFiles`. */
    estimateFiles(blobs, options) {
      return estimateFiles(estimator, blobs, options);
    },
    /** Calls into the module, and how many trapped and were recovered by a fresh instance. */
    health() {
      return { ...health };
    },
  };
  return estimator;
}

const sourcesOf = (files) => Array.from(files, (file) => (typeof file?.open === "function" ? file : blobSource(file)));

/**
 * Profile `files` (Blobs/Files) in bounded batches, with progress events. Never rejects for one file: a file that cannot
 * be read or profiled is sent with its name, type and size only, with a `reason`. When `options.signal` aborts, work
 * stops between files and between 1 MiB reads, and the result is `partial`. `result.request.files` is the body for
 * `POST /v1/uploads/estimate` (see `requestQuote`).
 */
export async function estimateFiles(estimator, files, options = {}) {
  const onProgress = options.onProgress;
  return runEstimate(estimator, sourcesOf(files), options, onProgress ? (event) => onProgress(event) : undefined);
}

/**
 * The same run as an async iterator of events, ending with `done` (whose `result` is what `estimateFiles` returns). A
 * slow consumer pauses the run once `highWaterMark` events are waiting, so events never pile up.
 */
export function estimateEvents(estimator, files, options = {}) {
  const sources = sourcesOf(files);
  return eventStream((emit) => runEstimate(estimator, sources, options, emit), options.highWaterMark);
}

/**
 * Ask a DocSlurp server to quote profiled files: `POST /v1/uploads/estimate` with `files` (each `{ name, size, type?,
 * profile? }`, e.g. `result.request.files`). Needs an API key with the `ingest` scope (or a session). The response is
 * the server's estimate; profiles never change what an upload is charged. Offline, show the profiles without credits.
 */
export async function requestQuote({ files, workspace, speedBoost, apiKey, origin = "https://docslurp.io", fetch: fetchImpl = globalThis.fetch, init = {} }) {
  const response = await fetchImpl(new URL("/v1/uploads/estimate", origin), {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(init.headers ?? {}) },
    body: JSON.stringify({ files, ...(workspace ? { workspace } : {}), ...(speedBoost !== undefined ? { speedBoost } : {}) }),
  });
  if (!response.ok) throw new EstimatorError("quote_failed", `the server did not quote these files (${response.status})`);
  return response.json();
}
