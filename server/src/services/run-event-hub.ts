import { withBackgroundSpan } from "@docslurp/shared/observability";
import type { WorkspaceRunEvent } from "@docslurp/shared";

/**
 * Live run-event fan-out for one API process.
 *
 * `workspace_run_events` is the source of truth; NOTIFY on `run_events` is
 * only a wake-up hint (`{"runIds":[…]}`) that workers send at most once per
 * flush window (worker/src/db/run-event-store.ts). On a hint the hub reads
 * new rows for the hinted runs by cursor (index `(run_id, created_at)`) in one
 * query and dispatches them, in table order, to every interested subscriber.
 * Runs with a dedicated subscriber are also polled every `pollMs`, so a lost
 * hint (listener reconnect, worker crash between insert and hint) delays
 * delivery but never drops an event.
 *
 * Cursor reads re-scan a short `lookbackMs` window and skip ids already seen:
 * events from another worker can commit after a later-stamped event was read.
 */

export const RUN_EVENTS_CHANNEL = "run_events";

/** The hint a producer sends after committing events for `runIds`. */
export function encodeRunEventHint(runIds: string[]): string {
  return JSON.stringify({ runIds });
}

export interface RunEventHubRow {
  event: WorkspaceRunEvent;
  /** Exact `created_at` (microseconds) used as the paging cursor. */
  cursor: string;
}

export interface RunEventHubDeps {
  listen(onHint: (payload: string) => void): Promise<{ close(): Promise<void> }>;
  /** Events with created_at >= `after` for each run, ordered by created_at, id. */
  fetchEvents(cursors: Array<{ runId: string; after: string }>, limit: number): Promise<RunEventHubRow[]>;
  /** Events already present for a run within `lookbackMs` of its newest event. */
  latestEvents(runId: string, lookbackMs: number): Promise<RunEventHubRow[]>;
}

export interface RunEventHubOptions {
  lookbackMs: number;
  pollMs: number;
  batchLimit: number;
  /** Forget per-run cursors this long after the last subscriber interest. */
  idleRunMs: number;
}

const DEFAULT_OPTIONS: RunEventHubOptions = {
  lookbackMs: 15_000,
  pollMs: 5_000,
  batchLimit: 500,
  idleRunMs: 10 * 60_000,
};

type Subscriber = {
  runId: string | null;
  onEvent: (event: WorkspaceRunEvent) => void | Promise<void>;
  chain: Promise<void>;
};

type RunCursor = {
  /** Newest created_at seen, in ms (lookback arithmetic). */
  cursorMs: number;
  seen: Map<string, number>;
  touchedAt: number;
};

/** Accepts `{"runIds":[…]}` hints, and full legacy event payloads during a rolling deploy. */
export function parseRunEventHint(payload: string): string[] {
  try {
    const parsed = JSON.parse(payload) as { runIds?: unknown; runId?: unknown };
    if (Array.isArray(parsed.runIds)) return parsed.runIds.filter((id): id is string => typeof id === "string");
    if (typeof parsed.runId === "string") return [parsed.runId];
  } catch {
    // Ignore malformed hints; polling still converges.
  }
  return [];
}

/** Cursors are ISO-8601 UTC with microseconds; ms precision is enough for lookback arithmetic. */
function toMs(cursor: string): number {
  const ms = Date.parse(cursor);
  return Number.isFinite(ms) ? ms : 0;
}

export class RunEventHub {
  private readonly options: RunEventHubOptions;
  private readonly subscribers = new Set<Subscriber>();
  private readonly runs = new Map<string, RunCursor>();
  private readonly pending = new Set<string>();
  private listener: Promise<{ close(): Promise<void> }> | null = null;
  private draining: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: RunEventHubDeps, options: Partial<RunEventHubOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Subscribe to one run's events, or to every run's (`runId` omitted). */
  async subscribe(
    onEvent: Subscriber["onEvent"],
    filter: { runId?: string } = {},
  ): Promise<{ close(): Promise<void> }> {
    await this.ensureListening();
    const runId = filter.runId ?? null;
    if (runId && !this.runs.has(runId)) {
      // Start after what already exists, so a new subscriber sees only new events.
      const existing = await this.deps.latestEvents(runId, this.options.lookbackMs);
      const cursor: RunCursor = { cursorMs: 0, seen: new Map(), touchedAt: Date.now() };
      for (const row of existing) {
        const ms = toMs(row.cursor);
        cursor.seen.set(row.event.id, ms);
        cursor.cursorMs = Math.max(cursor.cursorMs, ms);
      }
      if (!this.runs.has(runId)) this.runs.set(runId, cursor);
    }
    const subscriber: Subscriber = { runId, onEvent, chain: Promise.resolve() };
    this.subscribers.add(subscriber);
    this.updatePolling();
    return {
      close: async () => {
        this.subscribers.delete(subscriber);
        this.updatePolling();
        await subscriber.chain;
      },
    };
  }

  /** Wake for the given runs (a NOTIFY hint, or a poll tick). Resolves when they are drained. */
  async wake(runIds: Iterable<string>): Promise<void> {
    for (const runId of runIds) if (this.isInteresting(runId)) this.pending.add(runId);
    await this.drain();
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const listener = this.listener;
    this.listener = null;
    await (await listener)?.close();
  }

  private isInteresting(runId: string): boolean {
    for (const subscriber of this.subscribers) {
      if (subscriber.runId === null || subscriber.runId === runId) return true;
    }
    return false;
  }

  private async ensureListening(): Promise<void> {
    this.listener ??= this.deps.listen((payload) => {
      withBackgroundSpan("api.run-events-notify", () => this.wake(parseRunEventHint(payload))).catch((error) => {
        console.error("run event drain failed:", error instanceof Error ? error.message : String(error));
      });
    }).catch((error) => {
      this.listener = null;
      throw error;
    });
    await this.listener;
  }

  private updatePolling(): void {
    const polled = [...this.subscribers].some((subscriber) => subscriber.runId !== null);
    if (polled && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        const runIds = [...this.subscribers].flatMap((subscriber) => subscriber.runId ? [subscriber.runId] : []);
        withBackgroundSpan("api.run-events-poll", () => this.wake(runIds)).catch((error) => {
          console.error("run event poll failed:", error instanceof Error ? error.message : String(error));
        });
      }, this.options.pollMs);
      this.pollTimer.unref?.();
    } else if (!polled && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** One drain at a time; hints arriving meanwhile coalesce into the next pass. */
  private drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        while (this.pending.size > 0) {
          const runIds = [...this.pending];
          this.pending.clear();
          await this.fetchAndDispatch(runIds);
        }
        this.forgetIdleRuns();
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  private async fetchAndDispatch(runIds: string[]): Promise<void> {
    const now = Date.now();
    for (const runId of runIds) {
      const cursor = this.runs.get(runId);
      if (cursor) cursor.touchedAt = now;
      // A run first seen through an all-runs subscription starts one lookback window back.
      else this.runs.set(runId, { cursorMs: now - this.options.lookbackMs, seen: new Map(), touchedAt: now });
    }

    let pageAfter: string | null = null;
    for (let page = 0; page < 20; page++) {
      const cursors = runIds.map((runId) => {
        const lookbackStartMs = this.runs.get(runId)!.cursorMs - this.options.lookbackMs;
        const after = pageAfter && toMs(pageAfter) > lookbackStartMs ? pageAfter : new Date(lookbackStartMs).toISOString();
        return { runId, after };
      });
      const rows = await this.deps.fetchEvents(cursors, this.options.batchLimit);
      for (const row of rows) {
        const cursor = this.runs.get(row.event.runId);
        if (!cursor || cursor.seen.has(row.event.id)) continue;
        const ms = toMs(row.cursor);
        cursor.seen.set(row.event.id, ms);
        cursor.cursorMs = Math.max(cursor.cursorMs, ms);
        this.dispatch(row.event);
      }
      if (rows.length < this.options.batchLimit) break;
      pageAfter = rows[rows.length - 1]!.cursor;
    }

    for (const runId of runIds) {
      const cursor = this.runs.get(runId)!;
      const horizon = cursor.cursorMs - this.options.lookbackMs;
      for (const [id, ms] of cursor.seen) if (ms < horizon) cursor.seen.delete(id);
    }
  }

  private dispatch(event: WorkspaceRunEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.runId !== null && subscriber.runId !== event.runId) continue;
      // Per-subscriber chain: in order for each subscriber, and a slow one never blocks the others.
      subscriber.chain = subscriber.chain.then(() => subscriber.onEvent(event)).catch((error) => {
        console.error("run event subscriber failed:", error instanceof Error ? error.message : String(error));
      });
    }
  }

  private forgetIdleRuns(): void {
    const cutoff = Date.now() - this.options.idleRunMs;
    for (const [runId, cursor] of this.runs) {
      if (cursor.touchedAt < cutoff && !this.isSubscribedRun(runId)) this.runs.delete(runId);
    }
  }

  private isSubscribedRun(runId: string): boolean {
    for (const subscriber of this.subscribers) if (subscriber.runId === runId) return true;
    return false;
  }
}
