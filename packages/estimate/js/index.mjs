// @docslurp/estimate: offline DocSlurp credit estimates. Probe files on this machine and quote an upload with the
// published price card, as POST /v1/uploads/estimate would. One WebAssembly module with a plain JSON ABI
// (src/abi.rs); this file loads it in browsers, Node, Deno and edge runtimes and wraps the calls.

const WASM_URL = new URL("../dist/docslurp_estimate.wasm", import.meta.url);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An estimator error with a stable `code`: invalid_request, invalid_card, unsupported_rules or crashed. */
export class EstimatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EstimatorError";
    this.code = code;
  }
}

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
 * this package. `card` is a price card from `GET /v1/billing/estimate-card` (see `fetchEstimateCard`); by default
 * the card bundled into the module.
 */
export async function createEstimator(options = {}) {
  const module = await compile(options.module);
  let instance = new WebAssembly.Instance(module, {});
  const cardBytes = options.card ? encoder.encode(typeof options.card === "string" ? options.card : JSON.stringify(options.card)) : null;

  function call(name, ...inputs) {
    const exports = instance.exports;
    const allocated = [];
    const args = [];
    for (const input of inputs) {
      if (!input || input.byteLength === 0) {
        args.push(0, 0);
        continue;
      }
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength);
      const pointer = exports.ds_alloc(bytes.byteLength);
      new Uint8Array(exports.memory.buffer, pointer, bytes.byteLength).set(bytes);
      allocated.push([pointer, bytes.byteLength]);
      args.push(pointer, bytes.byteLength);
    }
    let packed;
    try {
      packed = BigInt.asUintN(64, BigInt(exports[name](...args)));
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError) {
        // A panic traps the module and may leave its memory inconsistent: start a fresh instance.
        instance = new WebAssembly.Instance(module, {});
        throw new EstimatorError("crashed", `the estimator stopped on this input (${error.message})`);
      }
      throw error;
    }
    for (const [pointer, length] of allocated) exports.ds_free(pointer, length);
    const pointer = Number(packed >> 32n);
    const length = Number(packed & 0xffffffffn);
    const json = decoder.decode(new Uint8Array(exports.memory.buffer, pointer, length));
    exports.ds_free(pointer, length);
    const envelope = JSON.parse(json);
    if (!envelope.ok) throw new EstimatorError(envelope.error.code, envelope.error.message);
    return envelope.value;
  }

  const json = (value) => encoder.encode(JSON.stringify(value));
  const meta = (file) => ({ name: file.name, ...(file.type ? { type: file.type } : {}), size: file.size });

  const estimator = {
    /** The price card quotes use: the supplied card, else the bundled one. */
    card() {
      return options.card ? (typeof options.card === "string" ? JSON.parse(options.card) : options.card) : call("ds_card");
    },
    /** Bytes `probe` needs of a file: `{ head, tail }` (head === size means the whole file). */
    readPlan(file) {
      return call("ds_read_plan", json(meta(file)));
    },
    /** Probe a file from its first bytes (`head`) and, for large media, its last bytes (`tail`). */
    probe(file, head, tail) {
      return call("ds_probe", json(meta(file)), head, tail);
    },
    /** Quote `{ files, profile?, speedBoost? }`. Without a profile, a new hosted workspace with default settings. */
    quote(request) {
      return call("ds_quote", json(request), cardBytes);
    },
    /** Read and probe a `Blob`/`File` (browsers, Deno, Node 20+), reading only the bytes the probe needs. */
    async probeBlob(blob, name = blob.name) {
      const file = { name, type: blob.type, size: blob.size };
      const plan = estimator.readPlan(file);
      const head = new Uint8Array(await blob.slice(0, plan.head).arrayBuffer());
      const tail = plan.tail > 0 ? new Uint8Array(await blob.slice(blob.size - plan.tail).arrayBuffer()) : undefined;
      return estimator.probe(file, head, tail);
    },
    /** Probe each file and quote them together. Files the probe cannot read are priced from name, type and size. */
    async quoteFiles(blobs, request = {}) {
      const files = [];
      const probes = [];
      for (const blob of blobs) {
        let probed = null;
        try {
          probed = await estimator.probeBlob(blob);
        } catch (error) {
          if (!(error instanceof EstimatorError)) throw error;
        }
        probes.push(probed);
        files.push(applyProbe({ name: blob.name, size: blob.size, ...(blob.type ? { type: blob.type } : {}) }, probed));
      }
      return { ...estimator.quote({ ...request, files }), probes };
    },
  };
  return estimator;
}

/** Copy a probe's measurements into a quote file, keeping fields the file already has (ProbeResult::apply). */
export function applyProbe(file, probe) {
  if (!probe) return file;
  const next = { ...file };
  if (next.type === undefined && probe.mimeType) next.type = probe.mimeType;
  if (next.pages === undefined && probe.pages !== undefined) next.pages = probe.pages;
  if (next.durationSeconds === undefined && probe.durationSeconds !== undefined) next.durationSeconds = probe.durationSeconds;
  if (next.mix === undefined && probe.mix) {
    next.mix = probe.mix;
    if (probe.mixConfidence !== undefined) next.mixConfidence = probe.mixConfidence;
  }
  return next;
}

/**
 * The current price card from a DocSlurp server (public, no key). Pass it to `createEstimator({ card })` so a
 * long-lived offline build quotes current prices; quotes report which card they used.
 */
export async function fetchEstimateCard(origin = "https://docslurp.io", init) {
  const response = await fetch(new URL("/v1/billing/estimate-card", origin), init);
  if (!response.ok) throw new EstimatorError("invalid_card", `could not fetch the price card (${response.status})`);
  return response.json();
}
