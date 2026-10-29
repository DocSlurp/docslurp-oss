/**
 * Ordered, bounded concurrency for media windows.
 *
 * Preparation (an ffmpeg cut through the sandboxed command runner) stays serial: at most one
 * cut per document at a time, as before, so concurrency never adds local untrusted-input
 * processes. Only the remote calls overlap. A window is prepared only when a call slot is free,
 * which bounds prepared-but-unsent bytes to `concurrency` windows.
 *
 * Failure: the first error stops new work, in-flight calls drain, then the error is thrown.
 * The media journal's durable in-flight cap ("Media concurrency exhausted") is a refusal before
 * any receipt exists; while this document has another call in flight the window waits for it and
 * retries with one slot fewer, otherwise the refusal is thrown exactly as in sequential processing.
 */

export const MEDIA_CONCURRENCY_EXHAUSTED = "Media concurrency exhausted";

export function isMediaConcurrencyRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(MEDIA_CONCURRENCY_EXHAUSTED);
}

export interface OrderedWindowOptions<I, P, R> {
  items: readonly I[];
  concurrency: number;
  prepare: (item: I, index: number) => Promise<P>;
  process: (prepared: P, item: I, index: number) => Promise<R>;
  /** Called once per completed window with its wall time (prepare excluded). */
  onTiming?: (item: I, index: number, ms: number) => void;
  signal?: AbortSignal;
}

export async function runOrderedWindows<I, P, R>(options: OrderedWindowOptions<I, P, R>): Promise<R[]> {
  const { items, prepare, process, signal } = options;
  let limit = Math.max(1, Math.floor(options.concurrency));
  const results = new Array<R>(items.length);
  const inFlight = new Set<Promise<void>>();
  const retry: Array<{ index: number; prepared: P }> = [];
  let next = 0;
  let failure: { error: unknown } | null = null;

  const launch = (index: number, prepared: P) => {
    const started = Date.now();
    const task = (async () => {
      try {
        results[index] = await process(prepared, items[index]!, index);
        options.onTiming?.(items[index]!, index, Date.now() - started);
      } catch (error) {
        // Another of our calls holds a journal slot: wait for it and run with one slot fewer.
        if (!failure && isMediaConcurrencyRefusal(error) && inFlight.size > 1) {
          limit = Math.max(1, limit - 1);
          retry.push({ index, prepared });
          return;
        }
        failure ??= { error };
      }
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  };

  while (!failure && (next < items.length || retry.length > 0 || inFlight.size > 0)) {
    if (signal?.aborted) { failure ??= { error: signal.reason ?? new Error("aborted") }; break; }
    if (inFlight.size < limit && retry.length > 0) {
      const { index, prepared } = retry.shift()!;
      launch(index, prepared);
      continue;
    }
    if (inFlight.size < limit && next < items.length) {
      const index = next++;
      let prepared: P;
      try {
        prepared = await prepare(items[index]!, index);
      } catch (error) {
        failure ??= { error };
        break;
      }
      if (failure) break;
      launch(index, prepared);
      continue;
    }
    if (inFlight.size === 0) break;
    await Promise.race(inFlight);
  }
  // Drain every in-flight call before returning or throwing: none may outlive the stage.
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  if (failure) throw failure.error;
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  return results;
}

/**
 * Calls per document: the flag, capped by the journal's durable in-flight limit and the window count.
 * Leased capacity providers stay sequential (their lease is acquired lazily on first call).
 */
export function mediaWindowConcurrency(args: { flag: number; journalMaxConcurrent: number; windows: number; leased: boolean }): number {
  if (args.leased) return 1;
  const flag = Number.isFinite(args.flag) ? Math.floor(args.flag) : 1;
  return Math.max(1, Math.min(flag, Math.floor(args.journalMaxConcurrent), Math.max(1, args.windows)));
}

export function readMediaWindowConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.MEDIA_WINDOW_CONCURRENCY ?? "1", 10);
  return Number.isFinite(value) && value >= 1 ? Math.min(value, 16) : 1;
}
