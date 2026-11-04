/** Keep cancellation observable during I/O, but never keep stalled planning alive forever.
 * Checkpoints renew the 60s progress window. Heartbeat timeout can start a retry
 * while old I/O is outstanding: callers must use idempotent writes. Cancellation
 * checkpoints prevent subsequent work, but cannot revoke an in-flight write.
 */
export async function withPlanningProgress<T>(
  signal: AbortSignal,
  heartbeat: (details: unknown) => void,
  work: (checkpoint: (phase: string, completed?: number) => void) => Promise<T>,
): Promise<T> {
  let lastProgress = Date.now();
  let details = { phase: "loading", completed: 0 };
  let heartbeatError: unknown;
  let expired = false;
  const isExpired = () => (expired ||= Date.now() - lastProgress >= 60_000);
  const checkpoint = (phase: string, completed = 0) => {
    signal.throwIfAborted();
    if (heartbeatError) throw heartbeatError;
    if (isExpired()) throw new Error("Planning progress deadline exceeded");
    lastProgress = Date.now();
    details = { phase, completed };
    heartbeat(details);
  };
  checkpoint("loading");
  const timer = setInterval(() => {
    if (signal.aborted || heartbeatError || isExpired()) return;
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
