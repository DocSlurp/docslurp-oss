/**
 * Transient infrastructure errors: a dropped socket, a restarted database, an
 * unreachable peer. They say nothing about the document or the process, so
 * callers retry them (worker supervisor, activity failure classification).
 */

export function* causeChain(error: unknown): Generator<unknown> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && seen.size < 8) {
    seen.add(current);
    yield current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "57P01", "57P02", "57P03", "08000", "08003", "08006", "CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT",
]);

/**
 * `includeTimeouts` also treats "timed out" messages as transient. Leave it off for
 * activity classification, where a timeout may be the document's own hung work.
 */
export function isTransientNetworkError(error: unknown, options: { includeTimeouts?: boolean } = {}): boolean {
  for (const link of causeChain(error)) {
    const code = typeof link === "object" && link !== null ? (link as { code?: unknown }).code : undefined;
    if (typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code)) return true;
    if ((options.includeTimeouts === false ? /econnreset|connection terminated|socket hang up|connection refused|connection closed/i : /econnreset|connection terminated|socket hang up|connection refused|timed out|connection closed/i).test(messageOf(link))) return true;
  }
  return false;
}

/**
 * A database failing rather than the document: Postgres SQLSTATE classes 08 (connection), 53 (insufficient resources) and 57
 * (operator intervention: a statement timeout or cancellation, 57014, and shutdowns), a serialization failure or deadlock
 * (40001, 40P01), and a charge check that could not decide (SpendCheckUnavailableError, retryable by design). A retry
 * re-runs the work from durable state (a measured count is re-authorized; reads and charges already persisted are reused).
 */
export function isTransientDatabaseError(error: unknown): boolean {
  for (const link of causeChain(error)) {
    if (typeof link !== "object" || link === null) continue;
    if ((link as { name?: unknown }).name === "SpendCheckUnavailableError") return true;
    const code = (link as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && (/^(08|53|57)/.test(code) || code === "40001" || code === "40P01")) return true;
  }
  return false;
}

