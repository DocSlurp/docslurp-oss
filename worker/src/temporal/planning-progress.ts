/** Keep cancellation observable during I/O, but never keep stalled planning alive forever.
 * Checkpoints renew the 60s progress window; in-flight I/O must settle before retry.
 */
export async function withPlanningProgress<T>(
  signal: AbortSignal,
  heartbeat: (details: unknown) => void,
  work: (checkpoint: (phase: string, completed?: number) => void) => Promise<T>,
): Promise<T> {
  let lastProgress = Date.now();
  let details = { phase: "loading", completed: 0 };
  let heartbeatError: unknown;
  const checkpoint = (phase: string, completed = 0) => {
    signal.throwIfAborted();
    if (heartbeatError) throw heartbeatError;
    lastProgress = Date.now();
    details = { phase, completed };
    heartbeat(details);
  };
  checkpoint("loading");
  const timer = setInterval(() => {
    if (signal.aborted || heartbeatError || Date.now() - lastProgress >= 60_000) return;
    try { heartbeat(details); } catch (error) { heartbeatError = error; }
  }, 10_000);
  try {
    const result = await work(checkpoint);
    checkpoint("complete");
    return result;
  } finally {
    clearInterval(timer);
  }
}
