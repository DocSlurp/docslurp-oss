import { trace } from "@opentelemetry/api";

import { isTracingActive, startDependencySpan, withDependencySpan } from "./telemetry.js";

export interface PostgresQueryHooks {
  /**
   * Called when a query is consumed (awaited or executed), including queries
   * inside transactions and reserved connections; call the returned function
   * once it settles. Lets the owner of a pool observe in-flight demand and
   * completed work (server/src/lib/pool-activity.ts) without a second wrapper.
   */
  onQueryStart?: () => () => void;
  /**
   * Called once per statement sent to Postgres (and for each BEGIN/COMMIT a
   * transaction adds) in the caller's async context, with a short fingerprint
   * of the SQL text. For statement-count diagnostics only.
   */
  onStatement?: (fingerprint: string) => void;
}

/** Longest statement kept on a span; long bulk statements are cut before any processing. */
const QUERY_TEXT_MAX = 2000;
/** Queries at least this slow (or failing) also record the code that issued them. */
const SLOW_QUERY_MS = 50;
/** Frames captured per query: enough to get past the instrumentation to the caller. */
const CALL_SITE_FRAMES = 8;

/**
 * Captures the call stack cheaply where a query is written; V8 formats it only
 * if read, which happens for slow or failing queries (see querySite).
 */
function captureCallSite(entry: Function): { stack?: string } | null {
  // Queries in an unsampled trace skip the stack capture; root queries are sampled on their own.
  const parent = trace.getActiveSpan();
  if (!isTracingActive() || (parent && !parent.isRecording())) return null;
  const previous = Error.stackTraceLimit;
  const holder: { stack?: string } = {};
  try {
    Error.stackTraceLimit = CALL_SITE_FRAMES;
    // Frames from `entry` (the instrumented sql function) up are dropped by function
    // identity, so bundled builds (chunks/db_<hash>.mjs) still start at the caller.
    Error.captureStackTrace(holder, entry);
  } finally {
    Error.stackTraceLimit = previous;
  }
  return holder;
}

/** The statement as Postgres received it: placeholders ($1, $2…) only, never parameter values. */
function queryText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, QUERY_TEXT_MAX * 2).replace(/\s+/g, " ").trim().slice(0, QUERY_TEXT_MAX);
  return text || undefined;
}

/**
 * "SELECT search_sessions", "UPDATE document_exports": groups spans by statement
 * without its text. Function calls (`from now()`, `from unnest($1)`) are not tables.
 */
export function querySummary(operation: string, text: string | undefined): string {
  // The name must end at a non-word character (no backtracking into a shorter name),
  // and a "(" right after it means a function call, not a table.
  const match = text?.match(/\b(?:from|into|update|join)\s+((?:"[^"]+"|[a-z_][\w]*)(?:\.(?:"[^"]+"|[a-z_][\w]*))?)(?![\w"(])/i);
  const table = match?.[1]?.replace(/"/g, "").replace(/^public\./, "");
  return table ? `${operation} ${table}` : operation;
}

/** A tagged template's statement with $n placeholders (fragments not expanded), for queries that never report one (cursors). */
function templateText(input: unknown): string | undefined {
  if (!Array.isArray(input)) return typeof input === "string" ? input : undefined;
  return input.reduce((text: string, part: string, index: number) => (index === 0 ? part : `${text}$${index}${part}`), "");
}

/** The first application frame that issued a query (function, file, line), for finding slow or failing code. */
export function querySite(stack: string | undefined): Record<string, string | number> {
  for (const line of (stack ?? "").split("\n").slice(1)) {
    if (/dependency-postgres\.(?:ts|js|mjs)|node_modules|node:internal|pool-activity|\/db\.(?:ts|js|mjs)|\(native\)/.test(line)) continue;
    const match = line.match(/at (?:async )?(?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):\d+\)?$/);
    if (!match) continue;
    const site: Record<string, string | number> = {
      // Relative to the repository or container root (/app in the images).
      "code.file.path": match[2]!.replace(`${process.cwd()}/`, "").replace(/^\/app\//, ""),
      "code.line.number": Number(match[3]),
    };
    if (match[1] && !/^(?:Proxy|Object|Function)\.|^<anonymous>$/.test(match[1])) site["code.function.name"] = match[1].replace(/^async /, "");
    return site;
  }
  return {};
}

/**
 * Instrument postgres.js's lazy queries. Spans carry the parameterized
 * statement (`db.query.text`, placeholders only) and a `db.query.summary`;
 * slow (≥50 ms) or failing queries also carry the calling function, file and
 * line, so they can be traced to their code. Parameter values are never recorded.
 */
export function instrumentPostgres<T extends (...args: any[]) => any>(sql: T, databaseUrl: string, hooks: PostgresQueryHooks = {}): T {
  const endpoint = new URL(databaseUrl);
  const base = { "db.system.name": "postgresql", "server.address": endpoint.hostname,
    "server.port": Number(endpoint.port || 5432), "docslurp.dependency.type": "postgres", "docslurp.dependency.provider": "postgresql" };
  const clients = new WeakMap<object, T>();
  const queries = new WeakMap<object, object>();
  function fingerprint(input: unknown): string {
    const text = Array.isArray(input) ? input.join("?") : typeof input === "string" ? input : "";
    return text.replace(/\s+/g, " ").trim().slice(0, 100);
  }
  function query(value: any, operation: string, text = "", callSite: { stack?: string } | null = null, template?: unknown): any {
    if (!value || typeof value.then !== "function") return value;
    if (queries.has(value)) return queries.get(value);
    let completion: Promise<any> | undefined;
    const attributes = { ...base, "db.operation.name": operation, "docslurp.dependency.operation": operation };
    const describe = (statement: string | undefined) => {
      const text = queryText(statement);
      return text ? { "db.query.text": text, "db.query.summary": querySummary(operation, text) } : { "db.query.summary": operation };
    };
    const consume = () => completion ??= (() => {
      const span = startDependencySpan(`postgres.${operation}`, attributes);
      const settled = hooks.onQueryStart?.();
      hooks.onStatement?.(text);
      const started = performance.now();
      return span.run(() => Promise.resolve(value)).then(result => {
        settled?.();
        span.set({ ...describe(result?.statement?.string), ...(typeof result?.count === "number" ? { "db.response.returned_rows": result.count } : {}),
          ...(callSite && performance.now() - started >= SLOW_QUERY_MS ? querySite(callSite.stack) : {}) });
        span.end(); return result;
      }, error => {
        settled?.();
        span.set({ ...describe(error?.query), ...(callSite ? querySite(callSite.stack) : {}) });
        if (typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)) span.set({ "db.response.status_code": error.code });
        span.end(error); throw error;
      });
    })();
    const proxy = new Proxy(value, { get(target, key) {
      if (key === "then" || key === "catch" || key === "finally") return (...args: any[]) => Reflect.apply(consume()[key], consume(), args);
      if (key === "execute") return () => { void consume().catch(() => {}); return proxy; };
      const member = Reflect.get(target, key, target);
      if (typeof member !== "function") return member;
      return (...args: any[]) => {
        if (key === "cursor" && !args.some(arg => typeof arg === "function")) {
          const iterable = Reflect.apply(member, target, args) as AsyncIterable<unknown>;
          return { async *[Symbol.asyncIterator]() {
            // Cursors never report a final statement, so they carry the template's.
            const span = startDependencySpan(`postgres.${operation}`, { ...attributes, ...describe(templateText(template)), ...(callSite ? querySite(callSite.stack) : {}) });
            const iterator = iterable[Symbol.asyncIterator]();
            try {
              while (true) { const next = await span.run(() => iterator.next()); if (next.done) break; yield next.value; }
            } catch (error) { span.end(error); throw error; }
            finally { try { await span.run(() => iterator.return?.()); } finally { span.end(); } }
          } };
        }
        const result = Reflect.apply(member, target, args);
        return result === target ? proxy : result;
      };
    } });
    queries.set(value, proxy);
    return proxy;
  }
  function operation(input: unknown): string {
    const text = Array.isArray(input) ? input[0] : input;
    const verb = typeof text === "string" ? text.trimStart().match(/^[a-z]+/i)?.[0]?.toUpperCase() : undefined;
    return verb && ["SELECT", "INSERT", "UPDATE", "DELETE", "WITH", "BEGIN", "COMMIT", "ROLLBACK", "COPY", "SET", "SHOW", "EXPLAIN"].includes(verb) ? verb : "QUERY";
  }
  function client(target: T): T {
    const cached = clients.get(target); if (cached) return cached;
    // The call site is captured where the query is written, not where it is awaited.
    const applyQuery = function applyQuery(fn: T, thisArg: unknown, args: any[]) {
      return query(Reflect.apply(fn, thisArg, args), operation(args[0]), hooks.onStatement ? fingerprint(args[0]) : "", captureCallSite(applyQuery), args[0]);
    };
    const proxy = new Proxy(target, {
      apply: applyQuery,
      get(fn, key) {
        const member = Reflect.get(fn, key, fn);
        if (typeof member !== "function") return member;
        if (key === "begin" || key === "savepoint") return (...args: any[]) => {
          const callback = args.at(-1);
          if (typeof callback !== "function") return Reflect.apply(member, fn, args);
          const wrapped = [...args.slice(0, -1), hooks.onStatement
            ? async (tx: T) => { hooks.onStatement!("begin"); const result = await callback(client(tx)); hooks.onStatement!("commit"); return result; }
            : (tx: T) => callback(client(tx))];
          return withDependencySpan(`postgres.${String(key)}`, { ...base, "db.operation.name": "TRANSACTION", "docslurp.dependency.operation": "TRANSACTION" }, () => Reflect.apply(member, fn, wrapped));
        };
        if (key === "reserve") return async (...args: any[]) => client(await Reflect.apply(member, fn, args));
        if (key === "unsafe") {
          const unsafe = (...args: any[]) => query(Reflect.apply(member, fn, args), operation(args[0]), hooks.onStatement ? fingerprint(args[0]) : "", captureCallSite(unsafe), args[0]);
          return unsafe;
        }
        return member.bind(fn);
      },
    });
    clients.set(target, proxy); return proxy;
  }
  return client(sql);
}
