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
 * Records why an error response refused the request, for the request span and
 * the stdout completion line. Clients only see the generic copy for the code.
 * The reason is sanitized here, before it is stored (URLs keep scheme and host;
 * credentials, emails and signed-URL parameters are redacted; then capped).
 * A 5xx keeps only its code and reason id: its raw text belongs to the
 * exception report. The latest error response replaces an earlier one.
 */
export function recordRequestRejection(status: number, code: string, reason: string): void {
  const store = errorContext.getStore();
  if (!store) return;
  const sanitized = sanitizeRejectionReason(reason);
  store.rejection = { status, code, reasonId: rejectionReasonId(code, sanitized), ...(status < 500 ? { reason: sanitized } : {}) };
}

/** The recorded rejection, only when it explains the response actually sent (same status). */
export function rejectionForStatus(rejection: RequestRejection | undefined, status: number): RequestRejection | undefined {
  return rejection && status >= 400 && rejection.status === status ? rejection : undefined;
}
