import type { Context, MiddlewareHandler } from "hono";

/** Longest wait for the next body chunk. */
export const BODY_IDLE_TIMEOUT_MS = 30_000;

/**
 * Process-wide body reading settings (server.ts sets them from config):
 * - `bufferBudgetBytes`: bytes all bounded limiters together may hold at once
 *   (MAX_BUFFERED_REQUEST_BYTES); past it a request is answered 503 + Retry-After.
 * - `minBytesPerSecond`: the slowest sustained rate the overall read deadline
 *   allows for (BODY_READ_MIN_BYTES_PER_SECOND).
 */
const bodyReads = { bufferBudgetBytes: 256 * 1024 * 1024, minBytesPerSecond: 32 * 1024, inUse: 0 };

export function configureBodyReads(settings: { bufferBudgetBytes?: number; minBytesPerSecond?: number }): void {
  if (settings.bufferBudgetBytes !== undefined) bodyReads.bufferBudgetBytes = settings.bufferBudgetBytes;
  if (settings.minBytesPerSecond !== undefined) bodyReads.minBytesPerSecond = Math.max(1, settings.minBytesPerSecond);
}

/** Bytes bounded limiters hold right now, across requests. */
export function bufferedBodyBytes(): number {
  return bodyReads.inUse;
}

/** The overall deadline for reading a body of up to `maxSize` bytes: 60 s plus `maxSize` at the minimum rate. */
export function bodyReadDeadlineMs(maxSize: number): number {
  return 60_000 + Math.ceil((maxSize / bodyReads.minBytesPerSecond) * 1000);
}

/** Bytes this limiter actually read for a request it passed on (0 for an empty body). */
const observedBytes = new WeakMap<Request, number>();

/**
 * The byte count a bounded limiter observed for this exact Request, or
 * undefined when none ran. Unlike Content-Length it cannot be wrong.
 */
export function observedBodyBytes(request: Request): number | undefined {
  return observedBytes.get(request);
}

export type BoundedBodyLimitOptions = {
  /** Answer when the client stops sending (no chunk within `idleTimeoutMs`) or the overall deadline passes. */
  onTimeout: (c: Context) => Response;
  /** Answer when the process-wide buffer budget is spent (503 with Retry-After). */
  onBusy: (c: Context) => Response;
  idleTimeoutMs?: number;
  deadlineMs?: number;
};

/**
 * Count actual bytes before downstream readers, irrespective of Content-Length.
 * A request whose body stream carries no bytes leaves without a body: Node hosts
 * (Astro's adapter, @hono/node-server) hand every POST a stream, even one sent
 * with no Content-Length or `Content-Length: 0`, and readers downstream treat a
 * non-null `Request.body` as "the client sent content".
 *
 * Buffered bytes count against the process-wide budget until the rest of the
 * request has run. One idle timer (refreshed per chunk) and one overall timer
 * cancel the reader; there is no per-chunk promise. Empty chunks are skipped.
 */
export function boundedBodyLimit(maxSize: number, onError: (c: Context) => Response, options: BoundedBodyLimitOptions): MiddlewareHandler {
  const idleTimeoutMs = options.idleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
  return async (c, next) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxSize) return onError(c);
    const request = c.req.raw;
    if (!request.body) return next();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    };
    const deadline = setTimeout(expire, options.deadlineMs ?? bodyReadDeadlineMs(maxSize));
    const idle = setTimeout(expire, idleTimeoutMs);
    try {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (timedOut) return options.onTimeout(c);
          if (done) break;
          if (!value?.byteLength) continue;
          idle.refresh();
          size += value.byteLength;
          if (size > maxSize) {
            void reader.cancel().catch(() => {});
            return onError(c);
          }
          if (bodyReads.inUse + value.byteLength > bodyReads.bufferBudgetBytes) {
            void reader.cancel().catch(() => {});
            return options.onBusy(c);
          }
          bodyReads.inUse += value.byteLength;
          chunks.push(value);
        }
      } finally {
        clearTimeout(idle);
        clearTimeout(deadline);
        reader.releaseLock();
      }
      if (size === 0) {
        c.req.raw = withoutBody(request);
        observedBytes.set(c.req.raw, 0);
        return await next();
      }
      // The chunks as they arrived, without a second full-size copy.
      let position = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position < chunks.length) controller.enqueue(chunks[position++]!);
          else controller.close();
        },
      });
      c.req.raw = new Request(request, { body, duplex: "half" } as RequestInit);
      observedBytes.set(c.req.raw, size);
      await next();
    } finally {
      // Exactly what was reserved: a chunk over the cap or the budget was never kept.
      bodyReads.inUse -= chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    }
  };
}

/** The same request with no body. Keeps the client's abort signal (see forward-request.ts). */
function withoutBody(request: Request): Request {
  return new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal, redirect: request.redirect });
}
