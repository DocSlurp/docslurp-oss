/**
 * Page fan-out with per-org slot back-pressure.
 *
 * Workflow-safe: no I/O and no Temporal imports. The workflow injects
 * `waitFor` (Temporal `condition`), `sleep`, `now` and `random`, which are
 * deterministic inside the sandbox; tests inject plain timers.
 *
 * At most `concurrency` bundles are in flight. When an activity reports that
 * the org has no free worker slot, the run shrinks its window to what it is
 * actually running (multiplicative decrease), backs off with jitter, and only
 * grows the window again (+1 per success) after a quiet period. A run that
 * shares its org's slots with other runs therefore converges on its share
 * without one denied activity — and five history events — per slot per tick.
 */

import type { UsageSummary } from "./shared.js";

export interface PageFanOutOptions<B> {
  bundles: B[];
  concurrency: number;
  run: (bundle: B) => Promise<UsageSummary>;
  onUsage: (usage: UsageSummary) => void;
  isSlotUnavailable: (error: unknown) => boolean;
  waitFor: (predicate: () => boolean) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  isPaused: () => boolean;
  isCancelled: () => boolean;
  /** Wait this long after the last denial before widening the window again. */
  quietPeriodMs?: number;
  /** Observability hook: window size after each change. */
  onWindow?: (limit: number, inFlight: number) => void;
}

export interface PageFanOutStats {
  dispatched: number;
  slotDenials: number;
  minWindow: number;
}

/** Jittered exponential backoff for slot denials: 1–2 s, 2–4 s, … capped at 15–30 s. */
export function slotBackoffMs(consecutiveDenials: number, random: () => number): number {
  const ceiling = Math.min(30_000, 2_000 * 2 ** Math.max(0, Math.min(consecutiveDenials, 4)));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export async function runPageFanOut<B>(options: PageFanOutOptions<B>): Promise<PageFanOutStats> {
  const max = Math.max(1, Math.floor(options.concurrency));
  const quietPeriodMs = options.quietPeriodMs ?? 10_000;
  const pending = [...options.bundles];
  const stats: PageFanOutStats = { dispatched: 0, slotDenials: 0, minWindow: max };
  let limit = max;
  let inFlight = 0;
  let backingOff = 0;
  let consecutiveDenials = 0;
  let lastDenialAt = Number.NEGATIVE_INFINITY;
  let failure: { error: unknown } | undefined;

  const stop = () => failure !== undefined || options.isCancelled();
  const canDispatch = () =>
    pending.length > 0 && inFlight < limit && backingOff === 0 && !options.isPaused();

  const lane = async (): Promise<void> => {
    for (;;) {
      await options.waitFor(() => stop() || canDispatch() || (pending.length === 0 && backingOff === 0));
      if (stop() || pending.length === 0) return;
      const bundle = pending.shift()!;
      inFlight += 1;
      stats.dispatched += 1;
      try {
        const usage = await options.run(bundle);
        inFlight -= 1;
        consecutiveDenials = 0;
        if (limit < max && options.now() - lastDenialAt >= quietPeriodMs) {
          limit += 1;
          options.onWindow?.(limit, inFlight);
        }
        options.onUsage(usage);
      } catch (error) {
        inFlight -= 1;
        if (!options.isSlotUnavailable(error) || options.isCancelled()) {
          failure ??= { error };
          return;
        }
        // The org is full: keep only what this run is actually running.
        stats.slotDenials += 1;
        pending.unshift(bundle);
        limit = Math.max(1, Math.min(limit, inFlight));
        stats.minWindow = Math.min(stats.minWindow, limit);
        lastDenialAt = options.now();
        options.onWindow?.(limit, inFlight);
        backingOff += 1;
        try {
          await options.sleep(slotBackoffMs(consecutiveDenials++, options.random));
        } finally {
          backingOff -= 1;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(pending.length, max) }, lane));
  if (failure) throw failure.error;
  return stats;
}

/** Groups consecutive same-document tasks into bundles of at most `size`. */
export function bundlePageTasks<T extends { documentId: string }>(tasks: T[], size: number): T[][] {
  const bundleSize = Math.max(1, Math.min(8, Math.floor(size)));
  const bundles: T[][] = [];
  for (const task of tasks) {
    const previous = bundles[bundles.length - 1];
    if (previous && previous.length < bundleSize && previous[0]!.documentId === task.documentId) previous.push(task);
    else bundles.push([task]);
  }
  return bundles;
}
