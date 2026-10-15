import { randomUUID } from "node:crypto";

import type { JSONValue, Sql } from "postgres";

import type { WorkspaceRunEvent } from "../models.js";

/**
 * Run events: the durable log is `workspace_run_events`; NOTIFY is only a
 * wake-up hint.
 *
 * Every NOTIFY-bearing commit takes PostgreSQL's database-wide notify-queue
 * lock and holds it through the commit's WAL flush, so notifying once per
 * event serialized the whole fleet's commits (2026-10-09 load test: 858
 * backends queued on it at 576 slots). Workers therefore buffer events per
 * process and write them in one multi-row insert at most every
 * `WORKER_RUN_EVENT_FLUSH_MS` (default 500 ms), with a single
 * `{"runIds":[…]}` hint per flush. Terminal run events flush immediately.
 * Listeners read events by cursor from the table (see
 * server/src/services/run-event-hub.ts), so the hint carries no event data
 * and a lost hint only delays delivery until the next poll.
 */
export const RUN_EVENTS_CHANNEL = "run_events";

/** Run-level outcomes a live viewer must see without waiting for the next flush. */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

/** Run ids per hint; keeps each payload far below PostgreSQL's 8,000-byte NOTIFY limit. */
const RUN_IDS_PER_HINT = 100;
const MAX_ROWS_PER_INSERT = 500;

export function encodeRunEventHints(runIds: Iterable<string>): string[] {
  const unique = [...new Set(runIds)];
  const payloads: string[] = [];
  for (let offset = 0; offset < unique.length; offset += RUN_IDS_PER_HINT) {
    payloads.push(JSON.stringify({ runIds: unique.slice(offset, offset + RUN_IDS_PER_HINT) }));
  }
  return payloads;
}

type StampedRunEvent = WorkspaceRunEvent & { id: string; createdAtIso: string };

let lastStampMicros = 0;

/**
 * Strictly increasing microsecond timestamps within this process, so events
 * written in one batch (often within the same millisecond) keep emission
 * order under `order by created_at, id`.
 */
function nextEventTimestamp(): string {
  const micros = Math.max(Date.now() * 1_000, lastStampMicros + 1);
  lastStampMicros = micros;
  const iso = new Date(Math.floor(micros / 1_000)).toISOString();
  return `${iso.slice(0, -1)}${String(micros % 1_000).padStart(3, "0")}Z`;
}

function stamp(event: WorkspaceRunEvent): StampedRunEvent {
  if ("createdAtIso" in event) return event as StampedRunEvent;
  return {
    ...event,
    id: event.id ?? randomUUID(),
    createdAtIso: event.createdAt ? event.createdAt.toISOString() : nextEventTimestamp(),
  };
}

function eventRow(event: StampedRunEvent) {
  // Round-trip through JSON so Dates and undefined values serialize as they did per row.
  const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? {})) as JSONValue;
  return {
    id: event.id,
    user_id: event.userId,
    run_id: event.runId,
    document_id: event.documentId ?? null,
    stage_name: event.stageName ?? null,
    event_type: event.eventType,
    status: event.status ?? null,
    message: event.message ?? null,
    progress: json(event.progress),
    stats: json(event.stats),
    payload: json(event.payload),
    created_at: event.createdAtIso,
  };
}

/**
 * Inserts events and, unless `notify` is false, sends one hint per 100
 * distinct runs, all in one commit. Rows are sent in statements of at most
 * ~48 KB of JSON (one statement for a typical flush; a larger flush wraps its
 * statements in one transaction). Ids make retries idempotent.
 */
export async function insertWorkspaceRunEvents(args: {
  sql: Sql<Record<string, unknown>>;
  events: WorkspaceRunEvent[];
  notify?: boolean;
}): Promise<void> {
  if (args.events.length === 0) return;
  const stamped = args.events.map(stamp);
  const hints = args.notify === false ? [] : encodeRunEventHints(stamped.map((event) => event.runId));
  const chunks = chunkRows(stamped.map(eventRow));
  if (chunks.length === 1) {
    await insertChunk(args.sql, chunks[0]!, hints);
    return;
  }
  await args.sql.begin(async (tx) => {
    const client = tx as unknown as Sql<Record<string, unknown>>;
    for (const [index, chunk] of chunks.entries()) {
      await insertChunk(client, chunk, index === chunks.length - 1 ? hints : []);
    }
  });
}

const MAX_CHUNK_BYTES = 48 * 1024;

function chunkRows(rows: ReturnType<typeof eventRow>[]): ReturnType<typeof eventRow>[][] {
  const chunks: ReturnType<typeof eventRow>[][] = [];
  let current: ReturnType<typeof eventRow>[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (current.length > 0 && bytes + size > MAX_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function insertChunk(
  sql: Sql<Record<string, unknown>>,
  rows: ReturnType<typeof eventRow>[],
  hints: string[],
): Promise<void> {
  await sql`
    with inserted as (
      insert into workspace_run_events (
        id, user_id, run_id, document_id, stage_name, event_type, status,
        message, progress, stats, payload, created_at
      )
      select
        r.id, r.user_id, r.run_id, r.document_id, r.stage_name, r.event_type, r.status,
        r.message, coalesce(r.progress, '{}'::jsonb), coalesce(r.stats, '{}'::jsonb),
        coalesce(r.payload, '{}'::jsonb), r.created_at
      from jsonb_to_recordset(${sql.json(rows as unknown as JSONValue)}::jsonb) as r(
        id text, user_id text, run_id text, document_id text, stage_name text, event_type text,
        status text, message text, progress jsonb, stats jsonb, payload jsonb, created_at timestamptz
      )
      on conflict (id) do nothing
      returning 1
    )
    select pg_notify(${RUN_EVENTS_CHANNEL}, hint)
    from jsonb_array_elements_text(${sql.json(hints)}::jsonb) as hint
  `;
}

/** Writes one event now (and hints its run). For low-volume paths outside the worker hot path. */
export async function appendWorkspaceRunEvent(args: {
  sql: Sql<Record<string, unknown>>;
  event: WorkspaceRunEvent;
}): Promise<void> {
  await insertWorkspaceRunEvents({ sql: args.sql, events: [args.event] });
}

export interface RunEventPublisherOptions {
  /** Coalescing window. 0 writes every event through immediately (one hint per event). */
  flushMs: number;
  /** Buffered events above this are dropped oldest-first (non-terminal only) while the database is unreachable. */
  maxBuffered: number;
}

export function resolveRunEventPublisherOptions(env: NodeJS.ProcessEnv = process.env): RunEventPublisherOptions {
  const int = (value: string | undefined, fallback: number) => {
    const parsed = Number.parseInt(value?.trim() ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    flushMs: Math.min(5_000, int(env.WORKER_RUN_EVENT_FLUSH_MS, 500)),
    maxBuffered: Math.max(100, int(env.WORKER_RUN_EVENT_MAX_BUFFERED, 20_000)),
  };
}

function isIntegrityError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("23");
}

/**
 * Per-process run event buffer. `append` timestamps and ids an event at call
 * time (so table order is emission order), then returns; a timer writes the
 * buffer in one statement with one hint. Terminal run events, `flush()` and
 * `close()` write synchronously and surface errors to the caller.
 */
export class RunEventPublisher {
  private buffer: StampedRunEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly sql: Sql<Record<string, unknown>>,
    private readonly options: RunEventPublisherOptions = resolveRunEventPublisherOptions(),
  ) {}

  get pending(): number {
    return this.buffer.length;
  }

  async append(event: WorkspaceRunEvent): Promise<void> {
    this.buffer.push(stamp(event));
    this.trim();
    if (this.closed || this.options.flushMs === 0 || TERMINAL_RUN_EVENT_TYPES.has(event.eventType)) {
      await this.flush();
      return;
    }
    this.schedule();
  }

  /** Writes everything buffered so far. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // One writer at a time keeps batches in emission order.
    while (this.inflight) await this.inflight;
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, MAX_ROWS_PER_INSERT);
      const write = this.write(batch);
      this.inflight = write.then(() => undefined, () => undefined);
      try {
        await write;
      } catch (error) {
        // Keep the batch for the next attempt; ids make the retry idempotent.
        this.buffer.unshift(...batch);
        this.trim();
        this.schedule();
        throw error;
      } finally {
        this.inflight = null;
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.buffer.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((error) => {
        console.warn(`[run-events] flush failed pending=${this.buffer.length}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, this.options.flushMs);
    this.timer.unref?.();
  }

  private async write(batch: StampedRunEvent[]): Promise<void> {
    try {
      await insertWorkspaceRunEvents({ sql: this.sql, events: batch });
    } catch (error) {
      if (!isIntegrityError(error)) throw error;
      // A row whose run or document was deleted meanwhile must not poison the
      // batch: write rows one by one and drop only the ones that cannot land.
      for (const event of batch) {
        await insertWorkspaceRunEvents({ sql: this.sql, events: [event], notify: false }).catch((rowError) => {
          if (!isIntegrityError(rowError)) throw rowError;
          console.warn(`[run-events] dropped event run=${event.runId} type=${event.eventType}: ${String(rowError)}`);
        });
      }
      await this.hint(batch.map((event) => event.runId));
    }
  }

  private async hint(runIds: string[]): Promise<void> {
    const hints = encodeRunEventHints(runIds);
    if (hints.length === 0) return;
    await this.sql`select pg_notify(${RUN_EVENTS_CHANNEL}, hint) from jsonb_array_elements_text(${this.sql.json(hints)}::jsonb) as hint`;
  }

  private trim(): void {
    let excess = this.buffer.length - this.options.maxBuffered;
    if (excess <= 0) return;
    const kept: StampedRunEvent[] = [];
    for (const event of this.buffer) {
      if (excess > 0 && !TERMINAL_RUN_EVENT_TYPES.has(event.eventType)) {
        excess -= 1;
        continue;
      }
      kept.push(event);
    }
    console.warn(`[run-events] buffer over ${this.options.maxBuffered}; dropped ${this.buffer.length - kept.length} progress events`);
    this.buffer = kept;
  }
}
