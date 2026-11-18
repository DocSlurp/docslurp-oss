import type { Context, MiddlewareHandler } from "hono";

/**
 * Count actual bytes before downstream readers, irrespective of Content-Length.
 * A request whose body stream carries no bytes leaves without a body: Node hosts
 * (Astro's adapter, @hono/node-server) hand every POST a stream, even one sent
 * with no Content-Length or `Content-Length: 0`, and readers downstream treat a
 * non-null `Request.body` as "the client sent content".
 */
/** Longest wait for the next body chunk. */
export const BODY_IDLE_TIMEOUT_MS = 30_000;
/** Slowest sustained upload rate the overall deadline allows for (128 KiB/s), on top of a fixed minute. */
const MIN_BODY_BYTES_PER_SECOND = 128 * 1024;

/** The overall deadline for reading a body of up to `maxSize` bytes: 60 s plus `maxSize` at 128 KiB/s. */
export function bodyReadDeadlineMs(maxSize: number): number {
  return 60_000 + Math.ceil((maxSize / MIN_BODY_BYTES_PER_SECOND) * 1000);
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
  idleTimeoutMs?: number;
  deadlineMs?: number;
};

export function boundedBodyLimit(maxSize: number, onError: (c: Context) => Response, options: BoundedBodyLimitOptions): MiddlewareHandler {
  const idleTimeoutMs = options.idleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
  const deadlineMs = options.deadlineMs ?? bodyReadDeadlineMs(maxSize);
  return async (c, next) => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > maxSize) return onError(c);
    const request = c.req.raw;
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      // A client that declares a body and trickles (or stops) cannot hold the request open forever.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"timeout">(resolve => { deadlineTimer = setTimeout(() => resolve("timeout"), deadlineMs); });
      try {
        while (true) {
          const idle = new Promise<"timeout">(resolve => { idleTimer = setTimeout(() => resolve("timeout"), idleTimeoutMs); });
          const read = await Promise.race([reader.read(), idle, deadline]);
          clearTimeout(idleTimer);
          if (read === "timeout") {
            void reader.cancel().catch(() => {});
            return options.onTimeout(c);
          }
          const { done, value } = read;
          if (done) break;
          size += value.byteLength;
          if (size > maxSize) {
            void reader.cancel().catch(() => {});
            return onError(c);
          }
          chunks.push(value);
        }
      } finally {
        clearTimeout(idleTimer);
        clearTimeout(deadlineTimer);
        reader.releaseLock();
      }
      if (size === 0) {
        c.req.raw = withoutBody(request);
        observedBytes.set(c.req.raw, 0);
        return next();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      c.req.raw = new Request(request, { body });
      observedBytes.set(c.req.raw, size);
    }
    await next();
  };
}

/** The same request with no body. Keeps the client's abort signal (see forward-request.ts). */
function withoutBody(request: Request): Request {
  return new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal, redirect: request.redirect });
}
