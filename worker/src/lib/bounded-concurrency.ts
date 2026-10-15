/** Small concurrency primitives for stages that fan out provider requests. */

export interface ConcurrencyLimiter {
  readonly limit: number;
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** At most `limit` tasks run at once; the rest wait in FIFO order. */
export function createConcurrencyLimiter(limit: number): ConcurrencyLimiter {
  const max = Math.max(1, Math.floor(limit) || 1);
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    limit: max,
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      try {
        return await task();
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
}

/**
 * Run `task(0..count-1)` with at most `concurrency` in flight and return the
 * results in index order. After the first failure no new index starts; tasks
 * already in flight are awaited (their side effects, such as recorded spend,
 * still land) and then the first error is thrown.
 */
export async function runBounded<T>(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(count);
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= count) return;
      try {
        results[index] = await task(index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(concurrency) || 1, count));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (failed) throw firstError;
  return results;
}

/** Runs async callbacks one at a time, in call order, even when callers overlap. */
export function createSerialQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
}

/**
 * Coalesces frequent checkpoint requests into at most one write per
 * `intervalMs`. Writes are chained, so two never overlap (including the
 * final `flush()` write). `request()` returns at once; a background write
 * that failed is rethrown by the next `request()`, `check()` or `flush()`, so
 * a refused spend check still stops the caller. Background writes never
 * reject, so they cannot surface as unhandled rejections.
 */
export function createThrottledWriter(write: () => Promise<void>, intervalMs: number) {
  let lastWriteAt = 0;
  let tail: Promise<void> = Promise.resolve();
  let busy = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let error: unknown;
  let hasError = false;
  let writes = 0;

  const start = (): Promise<void> => {
    // Idle: start now (the async wrapper also turns a synchronous throw into a
    // rejection). Busy: chain behind the write in flight.
    const run = busy === 0 ? (async () => write())() : tail.then(() => write());
    busy++;
    lastWriteAt = Date.now();
    writes++;
    const pending = run
      .catch((caught) => {
        if (!hasError) {
          hasError = true;
          error = caught;
        }
      })
      .finally(() => {
        busy--;
      });
    tail = pending;
    return pending;
  };

  const throwIfFailed = () => {
    if (hasError) throw error;
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return {
    get writes() { return writes; },
    /** Throws the first failed background write, if any. */
    check(): void {
      throwIfFailed();
    },
    request(): void {
      throwIfFailed();
      if (timer) return;
      const wait = Math.max(0, lastWriteAt + intervalMs - Date.now());
      if (wait === 0 && busy === 0) {
        void start();
        return;
      }
      // A write still running when the timer fires is chained, not overlapped.
      timer = setTimeout(() => {
        timer = null;
        void start();
      }, Math.max(wait, 1));
    },
    /** Waits out pending writes, rethrows a failure, then always writes once more. */
    async flush(): Promise<void> {
      clearTimer();
      await tail;
      throwIfFailed();
      await start();
      throwIfFailed();
    },
    /**
     * Failure paths: drop a scheduled write, wait out any in flight, then make
     * one best-effort final write. Never throws, so the caller's error wins.
     */
    async drain(): Promise<void> {
      clearTimer();
      await tail;
      await start();
    },
    /** Drop a scheduled write and wait out any in flight, without throwing. */
    async settle(): Promise<void> {
      clearTimer();
      await tail;
    },
  };
}
