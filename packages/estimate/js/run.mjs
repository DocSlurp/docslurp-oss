// Incremental estimates with progress: probe files in bounded batches, report what was measured as it happens, and
// quote whatever finished when the caller stops early. Used by `estimateFiles` (index.mjs), `estimatePaths`
// (node.mjs) and the Web Worker entry (worker.mjs). The wasm calls are synchronous, so one estimator probes one file
// at a time; concurrency only overlaps reading the next files with probing the current one.

import { applyProbe } from "./index.mjs";

/** Bytes read per `read-progress` step; also how often a read checks for cancellation. */
export const READ_CHUNK_BYTES = 1024 * 1024;
const DEFAULTS = { concurrency: 2, batchSize: 16, maxBufferedBytes: 128 * 1024 * 1024, quoteIntervalMs: 250 };

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Let the host run timers, paint and handle messages before the next file (setImmediate, else a macrotask). */
export function yieldToEventLoop() {
  if (typeof globalThis.scheduler?.yield === "function") return globalThis.scheduler.yield();
  if (typeof globalThis.setImmediate === "function") return new Promise((resolve) => globalThis.setImmediate(resolve));
  if (typeof MessageChannel === "function") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const error = new Error("The estimate was cancelled.");
  error.name = "AbortError";
  return error;
}

const isAbort = (error) => error?.name === "AbortError";

/** A source over a `Blob`/`File`: `slice` reads only the planned bytes, never the whole file. */
export function blobSource(blob, name = blob.name) {
  return {
    name: String(name ?? ""),
    size: blob.size,
    ...(blob.type ? { type: blob.type } : {}),
    async open() {
      return { read: async (position, length) => new Uint8Array(await blob.slice(position, position + length).arrayBuffer()) };
    },
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Size-only quote fields: what the server would price from name, type and size alone. */
const sizeOnly = (source) => ({ name: source.name, size: source.size, ...(source.type ? { type: source.type } : {}) });

/**
 * Probe `sources` and quote them, reporting progress through `emit(event)` (awaited, so a slow consumer applies
 * backpressure). Returns `{ quote, files, stats, partial, cancelled, sizeOnlyFiles }`.
 */
export async function runEstimate(estimator, sources, options = {}, emit = () => {}) {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULTS.concurrency));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULTS.batchSize));
  const maxBufferedBytes = Math.max(1, options.maxBufferedBytes ?? DEFAULTS.maxBufferedBytes);
  const quoteIntervalMs = options.quoteIntervalMs ?? DEFAULTS.quoteIntervalMs;
  const signal = options.signal;
  const request = { ...(options.profile ? { profile: options.profile } : {}), ...(options.speedBoost !== undefined ? { speedBoost: options.speedBoost } : {}) };
  const started = now();
  const total = sources.length;

  // A request the module refuses (a profile for a newer card) fails now, before any file is read.
  if (total > 0 && request.profile) estimator.quote({ ...request, files: [sizeOnly(sources[0])] });

  // Read plans up front (cheap, no bytes read) so progress has a true denominator from the first event.
  const plans = new Array(total);
  let plannedBytes = 0;
  let fileBytes = 0;
  for (let index = 0; index < total; index += 1) {
    const source = sources[index];
    fileBytes += source.size;
    if (source.error) continue;
    try {
      const plan = estimator.readPlan(sizeOnly(source));
      plans[index] = plan;
      plannedBytes += plan.head + plan.tail;
    } catch (error) {
      plans[index] = { error };
    }
  }

  /** Per-file results, by index; null until the file is finished. */
  const results = new Array(total).fill(null);
  const counts = { completed: 0, probed: 0, failed: 0, skipped: 0 };
  let bytesRead = 0;
  let buffered = 0;
  let peakBuffered = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let lastQuoteAt = -Infinity;
  const healthBefore = estimator.health?.() ?? { crashes: 0, resets: 0 };
  const waiters = [];

  const progress = () => ({
    elapsedMs: round(now() - started),
    files: { total, completed: counts.completed, probed: counts.probed, failed: counts.failed, skipped: counts.skipped },
    bytes: { read: bytesRead, planned: plannedBytes, files: fileBytes },
  });
  const send = (type, fields) => emit({ type, ...progress(), ...fields });

  // Bytes held between read and probe stay under maxBufferedBytes; one file larger than the cap still runs alone.
  const reserve = async (bytes) => {
    while (buffered > 0 && buffered + bytes > maxBufferedBytes) await new Promise((resolve) => waiters.push(resolve));
    buffered += bytes;
    peakBuffered = Math.max(peakBuffered, buffered);
  };
  const release = (bytes) => {
    buffered -= bytes;
    while (waiters.length) waiters.shift()();
  };

  const quoteFiles = () => results.map((result, index) => result?.quoteFile ?? sizeOnly(sources[index]));
  const quoteNow = () => estimator.quote({ ...request, files: quoteFiles() });

  async function readRange(handle, file, position, length, into, offset) {
    let done = 0;
    while (done < length) {
      if (signal?.aborted) throw abortError(signal);
      const step = Math.min(READ_CHUNK_BYTES, length - done);
      const chunk = await handle.read(position + done, step);
      if (signal?.aborted) throw abortError(signal);
      into.set(chunk.subarray(0, Math.min(chunk.byteLength, step)), offset + done);
      done += Math.min(chunk.byteLength, step);
      bytesRead += Math.min(chunk.byteLength, step);
      file.bytesRead += Math.min(chunk.byteLength, step);
      await send("read-progress", { file: { index: file.index, name: file.name }, fileBytesRead: file.bytesRead, filePlannedBytes: file.plannedBytes });
      if (chunk.byteLength < step) break; // the file shrank since it was planned: probe what is there
    }
    return done;
  }

  async function processFile(index) {
    const source = sources[index];
    const plan = plans[index];
    const fileStarted = now();
    const file = { index, name: source.name, plannedBytes: plan && !plan.error ? plan.head + plan.tail : 0, bytesRead: 0 };
    const finish = (fields) => {
      const result = {
        index,
        name: source.name,
        size: source.size,
        ...(source.type ? { type: source.type } : {}),
        probe: null,
        quoteFile: sizeOnly(source),
        measured: false,
        bytesRead: file.bytesRead,
        plannedBytes: file.plannedBytes,
        readMs: 0,
        probeMs: null,
        ...fields,
        elapsedMs: round(now() - fileStarted),
      };
      results[index] = result;
      counts.completed += 1;
      if (result.status === "probed") counts.probed += 1;
      else if (result.status === "failed") counts.failed += 1;
      else counts.skipped += 1;
      return result;
    };

    await send("file-start", { file: { index, name: source.name, size: source.size, ...(source.type ? { type: source.type } : {}) }, plan: plan && !plan.error ? plan : null, filePlannedBytes: file.plannedBytes });
    const planError = source.error ?? plan?.error;
    if (planError) {
      const result = finish({ status: "failed", reason: { code: planError.code ?? "read_failed", message: planError.message ?? String(planError) } });
      await send("file-done", { file: { index, name: source.name }, result });
      return;
    }

    const bytes = plan.head + plan.tail;
    await reserve(bytes);
    let head;
    let tail;
    let readMs = 0;
    try {
      const readStarted = now();
      const handle = await source.open();
      try {
        const buffer = new Uint8Array(bytes);
        const headRead = await readRange(handle, file, 0, plan.head, buffer, 0);
        head = buffer.subarray(0, headRead);
        if (plan.tail > 0) {
          const tailRead = await readRange(handle, file, source.size - plan.tail, plan.tail, buffer, plan.head);
          tail = buffer.subarray(plan.head, plan.head + tailRead);
        }
      } finally {
        await handle.close?.();
      }
      readMs = round(now() - readStarted);
    } catch (error) {
      release(bytes);
      const cancelled = isAbort(error);
      const result = finish({
        status: cancelled ? "skipped" : "failed",
        reason: cancelled ? { code: "cancelled", message: "Cancelled while reading; priced from name, type and size." } : { code: "read_failed", message: error?.message ?? String(error) },
        readMs: round(now() - fileStarted),
      });
      await send("file-done", { file: { index, name: source.name }, result });
      return;
    }

    // Probing is one synchronous wasm call: it cannot report a percentage, only that it started and how long it took.
    await send("probe-start", { file: { index, name: source.name }, stage: "probe", readMs });
    const probeStarted = now();
    let probe = null;
    let failure = null;
    try {
      probe = estimator.probe(sizeOnly(source), head, tail);
    } catch (error) {
      failure = { code: error?.code ?? "probe_failed", message: error?.message ?? String(error) };
    }
    const probeMs = round(now() - probeStarted, 2);
    head = tail = undefined;
    release(bytes);
    await send("probe-done", { file: { index, name: source.name }, stage: "probe", probeMs, ok: failure === null });
    const result = failure
      ? finish({ status: "failed", reason: { ...failure, message: `${failure.message}; priced from name, type and size.` }, readMs, probeMs })
      : finish({ status: "probed", probe, quoteFile: applyProbe(sizeOnly(source), probe), measured: true, readMs, probeMs });
    await send("file-done", { file: { index, name: source.name }, result });
  }

  // Batches run one after another; inside a batch up to `concurrency` files are read at once. Nothing is queued
  // beyond the current batch, so a very large selection holds only its (small) per-file results.
  let batchIndex = 0;
  for (let start = 0; start < total && !signal?.aborted; start += batchSize) {
    const end = Math.min(total, start + batchSize);
    let cursor = start;
    const lane = async () => {
      while (cursor < end && !signal?.aborted) {
        const index = cursor;
        cursor += 1;
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          await processFile(index);
        } finally {
          inFlight -= 1;
        }
        await yieldToEventLoop();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, end - start) }, lane));
    const last = end >= total || signal?.aborted;
    const quoted = last || now() - lastQuoteAt >= quoteIntervalMs;
    let quote;
    if (quoted && counts.completed < total) {
      quote = quoteNow();
      lastQuoteAt = now();
    }
    await send("batch-done", { batch: { index: batchIndex, start, end }, ...(quote ? { quote, provisional: true } : {}) });
    batchIndex += 1;
  }

  const cancelled = Boolean(signal?.aborted);
  for (let index = 0; index < total; index += 1) {
    if (results[index]) continue;
    results[index] = {
      index,
      name: sources[index].name,
      size: sources[index].size,
      ...(sources[index].type ? { type: sources[index].type } : {}),
      status: "skipped",
      reason: { code: "cancelled", message: "Not probed before the estimate was cancelled; priced from name, type and size." },
      probe: null,
      quoteFile: sizeOnly(sources[index]),
      measured: false,
      bytesRead: 0,
      plannedBytes: plans[index] && !plans[index].error ? plans[index].head + plans[index].tail : 0,
      readMs: 0,
      probeMs: null,
      elapsedMs: 0,
    };
    counts.skipped += 1;
  }

  const quote = total > 0 ? quoteNow() : null;
  const elapsedMs = now() - started;
  const probeTimes = results.filter((result) => result.probeMs !== null).map((result) => result.probeMs).sort((a, b) => a - b);
  const mixed = results.filter((result) => result.probe?.mix);
  const confidences = mixed.map((result) => result.probe.mixConfidence ?? 1);
  const healthAfter = estimator.health?.() ?? { crashes: 0, resets: 0 };
  const sizeOnlyFiles = results.filter((result) => !result.measured).length;
  const seconds = Math.max(elapsedMs, 1) / 1000;
  const stats = {
    elapsedMs: round(elapsedMs),
    files: { total, probed: counts.probed, failed: counts.failed, skipped: counts.skipped, sizeOnly: sizeOnlyFiles },
    bytes: { read: bytesRead, planned: plannedBytes, files: fileBytes, readShare: fileBytes > 0 ? round(bytesRead / fileBytes, 4) : 0 },
    probeMs: { total: round(probeTimes.reduce((sum, ms) => sum + ms, 0), 2), p50: percentile(probeTimes, 50), p95: percentile(probeTimes, 95), max: probeTimes.at(-1) ?? 0 },
    readMs: round(results.reduce((sum, result) => sum + result.readMs, 0)),
    throughput: { filesPerSecond: round((counts.probed + counts.failed) / seconds, 2), megabytesPerSecond: round(bytesRead / 1e6 / seconds, 2) },
    pages: { found: results.reduce((sum, result) => sum + (result.probe?.pages ?? 0), 0), files: results.filter((result) => result.probe?.pages !== undefined).length },
    durationSeconds: round(results.reduce((sum, result) => sum + (result.probe?.durationSeconds ?? 0), 0), 2),
    mixConfidence: {
      files: mixed.length,
      min: confidences.length ? Math.min(...confidences) : null,
      mean: confidences.length ? round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length, 3) : null,
      max: confidences.length ? Math.max(...confidences) : null,
    },
    estimator: { crashes: healthAfter.crashes - healthBefore.crashes, resets: healthAfter.resets - healthBefore.resets },
    bounds: { concurrency, batchSize, maxBufferedBytes, peakInFlight, peakBufferedBytes: peakBuffered },
  };
  const result = { quote, files: results, stats, partial: sizeOnlyFiles > 0, cancelled, sizeOnlyFiles };
  await send("quote-done", { quote, partial: result.partial, cancelled, result });
  return result;
}

/**
 * Turn a run into an async iterator of events with a bounded buffer: when the consumer falls `highWaterMark` events
 * behind, the run waits for it rather than queueing without limit. The last event is `quote-done` (its `result`).
 */
export function eventStream(start, highWaterMark = 64) {
  const buffer = [];
  let wake = null;
  /** Producers waiting for room; several lanes can emit at once. */
  const drained = [];
  let finished = false;
  let failure = null;
  const notify = () => {
    if (wake) {
      const resolve = wake;
      wake = null;
      resolve();
    }
  };
  const emit = async (event) => {
    buffer.push(event);
    notify();
    if (buffer.length >= highWaterMark) await new Promise((resolve) => drained.push(resolve));
  };
  start(emit).then(
    () => {
      finished = true;
      notify();
    },
    (error) => {
      failure = error;
      finished = true;
      notify();
    },
  );
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (buffer.length) {
          const event = buffer.shift();
          if (buffer.length < highWaterMark) while (drained.length) drained.shift()();
          yield event;
          continue;
        }
        if (finished) {
          if (failure) throw failure;
          return;
        }
        await new Promise((resolve) => (wake = resolve));
      }
    },
  };
}
