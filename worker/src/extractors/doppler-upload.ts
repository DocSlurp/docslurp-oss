/*
 * Bounded-memory uploads of a Doppler images folder (extractors/doppler-figures.ts): every byte the worker holds for a
 * document's files at any moment (read chunks, hash state, upload buffers) is reserved from a fixed per-job budget and a
 * per-process ceiling, whatever the page count or the document's size. Files are read in chunks, hashed and
 * signature-checked as they stream to storage, and verified when the last byte has been read: a file that does not match
 * what the manifest says fails its upload before it completes, and the partial object is deleted.
 *
 * Budgets (bytes): DOCSLURP_DOPPLER_FIGURE_BUFFER_BYTES per document job (default 64 MiB) and
 * DOCSLURP_DOPPLER_FIGURE_WORKER_BUFFER_BYTES per worker process (default 256 MiB, shared by the documents one process
 * runs at once). DOCSLURP_DOPPLER_FIGURE_UPLOAD_CONCURRENCY bounds the uploads in flight per job (default 8).
 */
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";

const MIB = 1024 * 1024;
/** One streamed read; a streaming upload holds about two of these (the stream's buffer and the request's chunk). */
export const DOPPLER_UPLOAD_CHUNK_BYTES = MIB;
/** Files at or under this size are read whole and sent as one buffer (cheaper than a stream for small figures). */
export const DOPPLER_UPLOAD_SMALL_FILE_BYTES = 256 * 1024;

function envBytes(name: string, fallback: number, min: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a whole number of bytes, at least ${min}`);
  return value;
}

export function dopplerFigureBufferBytes(): number {
  return envBytes("DOCSLURP_DOPPLER_FIGURE_BUFFER_BYTES", 64 * MIB, 4 * MIB);
}
export function dopplerFigureWorkerBufferBytes(): number {
  return envBytes("DOCSLURP_DOPPLER_FIGURE_WORKER_BUFFER_BYTES", 256 * MIB, 4 * MIB);
}
export function dopplerFigureUploadConcurrency(): number {
  const value = envBytes("DOCSLURP_DOPPLER_FIGURE_UPLOAD_CONCURRENCY", 8, 1);
  return Math.min(value, 64);
}

/** A byte semaphore: `acquire(n)` waits until `n` more bytes fit under the limit (n is clamped to the limit). */
export class ByteBudget {
  private used = 0;
  private peakUsed = 0;
  private readonly waiters: Array<{ bytes: number; resolve: () => void }> = [];

  constructor(readonly limit: number) {}

  get inUse(): number { return this.used; }
  get peak(): number { return this.peakUsed; }

  async acquire(bytes: number, signal?: AbortSignal): Promise<number> {
    const n = Math.max(0, Math.min(bytes, this.limit));
    if (this.waiters.length === 0 && this.used + n <= this.limit) {
      this.take(n);
      return n;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { bytes: n, resolve: () => { signal?.removeEventListener("abort", onAbort); resolve(); } };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal!.reason instanceof Error ? signal!.reason : new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
    return n;
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
    // First come, first served: a large reservation is never starved by small ones behind it.
    while (this.waiters.length > 0 && this.used + this.waiters[0]!.bytes <= this.limit) {
      const next = this.waiters.shift()!;
      this.take(next.bytes);
      next.resolve();
    }
  }

  private take(n: number): void {
    this.used += n;
    this.peakUsed = Math.max(this.peakUsed, this.used);
  }
}

/** The process-wide ceiling, shared by every document job of this worker. */
let workerBudget: ByteBudget | null = null;
export function dopplerWorkerBudget(): ByteBudget {
  workerBudget ??= new ByteBudget(dopplerFigureWorkerBufferBytes());
  return workerBudget;
}
export function resetDopplerWorkerBudgetForTest(limit?: number): void {
  workerBudget = limit === undefined ? null : new ByteBudget(limit);
}

/** A reservation from the job budget and the worker ceiling together (always in that order, so they cannot deadlock). */
export async function reserve(budgets: { job: ByteBudget; worker: ByteBudget }, bytes: number, signal?: AbortSignal): Promise<() => void> {
  const job = await budgets.job.acquire(bytes, signal);
  let worker = 0;
  try {
    worker = await budgets.worker.acquire(Math.min(job, budgets.worker.limit), signal);
  } catch (error) {
    budgets.job.release(job);
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budgets.worker.release(worker);
    budgets.job.release(job);
  };
}

/** Runs `work` over `items` with at most `limit` in flight; the first failure stops new work and is rethrown after the rest settle. */
export async function boundedPool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, signal?: AbortSignal): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const runner = async () => {
    while (!failure && next < items.length) {
      if (signal?.aborted) { failure ??= { error: signal.reason }; return; }
      const item = items[next++]!;
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  if (failure) throw (failure as { error: unknown }).error;
}

/** The incremental check of one streamed file: size, SHA-256 and the format's signature on its first 64 and last 2 bytes. */
export interface StreamCheck {
  expectedSize: number;
  sha256: string | null;
  /** Signature check from the head (up to 64 bytes), the last 2 bytes and the size; null when none applies. */
  magic: ((head: Buffer, tail: Buffer, size: number) => boolean) | null;
}

/** Thrown inside a streamed upload when the bytes do not match; the caller maps it to its own refusal. */
export class StreamCheckError extends Error {
  constructor(readonly rule: "file-changed" | "sha256-mismatch" | "wrong-magic") {
    super(`stream check failed: ${rule}`);
    this.name = "StreamCheckError";
  }
}

/**
 * A Readable over an open file that reads `chunk` bytes per pull, hashes and checks as it goes, and ends only once the
 * whole file matched: a mismatch destroys the stream with StreamCheckError, so the upload reading it fails before it
 * completes. It never holds more than its high-water mark (one chunk) beyond what the consumer has taken.
 */
export function checkedFileStream(handle: FileHandle, check: StreamCheck, chunk = DOPPLER_UPLOAD_CHUNK_BYTES): Readable {
  const hash = createHash("sha256");
  let position = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  return new Readable({
    highWaterMark: chunk,
    read() {
      void (async () => {
        try {
          const remaining = check.expectedSize - position;
          const want = Math.min(chunk, remaining);
          const buffer = Buffer.allocUnsafe(Math.max(1, want));
          const { bytesRead } = want === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, want, position);
          if (bytesRead === 0 && position < check.expectedSize) throw new StreamCheckError("file-changed");
          const data = buffer.subarray(0, bytesRead);
          hash.update(data);
          if (head.length < 64) head = Buffer.concat([head, data.subarray(0, 64 - head.length)]);
          tail = Buffer.concat([tail, data.subarray(Math.max(0, data.length - 2))]).subarray(-2);
          position += bytesRead;
          if (position === check.expectedSize) {
            // The last chunk is checked before it is handed over: the upload never receives a complete body that fails.
            // One byte past the end: a file that grew since it was listed is refused, never cut short silently.
            const probe = await handle.read(Buffer.alloc(1), 0, 1, position);
            if (probe.bytesRead !== 0) throw new StreamCheckError("file-changed");
            if (check.sha256 !== null && hash.digest("hex") !== check.sha256) throw new StreamCheckError("sha256-mismatch");
            if (check.magic && !check.magic(head, tail, position)) throw new StreamCheckError("wrong-magic");
            if (data.length > 0) this.push(data);
            this.push(null);
            return;
          }
          this.push(data);
        } catch (error) {
          this.destroy(error as Error);
        }
      })();
    },
  });
}
