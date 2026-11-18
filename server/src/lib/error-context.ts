import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { rejectionReasonId, sanitizeRejectionReason } from "./rejection-reason.js";

/**
 * Why the server refused a request, as telemetry may keep it: the response
 * status, the closed `code`, a stable `reasonId`, and the sanitized reason
 * (absent for 5xx, whose raw text stays on the exception path).
 */
export type RequestRejection = { status: number; code: string; reasonId: string; reason?: string; token: string };

/**
 * Internal header that ties a recorded rejection to the error response it was
 * recorded for. Copies of that response (the public error envelope, Hono's
 * response merges) carry it; the request-context middleware reads and strips
 * it before the response leaves, so a rejection is reported only for the
 * response actually delivered.
 */
export const REJECTION_TOKEN_HEADER = "x-docslurp-rejection-token";

/** Dependency-free correlation context: safe during Astro prerendering too. */
export const errorContext = new AsyncLocalStorage<{ requestId: string; userId?: string; rejection?: RequestRejection }>();

/**
 * Records why an error response refused the request, for the request span and
 * the stdout completion line. Clients only see the generic copy for the code.
 * The reason is sanitized here, before it is stored (URLs keep scheme and host;
 * credentials, emails and signed-URL parameters are redacted; then capped).
 * A 5xx keeps only its code and reason id: its raw text belongs to the
 * exception report. The latest error response replaces an earlier one.
 */
export function recordRequestRejection(response: Response, code: string, reason: string): Response {
  const store = errorContext.getStore();
  if (!store) return response;
  const sanitized = sanitizeRejectionReason(reason);
  const token = randomUUID();
  store.rejection = { status: response.status, code, reasonId: rejectionReasonId(code, sanitized), ...(response.status < 500 ? { reason: sanitized } : {}), token };
  response.headers.set(REJECTION_TOKEN_HEADER, token);
  return response;
}

/**
 * The recorded rejection, only when it explains this response: the response
 * carries its token and has its status. Strips the token header either way.
 */
export function takeDeliveredRejection(rejection: RequestRejection | undefined, response: Response): RequestRejection | undefined {
  let token: string | null = null;
  try {
    token = response.headers.get(REJECTION_TOKEN_HEADER);
    if (token !== null) response.headers.delete(REJECTION_TOKEN_HEADER);
  } catch { /* immutable headers carry no token */ }
  return rejection && token === rejection.token && response.status === rejection.status ? rejection : undefined;
}
