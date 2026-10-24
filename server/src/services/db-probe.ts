/**
 * A database health probe that does not share the request pool.
 *
 * On 2026-10-20 ten concurrent chat agent turns (each fanning out up to six
 * hybrid searches) saturated the API's postgres.js pool. The watchdog's
 * `select 1` queued behind those searches, timed out at 5 s on every probe for
 * a minute and the watchdog exited a healthy app, while Postgres itself had
 * 16 idle app connections and no long-running query. `/ready` failed the same
 * way (503 after 2.5 s).
 *
 * The probe therefore owns one connection (max 1, short connect and idle
 * timeouts) that answers only health questions: "can a fresh connection reach
 * the database right now", the schema head for readiness, and whether this
 * process's pool has queries running in Postgres (pg_stat_activity). The idle
 * timeout is shorter than the watchdog interval, so each probe usually opens a
 * new connection and a silently dead socket cannot make it hang. A probe that
 * times out ends its client so the next one starts clean.
 */
import postgres from "postgres";

import { env } from "../config.js";
import { apiApplicationName, numericType } from "../lib/api-pool.js";
import { processSingleton } from "../lib/process-singleton.js";

export type DbProbeResult = { ok: true; latencyMs: number } | { ok: false; latencyMs: number; detail: string };

type ProbeClient = postgres.Sql<Record<string, never>>;

export interface DbProbe {
  /** `select 1` on the probe connection within `timeoutMs`. */
  ping(timeoutMs: number): Promise<DbProbeResult>;
  /** Run a health query on the probe connection; rejects after `timeoutMs`. */
  query<T>(timeoutMs: number, run: (sql: ProbeClient) => Promise<T>): Promise<T>;
  /** Queries of `applicationName` that Postgres is executing (not waiting on the client). */
  activeBackends(applicationName: string, timeoutMs: number): Promise<number>;
  close(): Promise<void>;
}

/** Longer than the probe's 5 s idle_timeout and the 15 s watchdog interval. */
const STALE_PROBE_MS = 30_000;

export function createDbProbe(databaseUrl: string, options: { applicationName?: string } = {}): DbProbe {
  let client: ProbeClient | null = null;
  const applicationName = `${(options.applicationName ?? apiApplicationName()).slice(0, 57)}:probe`;

  // Probe timers freeze with a suspended machine too: a connection unused for
  // longer than the idle timeout can only be a socket the network has dropped.
  let lastUsed = Date.now();

  const open = (timeoutMs: number): ProbeClient => {
    const at = Date.now();
    if (client && at - lastUsed > STALE_PROBE_MS) discard(client);
    lastUsed = at;
    return client ??= connect(timeoutMs);
  };

  const connect = (timeoutMs: number): ProbeClient => postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    max_lifetime: 300,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    connection: { application_name: applicationName },
    types: { numeric: numericType },
    onnotice: () => {},
  }) as unknown as ProbeClient;

  const discard = (stale: ProbeClient) => {
    if (client === stale) client = null;
    void stale.end({ timeout: 0 }).catch(() => undefined);
  };

  async function query<T>(timeoutMs: number, run: (sql: ProbeClient) => Promise<T>): Promise<T> {
    const current = open(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run(current),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      // A hung or broken probe connection must not delay the next probe.
      discard(current);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    query,
    async ping(timeoutMs) {
      const started = Date.now();
      try {
        await query(timeoutMs, (sql) => sql`select 1`);
        return { ok: true, latencyMs: Date.now() - started };
      } catch (error) {
        return { ok: false, latencyMs: Date.now() - started, detail: error instanceof Error ? error.message : String(error) };
      }
    },
    async activeBackends(name, timeoutMs) {
      const [row] = await query(timeoutMs, (sql) => sql<{ active: number | string }[]>`
        select count(*)::int as active
        from pg_stat_activity
        where application_name = ${name}
          and state = 'active'
          and coalesce(wait_event_type, '') <> 'Client'
      `);
      return Number(row?.active ?? 0);
    },
    async close() {
      const current = client;
      client = null;
      await current?.end({ timeout: 1 });
    },
  };
}

let shared: DbProbe | null = null;

/** The process's probe connection to DATABASE_URL, shared by the watchdog and `/ready`. */
export function sharedDbProbe(): DbProbe {
  return shared ??= processSingleton(`api-db-probe:${env.databaseUrl}`, () => createDbProbe(env.databaseUrl));
}
