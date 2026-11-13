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

/** The active stream's state. Allocated once per stream (and once per sub-search), never per read. */
export interface SearchStreamState extends SearchStreamSink {
  /** Sub-search index while a decomposition, stepback or multi-hop child runs. */
  subSearch?: number;
  /** Ids whose hit body was already sent on this stream; shared by the root search and its sub-searches only. */
  sentIds: Set<string>;
}

const store = new AsyncLocalStorage<SearchStreamState>();

export function withSearchStreamSink<T>(sink: SearchStreamSink, fn: () => Promise<T>): Promise<T> {
  const state: SearchStreamState = {
    stats: sink.stats,
    hitLimit: sink.hitLimit,
    emit: (event) => sink.emit(event),
    sentIds: new Set(),
  };
  return store.run(state, fn);
}

/** Label every event emitted inside `fn` as belonging to sub-search `index`. */
export function withSearchStreamSubSearch<T>(index: number, fn: () => Promise<T>): Promise<T> {
  const state = store.getStore();
  return state ? store.run({ ...state, subSearch: index }, fn) : fn();
}

/** The active stream state, or undefined outside a streaming request. Allocation free; check it before building an event. */
export function currentSearchStreamSink(): SearchStreamState | undefined {
  return store.getStore();
}

/** Emit one event to the active sink. Never throws; a no-op outside a streaming request. */
export function emitSearchStreamEvent(build: (sink: SearchStreamState) => SearchStreamEventBody | null): void {
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
