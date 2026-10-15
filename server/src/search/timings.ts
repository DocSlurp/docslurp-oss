import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-search phase timings (setup, embed, vector, text, …), collected without
 * threading a parameter through every layer. Returned on search responses and
 * logged, so latency is visible where it is spent.
 */
const store = new AsyncLocalStorage<Record<string, number>>();

export type SearchTimings = Record<string, number>;

export async function collectSearchTimings<T>(fn: () => Promise<T>): Promise<{ value: T; timings: SearchTimings }> {
  const timings: SearchTimings = {};
  const started = performance.now();
  const value = await store.run(timings, fn);
  timings.totalMs = Math.round(performance.now() - started);
  return { value, timings };
}

/** Time one phase into the current search's timings (no-op outside a search). */
export async function timePhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timings = store.getStore();
  if (!timings) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const key = `${name}Ms`;
    timings[key] = Math.round((timings[key] ?? 0) + performance.now() - started);
  }
}
