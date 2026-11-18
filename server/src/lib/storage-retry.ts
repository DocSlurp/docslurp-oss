/**
 * Retry for idempotent object-storage calls on the upload path (HEAD, conditional copy, list parts, multipart complete).
 *
 * Only failures that say nothing about the object are retried: provider 5xx and throttling, a timeout or dropped
 * connection, and the provider's spurious "bucket does not exist" (the bucket is configuration, checked at startup, so
 * that answer mid-upload is the provider's, not the caller's). A definite answer about the object (absent, precondition
 * failed, invalid part, no such upload, access denied) is returned to the caller at once, unchanged.
 */

const TRANSIENT_NAMES = new Set([
  "NoSuchBucket", "InternalError", "ServiceUnavailable", "SlowDown", "Throttling", "ThrottlingException",
  "RequestTimeout", "RequestTimeoutException", "TimeoutError", "NetworkingError",
]);
const TRANSIENT_SOCKET_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

type StorageLikeError = { name?: unknown; Code?: unknown; code?: unknown; cause?: unknown; $metadata?: { httpStatusCode?: number } };

/** True for a storage failure worth repeating: the provider (or the network) failed, not the request. */
export function isTransientStorageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as StorageLikeError;
  if (e.name === "ProjectIntakeError") return false;
  const name = typeof e.name === "string" ? e.name : typeof e.Code === "string" ? e.Code : "";
  if (TRANSIENT_NAMES.has(name)) return true;
  const status = e.$metadata?.httpStatusCode;
  if (typeof status === "number") return status >= 500 || status === 429;
  // No provider answer at all: a socket-level failure, possibly wrapped (fetch's "fetch failed" carries it as cause).
  const code = typeof e.code === "string" ? e.code : "";
  const causeCode = e.cause && typeof e.cause === "object" && typeof (e.cause as StorageLikeError).code === "string" ? (e.cause as { code: string }).code : "";
  return TRANSIENT_SOCKET_CODES.has(code) || TRANSIENT_SOCKET_CODES.has(causeCode);
}

/** Delays before the 2nd and 3rd attempts. Short: the session lock is held while files finalize. */
export const STORAGE_RETRY_DELAYS_MS: readonly number[] = [100, 400];

export async function withStorageRetry<T>(operation: () => Promise<T>, delaysMs: readonly number[] = STORAGE_RETRY_DELAYS_MS, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delaysMs.length || !isTransientStorageError(error) || signal?.aborted) throw error;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delaysMs[attempt]);
        const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}
