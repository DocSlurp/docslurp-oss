import { withBackgroundSpan } from "@docslurp/shared/observability";
import { flushPendingCreditDebits } from "./credits.js";

/**
 * Applies pending credit debits (migration 0030) to org pools every few
 * seconds. Workers' maintenance leader runs the same flush every 2 s; this one
 * keeps billing current when no worker leads. Concurrent flushes are safe (one
 * org per transaction, busy orgs skipped). CREDIT_DEBIT_FLUSH_INTERVAL_MS=0
 * disables it.
 */
const FLUSH_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.CREDIT_DEBIT_FLUSH_INTERVAL_MS?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000;
})();

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runCreditDebitFlush(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await withBackgroundSpan("api.credit-debit-flush", () => flushPendingCreditDebits());
    if (result.debits > 0) {
      console.log(`[billing] credit-debit-flush orgs=${result.orgs} debits=${result.debits} credits=${result.credits.toFixed(6)}`);
    }
  } finally {
    running = false;
  }
}

export function startCreditDebitFlusher(): void {
  if (timer || FLUSH_INTERVAL_MS === 0) return;
  timer = setInterval(() => {
    runCreditDebitFlush().catch((error: unknown) => {
      console.error(`[billing] credit-debit flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

export function stopCreditDebitFlusher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
