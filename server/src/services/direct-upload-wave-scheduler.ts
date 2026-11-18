/**
 * In-process timers that ask for a direct-upload session's wave check soon (after a file is finalized, or when the wave
 * timer of its first waiting file runs out), so early ingestion does not wait for the reconciler's next sweep.
 *
 * Best effort only: the durable schedule (`upload_sessions.next_reconcile_at`) is always written first, and the sweep
 * covers a timer that is lost, skipped or fails. Timers run only where a handler is registered (the process running the
 * reconciler); elsewhere `requestDirectUploadWaveCheck` does nothing.
 */
type WaveCheckHandler = (sessionId: string) => Promise<void>;

let handler: WaveCheckHandler | null = null;
/** At most one timer per session: the earliest requested. */
const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
const running = new Map<string, Promise<void>>();
/** A check requested while one runs for the same session: run once more right after it. */
const again = new Set<string>();

export function registerDirectUploadWaveCheckHandler(next: WaveCheckHandler | null): void {
  handler = next;
  if (!next) {
    for (const { timer } of timers.values()) clearTimeout(timer);
    timers.clear();
    again.clear();
  }
}

export function requestDirectUploadWaveCheck(sessionId: string, delayMs = 0): void {
  if (!handler) return;
  const at = Date.now() + Math.max(0, delayMs);
  const existing = timers.get(sessionId);
  if (existing && existing.at <= at) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    run(sessionId);
  }, Math.max(0, delayMs));
  timer.unref?.();
  timers.set(sessionId, { at, timer });
}

function run(sessionId: string): void {
  const current = handler;
  if (!current) return;
  if (running.has(sessionId)) {
    again.add(sessionId);
    return;
  }
  const done = current(sessionId)
    .catch(error => console.error(`[upload-waves] check session=${sessionId} failed`, error instanceof Error ? error.name : "unknown"))
    .finally(() => {
      running.delete(sessionId);
      if (again.delete(sessionId)) run(sessionId);
    });
  running.set(sessionId, done);
}

/** Waits for the checks running now (shutdown and tests); pending timers are left to fire or be cleared. */
export async function settleDirectUploadWaveChecks(): Promise<void> {
  while (running.size > 0) await Promise.all([...running.values()]);
}
