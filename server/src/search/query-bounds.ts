import { AsyncLocalStorage } from "node:async_hooks";

import { sql, type SqlClient } from "../db.js";

/**
 * Time and cancellation bounds for search SQL.
 *
 * On 2026-10-20 lexical (FTS) branches on a 285K-chunk workspace ran 1-4
 * minutes each on a 2 GB database, with no statement_timeout, and kept running
 * after the HTTP request was gone. Each one held a pool connection, and
 * postgres.js pipelines new queries onto busy connections when none is free
 * (max_pipeline 100), so fast queries such as health probes queued behind a
 * multi-minute statement. Lowering max_pipeline is not an option: postgres.js
 * 3.4.7 then skips `onexecute` for a pipelined BEGIN and sql.begin fails with
 * UNSAFE_TRANSACTION. Bounding statement time bounds that wait instead.
 *
 * `boundedSearchQuery` runs one search statement in its own short transaction
 * with `SET LOCAL statement_timeout` (SEARCH_STATEMENT_TIMEOUT_MS, default
 * 8000, 0 disables), so Postgres itself stops a runaway statement. When the
 * search's abort signal fires (the client disconnected, or the chat turn was
 * aborted) the statement is cancelled with postgres.js `.cancel()`. Inside the
 * transaction the connection belongs to this statement alone, so the cancel
 * request cannot hit another request's query.
 */
const store = new AsyncLocalStorage<{ signal?: AbortSignal }>();

export function searchStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.SEARCH_STATEMENT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!value?.trim() || !Number.isFinite(parsed) || parsed < 0) return 8_000;
  return parsed === 0 ? 0 : Math.min(600_000, Math.max(100, Math.trunc(parsed)));
}

/** Run a search with `signal` as the abort signal for its SQL (nested searches inherit it). */
export function withSearchSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return store.run({ signal }, fn);
}

export function currentSearchSignal(): AbortSignal | undefined {
  return store.getStore()?.signal;
}

export class SearchAbortedError extends Error {
  constructor() {
    super("Search aborted");
    this.name = "AbortError";
  }
}

/** A search statement that hit SEARCH_STATEMENT_TIMEOUT_MS. */
export class SearchStatementTimeoutError extends Error {
  readonly code = "search_statement_timeout";

  constructor(timeoutMs: number) {
    super(`Search statement exceeded ${timeoutMs}ms`);
    this.name = "SearchStatementTimeoutError";
  }
}

export function isSearchStatementTimeout(error: unknown): error is SearchStatementTimeoutError {
  return error instanceof SearchStatementTimeoutError;
}

/** The search was aborted (client gone): stop, do not degrade or retry. */
export function isSearchAborted(error: unknown): boolean {
  return error instanceof SearchAbortedError || (error instanceof Error && error.name === "AbortError");
}

/** True for either bound: callers must not retry the same statement or run fallbacks. */
export function isSearchBoundError(error: unknown): boolean {
  return isSearchStatementTimeout(error) || isSearchAborted(error);
}

type Cancellable<T> = PromiseLike<T> & { cancel?: () => unknown };

/** Longest wait for a cancel request to reach Postgres before the connection is released anyway. */
const CANCEL_DELIVERY_WAIT_MS = 2_000;

async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); })]);
  clearTimeout(timer);
}

export async function boundedSearchQuery<T>(
  build: (client: SqlClient) => Cancellable<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? searchStatementTimeoutMs();
  const signal = options.signal ?? currentSearchSignal();
  if (signal?.aborted) throw new SearchAbortedError();
  if (timeoutMs <= 0 && !signal) return await build(sql);
  try {
    return await sql.begin(async (tx) => {
      const client = tx as unknown as SqlClient;
      if (timeoutMs > 0) await client.unsafe(`set local statement_timeout = ${Math.trunc(timeoutMs)}`);
      if (signal?.aborted) throw new SearchAbortedError();
      const query = build(client);
      // postgres.js sends the cancel on a separate connection. If the statement
      // finishes before Postgres acts on it, the cancel could land on whatever
      // this connection runs next, so the transaction (and the connection's
      // return to the pool) waits until the cancel request has been delivered.
      let cancelling: Promise<unknown> | undefined;
      const cancel = () => { cancelling = Promise.resolve(query.cancel?.()).catch(() => undefined); };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        return await query;
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (cancelling) await settleWithin(cancelling, CANCEL_DELIVERY_WAIT_MS);
      }
    }) as T;
  } catch (error) {
    if (signal?.aborted) throw new SearchAbortedError();
    // 57014 query_canceled: the statement timeout (or a cancel we did not send).
    if ((error as { code?: unknown })?.code === "57014") throw new SearchStatementTimeoutError(timeoutMs);
    throw error;
  }
}
