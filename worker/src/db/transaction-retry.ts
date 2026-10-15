/**
 * Retry a whole transaction (or single autocommit statement) when Postgres
 * aborts it as a deadlock victim (40P01) or a serialization failure (40001).
 *
 * Postgres rolls the victim back completely, so re-running the same closure is
 * safe as long as the closure only writes through its transaction and resets
 * any outer variables it assigns at the top of each attempt. Checkpoint writes
 * qualify: usage events keep their stable ids (`on conflict (id) do nothing`),
 * and the in-memory batch is only committed after the transaction succeeds.
 *
 * This is defence in depth. The lock order (run row first, in FOR NO KEY
 * UPDATE mode, which never conflicts with the FOR KEY SHARE locks foreign-key
 * checks on child rows take) is what keeps checkpoints from deadlocking; see
 * spend-check.ts and checkpoint-lock-order.test.ts.
 */
const RETRYABLE_CODES = new Set(["40P01", "40001"]);

export function isRetryableTransactionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && RETRYABLE_CODES.has(code);
}

export interface TransactionRetryOptions {
  /** Total attempts including the first (default 4). */
  attempts?: number;
  /** Base backoff; each retry waits base * 2^n plus up to the same in jitter (default 20 ms). */
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function retryTransaction<T>(
  label: string,
  run: (attempt: number) => Promise<T>,
  options: TransactionRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 4));
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 20);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((message: string) => console.warn(message));
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.round(backoff + random() * backoff);
      log(
        `[db-retry] ${label} attempt=${attempt}/${attempts} code=${(error as { code: string }).code} ` +
          `retryInMs=${delay}`,
      );
      await sleep(delay);
    }
  }
}
