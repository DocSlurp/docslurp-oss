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
  /** Live check: the stream has settled or its client is gone, so no event would be written. Events are not even built then. */
  closed?: () => boolean;
  /** What the route knows about delivery; shared by every sub-search of the stream. The route passes its own object. */
  delivery?: SearchStreamDelivery;
}

/**
 * Billing handshake between the route and the engine. The route sets
 * `contentDelivered` once a `search.hits` frame with at least one hit has been
 * written, and the engine reads it when a root search fails: passages the
 * client already holds are billed even if the search then errors.
 */
export interface SearchStreamDelivery {
  /** A `search.hits` frame with at least one hit has been written to the client. */
  contentDelivered: boolean;
  /** The project the root search resolved, authorized by the access scope; set by the engine after setup. */
  projectId?: string;
  /**
   * Route hook: resolves once every hits frame the route accepted has been
   * written or dropped (bounded), so `contentDelivered` is exact. Without it
   * (nothing was ever accepted) the flag is already exact.
   */
  settle?: () => Promise<void>;
}

/** The active stream's state. Allocated once per stream (and once per sub-search), never per read. */
export interface SearchStreamState extends SearchStreamSink {
  /** Sub-search index while a decomposition, stepback or multi-hop child runs. */
  subSearch?: number;
  /** Ids whose hit body was already sent on this stream; shared by the root search and its sub-searches only. */
  sentIds: Set<string>;
  delivery: SearchStreamDelivery;
}

const store = new AsyncLocalStorage<SearchStreamState>();

export function withSearchStreamSink<T>(sink: SearchStreamSink, fn: () => Promise<T>): Promise<T> {
  const state: SearchStreamState = {
    stats: sink.stats,
    hitLimit: sink.hitLimit,
    emit: (event) => sink.emit(event),
    sentIds: new Set(),
    closed: sink.closed,
    delivery: sink.delivery ?? { contentDelivered: false },
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
  if (!sink || sink.closed?.()) return;
  try {
    const event = build(sink);
    if (!event) return;
    sink.emit(sink.subSearch === undefined || event.subSearch !== undefined ? event : { ...event, subSearch: sink.subSearch });
  } catch (error) {
    console.warn(`[search-stream] dropped event: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The active stream's delivery record, or undefined outside a streaming request. */
export function currentSearchStreamDelivery(): SearchStreamDelivery | undefined {
  return store.getStore()?.delivery;
}

/** Record the project the root search resolved (from its authorized scope), so a failure after delivery can be billed. */
export function noteSearchStreamProject(projectId: string): void {
  const delivery = store.getStore()?.delivery;
  if (delivery && delivery.projectId === undefined) delivery.projectId = projectId;
}
