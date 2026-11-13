import { AsyncLocalStorage } from "node:async_hooks";
import type { SearchStreamEventBody } from "@docslurp/shared";

/**
 * Request-scoped sink for streaming search events (`/v1/search/stream`).
 *
 * Search code reports legs and phases with `emitSearchStreamEvent`; outside a
 * streaming request there is no sink and every call is a no-op, so the
 * non-streaming path pays one AsyncLocalStorage read per event and builds
 * nothing. A sink must never throw into the search, and it must not block it:
 * the route queues writes itself.
 */
export interface SearchStreamSink {
  /** Whether per-leg and per-phase stats were requested. */
  stats: boolean;
  /** Cap on hits per `search.hits` event (the request's `limit`). */
  hitLimit: number;
  emit(event: SearchStreamEventBody): void;
}

interface SinkState {
  sink: SearchStreamSink;
  /** Sub-search index while a decomposition, stepback or multi-hop child runs. */
  subSearch?: number;
}

const store = new AsyncLocalStorage<SinkState>();

export function withSearchStreamSink<T>(sink: SearchStreamSink, fn: () => Promise<T>): Promise<T> {
  return store.run({ sink }, fn);
}

/** Label every event emitted inside `fn` as belonging to sub-search `index`. */
export function withSearchStreamSubSearch<T>(index: number, fn: () => Promise<T>): Promise<T> {
  const state = store.getStore();
  return state ? store.run({ sink: state.sink, subSearch: index }, fn) : fn();
}

/** The active sink, or undefined outside a streaming request. Check it before building an event. */
export function currentSearchStreamSink(): (SearchStreamSink & { subSearch?: number }) | undefined {
  const state = store.getStore();
  return state ? { ...state.sink, emit: state.sink.emit.bind(state.sink), subSearch: state.subSearch } : undefined;
}

/** Emit one event to the active sink. Never throws; a no-op outside a streaming request. */
export function emitSearchStreamEvent(build: (sink: SearchStreamSink & { subSearch?: number }) => SearchStreamEventBody | null): void {
  const sink = currentSearchStreamSink();
  if (!sink) return;
  try {
    const event = build(sink);
    if (!event) return;
    sink.emit(sink.subSearch === undefined || event.subSearch !== undefined ? event : { ...event, subSearch: sink.subSearch });
  } catch (error) {
    console.warn(`[search-stream] dropped event: ${error instanceof Error ? error.message : String(error)}`);
  }
}
