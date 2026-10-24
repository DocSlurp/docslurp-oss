/**
 * Makes a postgres.js pool safe across a frozen process.
 *
 * Fly Machines in `auto_stop_machines = "suspend"` are snapshotted: timers and
 * sockets freeze with the VM, and the network (the Fly proxy, a pooler, NAT)
 * forgets the connections while it is suspended. On resume the pool still
 * holds sockets the other side reset. postgres.js's idle_timeout never fired,
 * because the monotonic timers were frozen too, so the first ~25 s of work
 * after a ~33 min suspend failed with `read ECONNRESET` (2026-10-24: a
 * user request, the credit-debit flush, the recovery sweep, the rate-limit
 * plan lookup and the worker-fleet capability check).
 *
 * Two defences, both on the query path so they work even when the first
 * request is what woke the machine (a timer would run too late):
 *
 * 1. Gap detection. Every query entry and exit stamps `lastSeen`; a gap longer
 *    than `gapMs` (default 30 s, above the 20 s idle_timeout) means the process
 *    was frozen or idle long enough that pooled sockets cannot be trusted.
 *    The pool is replaced by a fresh one (the old client drains and ends in the
 *    background, so in-flight transactions finish) before the query is sent.
 *    postgres.js has no safe "drop idle connections": `sql.close()` strands any
 *    connection that already closed. Unfrozen pools have idled their connections
 *    out, so a swap costs nothing there.
 * 2. One retry for reads. If a plain `select`/`with ... select` still fails with
 *    a connection-level error (ECONNRESET, EPIPE, CONNECTION_CLOSED, 57P01),
 *    the pool is recycled and the query runs once more. Writes are never
 *    retried: the server may have applied them before the connection died.
 *
 * Only tagged-template queries are wrapped; `unsafe`, cursors and transactions
 * pass through (`begin` and `reserve` get the gap check only).
 */
export interface ResilientSqlOptions {
  /** How long the replaced client may drain in-flight queries before its sockets are destroyed. */
  drainTimeoutS?: number;
  /** Idle gap that marks the process as frozen (DATABASE_RESUME_GAP_MS). 0 disables detection. */
  gapMs?: number;
  now?: () => number;
  /** Runs once per detected resume, before the pool is recycled (e.g. reconnect LISTEN). */
  onResume?: (gapMs: number) => void | Promise<void>;
  log?: Pick<Console, "warn">;
}

export interface ResilientSql<T> {
  sql: T;
  /** Check for a resume now (also stamps activity); resolves once the pool is safe to use. */
  ensureFresh(): Promise<void>;
  /** Replace the pool: new queries use fresh connections, the old client drains in the background. */
  recycle(): Promise<void>;
}

export const DEFAULT_RESUME_GAP_MS = 30_000;

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "57P01", // admin_shutdown: terminated by pg_terminate_backend or a restart
  "57P02", // crash_shutdown
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

/** The connection died; the statement may or may not have reached the server. CONNECTION_ENDED (pool shut down) is deliberately excluded. */
export function isConnectionLevelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  return (typeof code === "string" && CONNECTION_ERROR_CODES.has(code))
    || (typeof errno === "string" && CONNECTION_ERROR_CODES.has(errno));
}

const WRITE_OR_SIDE_EFFECT = /\b(insert|update|delete|merge|call|copy|nextval|setval|set_config|pg_notify|pg_advisory\w*|for\s+(no\s+key\s+)?(update|share))\b/i;

/**
 * True for statements that are safe to run twice: a plain read with a FROM
 * clause (so not `select some_function()`), no data-modifying CTE and no
 * locking or side-effect functions.
 */
export function isRetryableRead(strings: readonly string[]): boolean {
  const text = strings.join(" ").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").trim();
  if (!/^(select|with)\b/i.test(text)) return false;
  return /\bfrom\b/i.test(text) && !WRITE_OR_SIDE_EFFECT.test(text);
}

function isTemplate(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && "raw" in value;
}

const MODE_METHODS = new Set(["values", "raw", "describe", "cursor", "forEach", "stream", "simple", "cancel", "readable", "writable"]);

export function resilientSql<T extends (...args: any[]) => any>(create: () => T, options: ResilientSqlOptions = {}): ResilientSql<T> {
  let client = create();
  const gapMs = options.gapMs ?? DEFAULT_RESUME_GAP_MS;
  const drainTimeoutS = options.drainTimeoutS ?? 5;
  const now = options.now ?? Date.now;
  const log = options.log ?? console;
  let lastSeen = now();
  let recycling: Promise<void> | null = null;
  const settled = Promise.resolve();

  async function recycle(): Promise<void> {
    const stale = client as unknown as { end(options: { timeout: number }): Promise<void> };
    client = create();
    void stale.end({ timeout: drainTimeoutS }).catch(() => undefined);
  }

  function ensureFresh(): Promise<void> {
    if (recycling) return recycling;
    const at = now();
    const gap = at - lastSeen;
    lastSeen = at;
    if (gapMs <= 0 || gap < gapMs) return settled;
    log.warn(`[db-pool] no database activity for ${Math.round(gap / 1000)}s (process suspended or idle); recycling pooled connections before the next query`);
    recycling = (async () => {
      try { await options.onResume?.(gap); } catch (error) {
        log.warn(`[db-pool] resume hook failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await recycle();
    })().finally(() => { recycling = null; lastSeen = now(); });
    return recycling;
  }

  function wrapQuery(created: any, owner: T, strings: TemplateStringsArray, args: unknown[]): any {
    let result: Promise<unknown> | undefined;
    let reshaped = false;
    const run = () => result ??= (async () => {
      await ensureFresh();
      // The pool may have been replaced since the query was built; rebuild it on the live one.
      const query = owner === client || reshaped ? created : client(strings, ...args);
      try {
        return await query;
      } catch (error) {
        if (reshaped || !isConnectionLevelError(error) || !isRetryableRead(strings)) throw error;
        log.warn(`[db-pool] read failed on a dead connection (${(error as { code?: string }).code ?? "connection error"}); recycling the pool and retrying once`);
        await recycle();
        return await client(strings, ...args);
      }
    })().finally(() => { lastSeen = now(); });
    const proxy: any = new Proxy(created, {
      get(target, key) {
        if (key === "then" || key === "catch" || key === "finally") {
          return (...callbacks: unknown[]) => Reflect.apply((run() as any)[key], run(), callbacks);
        }
        if (key === "execute") return () => { void run().catch(() => undefined); return proxy; };
        const member = Reflect.get(target, key, target);
        if (typeof member !== "function") return member;
        return (...methodArgs: unknown[]) => {
          if (typeof key === "string" && MODE_METHODS.has(key)) reshaped = true;
          const value = Reflect.apply(member, target, methodArgs);
          return value === target ? proxy : value;
        };
      },
    });
    return proxy;
  }

  // A stable function for the Proxy to wrap; every trap delegates to the live client.
  const sql = new Proxy((() => undefined) as unknown as T, {
    apply(_target, thisArg, callArgs) {
      const owner = client;
      const query = Reflect.apply(owner, thisArg, callArgs);
      // Helpers (sql(obj), sql.json) and non-queries pass through untouched.
      if (!isTemplate(callArgs[0]) || !query || typeof query.then !== "function") return query;
      return wrapQuery(query, owner, callArgs[0], callArgs.slice(1));
    },
    get(_target, key) {
      if (key === "begin" || key === "reserve") {
        return (...callArgs: unknown[]) => ensureFresh().then(() => Reflect.apply((client as any)[key], client, callArgs));
      }
      return Reflect.get(client, key, client);
    },
  });

  return { sql, ensureFresh, recycle };
}
