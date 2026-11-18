import type { Context, MiddlewareHandler } from "hono";

/** Longest wait for the next body chunk. */
export const BODY_IDLE_TIMEOUT_MS = 45_000;

/**
 * Hard ceiling on any request body held in memory, whatever a cap or the
 * environment asks for: larger files go to storage through direct upload sessions.
 */
export const MAX_IN_MEMORY_BODY_BYTES = 100 * 1024 * 1024;

/** Who a buffered body is charged to: authenticated requests by org (or user), public ones by client IP. */
export type BodyBudgetOwner = { pool: "authenticated" | "public"; key: string };

/**
 * Process-wide body buffering budgets (server.ts sets them from config). Past
 * any of them a request is answered 503 + Retry-After.
 * - `authenticatedBytes` (MAX_BUFFERED_REQUEST_BYTES): every authenticated
 *   body; of it, `smallReserveBytes` is kept for small requests (at most
 *   `smallRequestBytes`), so large bodies cannot starve them.
 * - `perOwnerBytes` (MAX_BUFFERED_REQUEST_BYTES_PER_ORG, default a quarter of
 *   the pool): one org's large bodies. Never below `largestBodyBytes` (the
 *   largest route cap, the bulk multipart cap), so one honest upload of the cap
 *   always fits, and never into the small-request reserve.
 * - `publicBytes` (MAX_PUBLIC_BUFFERED_REQUEST_BYTES): unauthenticated bodies
 *   (the SAML callback, webhooks), a separate pool, with at most a quarter of it
 *   (and `perIpBytes`) per client IP and `publicRequestBytes` per request.
 * - `minBytesPerSecond` (BODY_READ_MIN_BYTES_PER_SECOND): the slowest sustained
 *   rate the overall read deadline allows for.
 */
const bodyReads = {
  authenticatedBytes: 256 * 1024 * 1024,
  smallReserveBytes: 16 * 1024 * 1024,
  smallRequestBytes: 64 * 1024,
  perOwnerBytes: 64 * 1024 * 1024,
  largestBodyBytes: 25 * 1024 * 1024,
  publicBytes: 8 * 1024 * 1024,
  perIpBytes: 1024 * 1024,
  publicRequestBytes: 1024 * 1024,
  minBytesPerSecond: 32 * 1024,
};
type BodyReadSettings = typeof bodyReads;
const inUse = { authenticated: 0, public: 0 };
const ownerInUse = new Map<string, number>();

export function configureBodyReads(settings: Partial<BodyReadSettings> & { bufferBudgetBytes?: number }): void {
  const { bufferBudgetBytes, ...rest } = settings;
  if (bufferBudgetBytes !== undefined) bodyReads.authenticatedBytes = bufferBudgetBytes;
  for (const [key, value] of Object.entries(rest)) if (typeof value === "number") bodyReads[key as keyof BodyReadSettings] = value;
  bodyReads.minBytesPerSecond = Math.max(1, bodyReads.minBytesPerSecond);
}

/** The current settings (tests restore them after configuring). */
export function bodyReadSettings(): BodyReadSettings {
  return { ...bodyReads };
}

/** Bytes bounded limiters hold right now: all of them, or one pool's. */
export function bufferedBodyBytes(pool?: BodyBudgetOwner["pool"]): number {
  return pool ? inUse[pool] : inUse.authenticated + inUse.public;
}

/** Whether `owner` may hold `bytes` more, its request having `requestBytes` after them. */
function budgetAllows(owner: BodyBudgetOwner, bytes: number, requestBytes: number): boolean {
  const held = ownerInUse.get(owner.key) ?? 0;
  if (owner.pool === "public") {
    return inUse.public + bytes <= bodyReads.publicBytes && held + bytes <= Math.min(bodyReads.perIpBytes, bodyReads.publicBytes / 4);
  }
  if (requestBytes <= bodyReads.smallRequestBytes) return inUse.authenticated + bytes <= bodyReads.authenticatedBytes;
  // A large body: never into the small-request reserve (at most a quarter of the pool), nor past its org's share.
  const reserve = Math.min(bodyReads.smallReserveBytes, bodyReads.authenticatedBytes / 4);
  return inUse.authenticated + bytes <= bodyReads.authenticatedBytes - reserve
    && held + bytes <= perOwnerShare(reserve);
}

/** One org's share of the authenticated pool for large bodies (see bodyReads). */
function perOwnerShare(reserve: number): number {
  return Math.min(bodyReads.authenticatedBytes - reserve, Math.max(bodyReads.perOwnerBytes, bodyReads.largestBodyBytes));
}

/**
 * Startup warnings for budgets that cannot serve concurrent uploads of the
 * largest cap well: fewer than four fit in the pool (the rest get 503 while the
 * small-request reserve stays free).
 */
export function bodyBudgetWarnings(): string[] {
  const warnings: string[] = [];
  if (bodyReads.authenticatedBytes < 4 * bodyReads.largestBodyBytes) {
    warnings.push(`[body-budget] MAX_BUFFERED_REQUEST_BYTES (${bodyReads.authenticatedBytes}) holds fewer than 4 concurrent bodies of the ${bodyReads.largestBodyBytes}-byte multipart cap; more concurrent bulk uploads get 503 Retry-After`);
  }
  return warnings;
}

function charge(owner: BodyBudgetOwner, bytes: number): void {
  inUse[owner.pool] += bytes;
  ownerInUse.set(owner.key, (ownerInUse.get(owner.key) ?? 0) + bytes);
}

function refund(owner: BodyBudgetOwner, bytes: number): void {
  if (!bytes) return;
  inUse[owner.pool] -= bytes;
  const held = (ownerInUse.get(owner.key) ?? 0) - bytes;
  if (held > 0) ownerInUse.set(owner.key, held);
  else ownerInUse.delete(owner.key);
}

/** The overall deadline for reading a body of `maxSize` bytes: 60 s plus `maxSize` at the minimum rate. */
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
  /** Answer when a buffer budget is spent (503 with Retry-After). */
  onBusy: (c: Context) => Response;
  /** Who the body is charged to (default: an authenticated request of an unknown owner). */
  owner?: (c: Context) => BodyBudgetOwner;
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
export function boundedBodyLimit(requestedMaxSize: number, onError: (c: Context) => Response, options: BoundedBodyLimitOptions): MiddlewareHandler {
  const routeMaxSize = Math.min(requestedMaxSize, MAX_IN_MEMORY_BODY_BYTES);
  const idleTimeoutMs = options.idleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
  return async (c, next) => {
    const owner = options.owner?.(c) ?? { pool: "authenticated", key: "unknown" };
    // A public (unauthenticated) request is small whatever its route allows.
    const maxSize = owner.pool === "public" ? Math.min(routeMaxSize, bodyReads.publicRequestBytes) : routeMaxSize;
    const header = c.req.header("content-length");
    const declared = header === undefined || header.trim() === "" ? Number.NaN : Number(header);
    if (Number.isFinite(declared) && declared > maxSize) return onError(c);
    // Sized from the declared length when there is one (capped by maxSize): a small body gets a short deadline.
    const expectedBytes = Number.isFinite(declared) && declared >= 0 ? declared : maxSize;
    const request = c.req.raw;
    if (!request.body) return next();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let reserved = 0;
    let released = false;
    // Idempotent: on the request's end, or as soon as the client aborts.
    const release = () => {
      if (released) return;
      released = true;
      refund(owner, reserved);
    };
    let timedOut = false;
    let aborted = false;
    const expire = () => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    };
    // A client that goes away cancels the pending read and frees its reservation at once.
    const onAbort = () => {
      aborted = true;
      void reader.cancel().catch(() => {});
      release();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(expire, options.deadlineMs ?? bodyReadDeadlineMs(expectedBytes));
    const idle = setTimeout(expire, idleTimeoutMs);
    try {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (timedOut || aborted) return options.onTimeout(c);
          if (done) break;
          if (!value?.byteLength) continue;
          idle.refresh();
          size += value.byteLength;
          if (size > maxSize) {
            void reader.cancel().catch(() => {});
            return onError(c);
          }
          if (!budgetAllows(owner, value.byteLength, size)) {
            void reader.cancel().catch(() => {});
            return options.onBusy(c);
          }
          charge(owner, value.byteLength);
          reserved += value.byteLength;
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
      request.signal.removeEventListener("abort", onAbort);
      release();
    }
  };
}

/** The same request with no body. Keeps the client's abort signal (see forward-request.ts). */
function withoutBody(request: Request): Request {
  return new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal, redirect: request.redirect });
}
