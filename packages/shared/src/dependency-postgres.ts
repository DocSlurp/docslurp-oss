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

/** Longest statement kept on a span. */
const QUERY_TEXT_MAX = 4000;
/** Queries at least this slow (or failing) also record the code that issued them. */
const SLOW_QUERY_MS = 50;
/** Frames captured per query: enough to get past the instrumentation to the caller. */
const CALL_SITE_FRAMES = 8;

/**
 * Captures the call stack cheaply where a query is written; V8 formats it only
 * if read, which happens for slow or failing queries (see querySite).
 */
function captureCallSite(): { stack?: string } | null {
  if (!isTracingActive()) return null;
  const previous = Error.stackTraceLimit;
  Error.stackTraceLimit = CALL_SITE_FRAMES;
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder);
  Error.stackTraceLimit = previous;
  return holder;
}

/** The statement as Postgres received it: placeholders ($1, $2…) only, never parameter values. */
function queryText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, QUERY_TEXT_MAX) : undefined;
}

/** "SELECT search_sessions", "UPDATE document_exports": groups spans by statement without its text. */
export function querySummary(operation: string, text: string | undefined): string {
  const table = text?.match(/\b(?:from|into|update|join)\s+("?[a-z_][\w.]*"?)/i)?.[1]?.replace(/"/g, "");
  return table ? `${operation} ${table}` : operation;
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
  function query(value: any, operation: string, text = ""): any {
    if (!value || typeof value.then !== "function") return value;
    if (queries.has(value)) return queries.get(value);
    let completion: Promise<any> | undefined;
    // The call site is captured where the query is written, not where it is awaited.
    const callSite = captureCallSite();
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
            const span = startDependencySpan(`postgres.${operation}`, attributes);
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
    const proxy = new Proxy(target, {
      apply(fn, thisArg, args) { return query(Reflect.apply(fn, thisArg, args), operation(args[0]), hooks.onStatement ? fingerprint(args[0]) : ""); },
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
        if (key === "unsafe") return (...args: any[]) => query(Reflect.apply(member, fn, args), operation(args[0]), hooks.onStatement ? fingerprint(args[0]) : "");
        return member.bind(fn);
      },
    });
    clients.set(target, proxy); return proxy;
  }
  return client(sql);
}
