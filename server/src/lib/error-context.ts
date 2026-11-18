import { AsyncLocalStorage } from "node:async_hooks";
import { rejectionReasonId, sanitizeRejectionReason } from "./rejection-reason.js";

/**
 * Why the server refused a request, as telemetry may keep it: the response
 * status, the closed `code`, a stable `reasonId`, and the sanitized reason
 * (absent for 5xx, whose raw text stays on the exception path).
 */
export type RequestRejection = { status: number; code: string; reasonId: string; reason?: string };

/** Dependency-free correlation context: safe during Astro prerendering too. */
export const errorContext = new AsyncLocalStorage<{ requestId: string; userId?: string; rejection?: RequestRejection }>();

/**
 * Server-side tie between a recorded rejection and the error response it was
 * recorded for: by the Response object and by its body stream. Hono's `c.res`
 * setter rebuilds a response around the same body stream (and merges the old
 * response's headers into it, which is why a header marker would survive onto
 * an unrelated replacement). A replacement with a new body and no carried
 * rejection (another error, an unrelated rewrite) has none. Our middleware that
 * clones or rewrites the same error carries it explicitly (preservingRequestRejection).
 */
const rejectionByResponse = new WeakMap<Response, RequestRejection>();
const rejectionByBody = new WeakMap<ReadableStream, RequestRejection>();

function rejectionOf(response: Response): RequestRejection | undefined {
  return rejectionByResponse.get(response) ?? (response.body ? rejectionByBody.get(response.body) : undefined);
}

function attachRejection(response: Response, rejection: RequestRejection): void {
  rejectionByResponse.set(response, rejection);
  if (response.body) rejectionByBody.set(response.body, rejection);
}

/**
 * Records why an error response refused the request, for the request span and
 * the stdout completion line. Clients only see the generic copy for the code.
 * The reason is sanitized here, before it is stored (URLs keep scheme and host;
 * credentials, emails and signed-URL parameters are redacted; then capped).
 * A 5xx keeps only its code and reason id: its raw text belongs to the
 * exception report. Returns the response unchanged.
 */
export function recordRequestRejection(response: Response, code: string, reason: string): Response {
  const store = errorContext.getStore();
  if (!store) return response;
  const sanitized = sanitizeRejectionReason(reason);
  const rejection: RequestRejection = { status: response.status, code, reasonId: rejectionReasonId(code, sanitized), ...(response.status < 500 ? { reason: sanitized } : {}) };
  store.rejection = rejection;
  attachRejection(response, rejection);
  return response;
}

/**
 * Runs a middleware step that clones or rewrites `c.res` as the same response
 * (the public error envelope, deprecation warnings, the pipeline guard): a
 * clone swaps the body stream and a rewrite makes a new one, so the rejection
 * recorded for the response before the step is attached to the one after it.
 */
export function preservingRequestRejection(c: { res: Response }, step: () => unknown): void | Promise<void> {
  const rejection = rejectionOf(c.res);
  const result = step();
  if (result instanceof Promise) return result.then(() => { if (rejection) attachRejection(c.res, rejection); });
  if (rejection) attachRejection(c.res, rejection);
}

/** The rejection recorded for exactly this delivered response (same response or body, same status), if any. */
export function deliveredRejection(response: Response): RequestRejection | undefined {
  const rejection = rejectionOf(response);
  return rejection && rejection.status === response.status ? rejection : undefined;
}
