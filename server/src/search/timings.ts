import { AsyncLocalStorage } from "node:async_hooks";
import { searchStreamPhaseSchema, type SearchStreamPhase } from "@docslurp/shared";

import { emitSearchStreamEvent } from "./stream-events.js";

/**
 * Per-search phase timings (setup, embed, vector, text, …), collected without
 * threading a parameter through every layer. Returned on search responses and
 * logged, so latency is visible where it is spent.
 */
const store = new AsyncLocalStorage<Record<string, number>>();

/** Streaming search reports the phases the contract names; any other timing name stays internal. */
const STREAM_PHASES: ReadonlySet<string> = new Set(searchStreamPhaseSchema.options);

export function emitSearchPhase(phase: SearchStreamPhase, ms: number): void {
  emitSearchStreamEvent((sink) => sink.stats ? { type: "search.phase", phase, stats: { ms: Math.round(ms) } } : null);
}

function reportStreamPhase(name: string, ms: number): void {
  if (STREAM_PHASES.has(name)) emitSearchPhase(name as SearchStreamPhase, ms);
}

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
    const elapsed = performance.now() - started;
    timings[key] = Math.round((timings[key] ?? 0) + elapsed);
    reportStreamPhase(name, elapsed);
  }
}

/** Add a measured duration to the current search's timings (no-op outside a search). */
export function recordSearchPhase(name: string, ms: number): void {
  const timings = store.getStore();
  if (!timings) return;
  const key = `${name}Ms`;
  timings[key] = Math.round((timings[key] ?? 0) + ms);
  reportStreamPhase(name, ms);
}

/** Count an event (cache hit/miss, …) into the current search's timings (no-op outside a search). */
export function countSearchEvent(name: string): void {
  const timings = store.getStore();
  if (timings) timings[name] = (timings[name] ?? 0) + 1;
}

/** How often `name` was counted in the current search (0 outside a search). */
export function searchEventCount(name: string): number {
  return store.getStore()?.[name] ?? 0;
}

/**
 * A search branch hit SEARCH_STATEMENT_TIMEOUT_MS (search.ts counts
 * `<branch>Timeout` events). Pollers and pending-search retries stop on it:
 * re-running the same statement would time out again.
 */
export function searchHitStatementTimeout(response: { timings?: Record<string, number> }): boolean {
  return Object.entries(response.timings ?? {}).some(([key, value]) => key.endsWith("Timeout") && value > 0);
}
