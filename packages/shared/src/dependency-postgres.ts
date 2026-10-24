import { startDependencySpan, withDependencySpan } from "./telemetry.js";

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

/** Instrument postgres.js's lazy queries without exposing SQL text or parameters. */
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
    const attributes = { ...base, "db.operation.name": operation, "docslurp.dependency.operation": operation };
    const consume = () => completion ??= (() => {
      const span = startDependencySpan(`postgres.${operation}`, attributes);
      const settled = hooks.onQueryStart?.();
      hooks.onStatement?.(text);
      return span.run(() => Promise.resolve(value)).then(result => {
        settled?.();
        if (typeof result?.count === "number") span.set({ "db.response.returned_rows": result.count });
        span.end(); return result;
      }, error => {
        settled?.();
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
