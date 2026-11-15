/** One eager-load budget for search, table-open and refresh prewarms. Native
 * loads retain their slot after cancellation; queued callers are removed at once.
 */
const INDEX_WARM_CONCURRENCY = 2;
let indexWarmActive = 0;
const indexWarmQueue: Array<{ grant(): void }> = [];

export async function withIndexWarmSlot<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error("Index warm-up expired");
  // Hand a released slot straight to a waiter. An expired waiter removes its
  // closure immediately, so stalled native loads cannot retain an unbounded queue.
  if (indexWarmActive >= INDEX_WARM_CONCURRENCY) await new Promise<void>((resolve, reject) => {
    const cancel = () => {
      const at = indexWarmQueue.indexOf(waiter);
      if (at >= 0) indexWarmQueue.splice(at, 1);
      signal.removeEventListener("abort", cancel);
      reject(new Error("Queued index warm-up expired"));
    };
    const waiter = { grant: () => { signal.removeEventListener("abort", cancel); resolve(); } };
    indexWarmQueue.push(waiter);
    signal.addEventListener("abort", cancel, { once: true });
  });
  else indexWarmActive += 1;
  try {
    if (signal.aborted) throw new Error("Index warm-up expired");
    return await run();
  } finally {
    const next = indexWarmQueue.shift();
    if (next) next.grant(); else indexWarmActive -= 1;
  }
}
