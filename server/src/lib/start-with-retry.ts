/**
 * Start a background subscription that may fail while a dependency is down
 * (Postgres restarting, a network blip at boot) and keep trying until it
 * succeeds, instead of giving up after one logged error. The periodic sweeps
 * cover the gap meanwhile; this restores the low-latency path once the
 * dependency returns.
 */
export interface StartWithRetry {
  /** Resolves once started, or when stopped first. */
  started: Promise<void>;
  stop(): void;
}

export function startWithRetry(
  label: string,
  start: () => Promise<void>,
  options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    random?: () => number;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
    clearTimer?: (handle: unknown) => void;
    log?: (line: string) => void;
  } = {},
): StartWithRetry {
  const base = options.baseDelayMs ?? 1_000;
  const max = options.maxDelayMs ?? 60_000;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const log = options.log ?? ((line: string) => console.error(line));
  let stopped = false;
  let handle: unknown;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let attempt = 0;

  const tryStart = async (): Promise<void> => {
    if (stopped) return resolveStarted();
    try {
      await start();
      resolveStarted();
    } catch (error) {
      attempt += 1;
      const cap = Math.min(max, base * 2 ** (attempt - 1));
      const delayMs = Math.round(cap / 2 + random() * (cap / 2));
      log(`[${label}] start failed (attempt ${attempt}); retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`);
      if (stopped) return resolveStarted();
      handle = setTimer(() => { void tryStart(); }, delayMs);
      (handle as { unref?: () => void } | undefined)?.unref?.();
    }
  };
  void tryStart();

  return {
    started,
    stop() {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
      resolveStarted();
    },
  };
}
