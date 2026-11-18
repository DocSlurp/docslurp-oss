import { AsyncLocalStorage } from "node:async_hooks";

/** Why the server refused a request: the closed `code` and the raw, server-authored reason. */
export type RequestRejection = { code: string; reason: string };

/** Dependency-free correlation context: safe during Astro prerendering too. */
export const errorContext = new AsyncLocalStorage<{ requestId: string; userId?: string; rejection?: RequestRejection }>();

/**
 * Records the raw reason behind an error response for the request's span and
 * completion log. Clients only see the generic copy for the code; telemetry gets
 * the reason, so a 400 refused by middleware is never a mystery. The last
 * rejection recorded in a request wins.
 */
export function recordRequestRejection(code: string, reason: string): void {
  const store = errorContext.getStore();
  if (store) store.rejection = { code, reason: reason.slice(0, 1000) };
}
