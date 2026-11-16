// Integration artifact: local range transport for a JSONL WASM state machine.
// The caller owns the estimator's exclusive session lock for this iterator's life.

const encoder = new TextEncoder();
const MAX_RANGE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function jsonBytes(value) {
  return encoder.encode(JSON.stringify(value));
}

function integer(value, what, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${what} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function checkRange(size, offset, length) {
  integer(offset, "range offset");
  integer(length, "range length", 1);
  if (length > MAX_RANGE_BYTES || offset > size || length > size - offset) {
    throw new Error("parser requested an invalid or oversized local range");
  }
}

/**
 * Drive the local parser without a whole-file read.
 *
 * call(name, ...Uint8ArrayInputs) returns an unwrapped ABI result, or throws.
 * file is optional host metadata; source owns the immutable local input handle.
 * source: { size, read(offset, length): Promise<Uint8Array>, close?() }.
 * Open payload shape: ds_range_open(optionsJSON, JSON.stringify({size})).
 * Yielded values are one complete JSONL line apiece, including its newline.
 */
export async function* driveRangeJsonl(call, file, source, options = {}, signal) {
  let opened = false;
  let terminal = false;
  let failure;
  let lastRequestId = -1;
  let readsSinceYield = 0;
  let lastYield = performance.now();
  const cancelled = () => signal?.aborted === true;
  const cancelledLine = () => {
    terminal = true;
    return `${JSON.stringify({ t: "end", complete: false, reason: "cancelled" })}\n`;
  };
  try {
    integer(source.size, "file size");
    if (file?.size !== undefined && file.size !== source.size) {
      throw new Error("file metadata size differs from the opened source");
    }
    if (cancelled()) {
      yield cancelledLine();
      return;
    }
    // A failed open must not replace another session. The caller serializes opens.
    const result = call("ds_range_open", jsonBytes(options), jsonBytes({ size: source.size }));
    if (result !== true) throw new Error("parser did not acknowledge range session open");
    opened = true;
    while (true) {
      if (cancelled()) {
        if (!terminal) yield cancelledLine();
        return;
      }
      const step = call("ds_range_step");
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new Error("invalid range parser response");
      }
      if (step.kind === "read") {
        const requestId = integer(step.requestId, "request ID");
        if (requestId <= lastRequestId) throw new Error("parser reused or reordered a range request ID");
        checkRange(source.size, step.offset, step.length);
        lastRequestId = requestId;
        const bytes = await source.read(step.offset, step.length);
        if (cancelled()) {
          if (!terminal) yield cancelledLine();
          return;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== step.length) {
          throw new Error("local file range returned a short or invalid read");
        }
        const supplied = call("ds_range_supply", jsonBytes({
          requestId, offset: step.offset, length: step.length,
        }), bytes);
        if (supplied !== true) throw new Error("parser did not acknowledge supplied range");
        // Keep UI cancellation responsive without a timer for every tiny object.
        readsSinceYield += 1;
        if (readsSinceYield >= 16 || performance.now() - lastYield >= 8) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          readsSinceYield = 0;
          lastYield = performance.now();
        }
        continue;
      }
      if (step.kind === "output") {
        if (typeof step.jsonl !== "string" || !step.jsonl.endsWith("\n") || step.jsonl.length === 0
            || encoder.encode(step.jsonl).byteLength > MAX_OUTPUT_BYTES) {
          throw new Error("invalid or oversized JSONL output frame");
        }
        const lines = step.jsonl.slice(0, -1).split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          const record = JSON.parse(line);
          if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.t !== "string") {
            throw new Error("JSONL output record must be a typed object");
          }
          if (terminal) throw new Error("parser output followed its terminal record");
          if (record.t === "end") {
            if (index !== lines.length - 1 || typeof record.complete !== "boolean") {
              throw new Error("invalid JSONL terminal record");
            }
            // Set before yielding: aborting or returning at the yield cannot append another end.
            terminal = true;
          }
          yield `${line}\n`;
          if (terminal) return;
          if (cancelled()) {
            yield cancelledLine();
            return;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      if (step.kind === "done") {
        // Returning without a terminal record would make a truncated stream look complete.
        if (!terminal) throw new Error("parser finished without a JSONL terminal record");
        return;
      }
      throw new Error("unknown range parser response kind");
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let cleanupError;
    if (opened) {
      try { call("ds_range_close"); } catch (error) { cleanupError = error; }
    }
    try { await source.close?.(); } catch (error) { cleanupError ??= error; }
    // Preserve an input/parser failure; otherwise expose cleanup failure to the consumer.
    if (!failure && cleanupError) throw cleanupError;
  }
}

/** Browser/Node Blob source: slices only, never blob.arrayBuffer() for the entire file. */
export function blobRangeSource(blob) {
  integer(blob.size, "Blob size");
  return {
    size: blob.size,
    async read(offset, length) {
      checkRange(blob.size, offset, length);
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

/**
 * Node file source: retain one descriptor and detect mutation/replacement of its object.
 * Reads are positional; neither filenames nor authority ever enter WASM.
 */
export async function nodePathRangeSource(path) {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");
  let closed = false;
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new Error("range input must be a regular local file");
    const size = Number(initial.size);
    integer(size, "file size");
    const same = (stat) => stat.isFile() && ["dev", "ino", "size", "mtimeNs", "ctimeNs"]
      .every((key) => stat[key] === initial[key]);
    const verify = async () => {
      if (closed || !same(await handle.stat({ bigint: true }))) {
        throw new Error("local input changed during profiling");
      }
    };
    return {
      size,
      async read(offset, length) {
        checkRange(size, offset, length);
        await verify();
        const bytes = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
          const result = await handle.read(bytes, filled, length - filled, offset + filled);
          if (result.bytesRead === 0) break;
          filled += result.bytesRead;
        }
        await verify();
        return bytes.subarray(0, filled); // Driver refuses short reads.
      },
      async close() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
