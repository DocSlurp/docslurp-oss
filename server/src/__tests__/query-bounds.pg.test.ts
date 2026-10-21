import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Statement timeout and abort against a real Postgres (PGlite has no
 * statement_timeout and runs one statement at a time). Opt-in:
 * SEARCH_BOUNDS_PG_URL=postgres://... pnpm vitest run src/__tests__/query-bounds.pg.test.ts
 */
const url = process.env.SEARCH_BOUNDS_PG_URL;
let sql: postgres.Sql<Record<string, unknown>>;
let bounds: typeof import("../search/query-bounds.js");

describe.skipIf(!url)("search query bounds on Postgres", () => {
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: "docslurp-bounds-test" } }) as unknown as postgres.Sql<Record<string, unknown>>;
    vi.doMock("../db.js", () => ({ sql }));
    bounds = await import("../search/query-bounds.js");
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
  });

  const sleeping = async () => (await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where application_name = 'docslurp-bounds-test' and query like '%pg_sleep(5)%' and state = 'active' and pid <> pg_backend_pid()
  `)[0]!.n;

  it("stops a runaway statement at the statement timeout", async () => {
    const started = Date.now();
    const error = await bounds.boundedSearchQuery((client) => client`select pg_sleep(5)`, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(bounds.isSearchStatementTimeout(error)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await sleeping()).toBe(0);
  });

  it("cancels the statement in Postgres when the search aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = bounds.withSearchSignal(controller.signal, () =>
      bounds.boundedSearchQuery((client) => client`select pg_sleep(5)`, { timeoutMs: 8_000 })).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await sleeping()).toBe(1);
    controller.abort();
    expect(bounds.isSearchAborted(await pending)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await sleeping()).toBe(0);
  });
});
