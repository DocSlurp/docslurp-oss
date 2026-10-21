import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fake postgres.js client: `begin` hands the callback a transaction client
 * whose statements are recorded; `pending` controls how the search statement
 * settles and records `cancel()` calls.
 */
const statements: string[] = [];
let settle: (client: { cancel: () => void }) => Promise<unknown>;
let cancels = 0;
let cancelDelivered: () => Promise<unknown> = async () => undefined;

function fakeQuery(text: string) {
  statements.push(text);
  let promise: Promise<unknown> | null = null;
  const query = {
    cancel: () => { cancels++; return cancelDelivered(); },
    then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => (promise ??= settle(query)).then(resolve, reject),
  };
  return query;
}

const tx = Object.assign((strings: TemplateStringsArray) => fakeQuery(strings.join("?")), {
  unsafe: async (text: string) => { statements.push(text); return []; },
});
const sql = Object.assign((strings: TemplateStringsArray) => fakeQuery(strings.join("?")), {
  begin: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
});
vi.mock("../db.js", () => ({ sql }));

const bounds = await import("../search/query-bounds.js");

beforeEach(() => {
  statements.length = 0;
  cancels = 0;
  settle = async () => [{ id: "row" }];
  cancelDelivered = async () => undefined;
});

describe("bounded search queries", () => {
  it("runs the statement in a transaction with a local statement_timeout", async () => {
    const rows = await bounds.boundedSearchQuery((client) => client`select 1`, { timeoutMs: 8_000 });
    expect(rows).toEqual([{ id: "row" }]);
    expect(statements).toEqual(["set local statement_timeout = 8000", "select 1"]);
  });

  it("turns a Postgres statement timeout into SearchStatementTimeoutError", async () => {
    settle = async () => { throw Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }); };
    const error = await bounds.boundedSearchQuery((client) => client`select slow`, { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(bounds.isSearchStatementTimeout(error)).toBe(true);
    expect(bounds.isSearchBoundError(error)).toBe(true);
  });

  it("cancels the running statement when the search aborts", async () => {
    const controller = new AbortController();
    settle = () => new Promise((_, reject) => {
      setTimeout(() => reject(Object.assign(new Error("canceling statement due to user request"), { code: "57014" })), 20);
    });
    const pending = bounds.withSearchSignal(controller.signal, () =>
      bounds.boundedSearchQuery((client) => client`select slow`, { timeoutMs: 8_000 }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(cancels).toBe(1);
    expect(bounds.isSearchAborted(error)).toBe(true);
    expect(bounds.isSearchStatementTimeout(error)).toBe(false);
  });

  it("holds the connection until a cancel that raced the statement's completion is delivered", async () => {
    const controller = new AbortController();
    const order: string[] = [];
    // The statement completes on its own right after the abort; the cancel
    // request reaches Postgres later and must not hit the next statement.
    settle = () => new Promise((resolve) => setTimeout(() => { order.push("statement done"); resolve([]); }, 5));
    cancelDelivered = () => new Promise((resolve) => setTimeout(() => { order.push("cancel delivered"); resolve(undefined); }, 30));
    const pending = bounds.withSearchSignal(controller.signal, () =>
      bounds.boundedSearchQuery((client) => client`select fast`, { timeoutMs: 8_000 })).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    const rows = await pending;
    order.push("released");
    expect(order).toEqual(["statement done", "cancel delivered", "released"]);
    expect(rows).toEqual([]);
  });

  it("does not touch the database once the search is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(bounds.boundedSearchQuery((client) => client`select 1`, { signal: controller.signal })).rejects.toBeInstanceOf(bounds.SearchAbortedError);
    expect(statements).toEqual([]);
  });

  it("runs directly on the pool when neither bound applies", async () => {
    await bounds.boundedSearchQuery((client) => client`select 1`, { timeoutMs: 0 });
    expect(statements).toEqual(["select 1"]);
  });

  it("reads SEARCH_STATEMENT_TIMEOUT_MS", () => {
    expect(bounds.searchStatementTimeoutMs({})).toBe(8_000);
    expect(bounds.searchStatementTimeoutMs({ SEARCH_STATEMENT_TIMEOUT_MS: "0" })).toBe(0);
    expect(bounds.searchStatementTimeoutMs({ SEARCH_STATEMENT_TIMEOUT_MS: "10000" })).toBe(10_000);
    expect(bounds.searchStatementTimeoutMs({ SEARCH_STATEMENT_TIMEOUT_MS: "nope" })).toBe(8_000);
  });
});
