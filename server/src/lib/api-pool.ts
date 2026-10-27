import { hostname } from "node:os";

import postgres from "postgres";
import { instrumentPostgres } from "@docslurp/shared/observability";

import { PoolActivity } from "./pool-activity.js";
import { DEFAULT_RESUME_GAP_MS, DEFAULT_RESUME_LOG_GAP_MS, resilientSql } from "./resilient-sql.js";

export const DEFAULT_DATABASE_POOL_MAX = 20;

function readInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value?.trim() ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

/**
 * Query connections in the API's postgres.js pool (DATABASE_POOL_MAX, default
 * 20). The LISTEN connection and the watchdog/readiness probe connection come
 * on top. Workers connect through the PgBouncer pooler and size their own
 * pools (WORKER_DB_POOL_MAX).
 */
export function resolveDatabasePoolMax(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env.DATABASE_POOL_MAX, DEFAULT_DATABASE_POOL_MAX, 1, 200);
}

/**
 * `application_name` of this process's pool connections, unique per machine
 * and process so the watchdog can ask Postgres (pg_stat_activity) whether this
 * pool's queries are actually running. Postgres truncates at 63 bytes.
 */
export function apiApplicationName(env: NodeJS.ProcessEnv = process.env): string {
  const machine = env.FLY_MACHINE_ID?.trim() || hostname();
  return `docslurp-api:${machine}:${process.pid}`.slice(0, 63);
}

export const numericType = {
  to: 1700,
  from: [1700],
  serialize: (value: unknown) => String(value),
  parse: (value: string): unknown => Number(value),
};

export interface ApiListener {
  unlisten(): Promise<void>;
}

export interface ApiPool {
  sql: ReturnType<typeof createPostgres>;
  activity: PoolActivity;
  applicationName: string;
  max: number;
  /** Replace the request pool; the old one drains in the background. */
  recycle(): Promise<void>;
  /**
   * LISTEN on a channel over a dedicated connection that is rebuilt after a
   * suspend/resume. `onListen` runs after every (re)subscription, so callers
   * can catch up on notifications missed while the connection was dead.
   */
  listen(channel: string, handler: (payload: string) => void, onListen?: () => void): Promise<ApiListener>;
  /** Check for a resume now every few seconds, even when no query is running. */
  watchForResume(intervalMs?: number): void;
  /** `select 1` through the request pool (after the resume check and one retry); rejects on timeout. */
  ping(timeoutMs: number): Promise<number>;
  /** Stop timers and end both the request pool and the LISTEN connection. */
  end(options?: { timeout?: number }): Promise<void>;
}

export function resolveResumeGapMs(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env.DATABASE_RESUME_GAP_MS, DEFAULT_RESUME_GAP_MS, 0, 3_600_000);
}

/** Shortest idle gap whose pool recycle is logged (DATABASE_RESUME_LOG_GAP_MS); shorter, routine ones are silent. */
export function resolveResumeLogGapMs(env: NodeJS.ProcessEnv = process.env): number {
  return readInt(env.DATABASE_RESUME_LOG_GAP_MS, DEFAULT_RESUME_LOG_GAP_MS, 0, 86_400_000);
}

function postgresOptions(options: { max: number; applicationName: string }) {
  return {
    max: options.max,
    // Pooler-held named statements can retain result types across schema deployments.
    prepare: false,
    types: { numeric: numericType },
    // Pooled sockets must not outlive the idle reaping of the Fly proxy, a pooler or NAT.
    // These timers freeze with a suspended machine, so lib/resilient-sql.ts also recycles on resume.
    idle_timeout: 20,
    max_lifetime: readInt(process.env.DATABASE_MAX_LIFETIME_SECONDS, 900, 30, 7200),
    keep_alive: 15,
    connect_timeout: 10,
    connection: { application_name: options.applicationName },
  };
}

function createPostgres(databaseUrl: string, options: { max: number; applicationName: string }) {
  return postgres<Record<string, postgres.PostgresType>>(databaseUrl, postgresOptions(options));
}

/** The API's request pool with its activity tracker (see db.ts). */
export function createApiPool(
  databaseUrl: string,
  options: { max?: number; applicationName?: string; resumeGapMs?: number; now?: () => number } = {},
): ApiPool {
  const activity = new PoolActivity();
  const max = options.max ?? resolveDatabasePoolMax();
  const applicationName = options.applicationName ?? apiApplicationName();
  const resilient = resilientSql(
    () => instrumentPostgres(createPostgres(databaseUrl, { max, applicationName }), databaseUrl, { onQueryStart: activity.start }),
    {
      gapMs: options.resumeGapMs ?? resolveResumeGapMs(),
      logGapMs: resolveResumeLogGapMs(),
      now: options.now,
      onResume: () => reconnectListeners(),
    },
  );
  const sql = resilient.sql;

  // LISTEN: postgres.js keeps one internal listen connection per client and
  // cannot rebuild it on demand, so we own a client and replace it on resume.
  interface ListenEntry {
    channel: string;
    handler: (payload: string) => void;
    onListen?: () => void;
    subscription?: Promise<{ unlisten(): Promise<void> }>;
  }
  const entries = new Set<ListenEntry>();
  let listenClient: ReturnType<typeof createPostgres> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function subscribe(entry: ListenEntry): Promise<{ unlisten(): Promise<void> }> {
    listenClient ??= createPostgres(databaseUrl, { max: 1, applicationName: `${applicationName.slice(0, 55)}:listen` });
    return entry.subscription = listenClient.listen(entry.channel, entry.handler, entry.onListen);
  }

  async function reconnectListeners(): Promise<void> {
    if (entries.size === 0) return;
    const stale = listenClient;
    listenClient = null;
    void stale?.end({ timeout: 0 }).catch(() => undefined);
    const failed = (await Promise.all([...entries].map((entry) => subscribe(entry).then(() => false, (error: unknown) => {
      console.warn(`[db-pool] re-LISTEN ${entry.channel} failed: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    })))).some(Boolean);
    if (failed && !retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; void reconnectListeners(); }, 5_000);
      retryTimer.unref?.();
    }
  }

  let watcher: ReturnType<typeof setInterval> | null = null;
  const watchForResume = (intervalMs = 5_000) => {
    if (watcher) return;
    // Ticks must stamp activity more often than the gap that counts as a resume.
    const gapMs = options.resumeGapMs ?? resolveResumeGapMs();
    watcher = setInterval(() => { void resilient.ensureFresh(); }, gapMs > 0 ? Math.max(25, Math.min(intervalMs, Math.floor(gapMs / 3))) : intervalMs);
    watcher.unref?.();
  };

  return {
    sql,
    activity,
    applicationName,
    max,
    recycle: resilient.recycle,
    watchForResume,
    async listen(channel, handler, onListen) {
      watchForResume();
      const entry: ListenEntry = { channel, handler, onListen };
      entries.add(entry);
      try {
        await subscribe(entry);
      } catch (error) {
        entries.delete(entry);
        throw error;
      }
      return {
        async unlisten() {
          entries.delete(entry);
          await (await entry.subscription)?.unlisten();
        },
      };
    },
    async ping(timeoutMs) {
      const started = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sql`select 1`,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`pool query timed out after ${timeoutMs}ms`)), timeoutMs); timer.unref?.(); }),
        ]);
        return Date.now() - started;
      } finally {
        clearTimeout(timer);
      }
    },
    async end(endOptions = {}) {
      if (watcher) clearInterval(watcher);
      if (retryTimer) clearTimeout(retryTimer);
      watcher = retryTimer = null;
      entries.clear();
      const listening = listenClient;
      listenClient = null;
      await Promise.all([sql.end(endOptions), listening?.end(endOptions)]);
    },
  };
}
