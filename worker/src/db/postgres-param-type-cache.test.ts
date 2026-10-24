import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startPgWireProxy } from "../test/pg-wire-proxy.mjs";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Guards patches/postgres@3.4.9.patch. Unpatched, a statement with parameters on an unnamed-statement
 * connection (prepare: false, required behind the PgBouncer transaction pool) costs two serial round
 * trips every time (Parse/Describe/Flush, then Bind/Execute/Sync). Patched, only the first use of a
 * statement text does. A postgres upgrade that drops the patch fails here instead of silently
 * doubling database latency.
 */
let proxy: Awaited<ReturnType<typeof startPgWireProxy>>;
let sql: postgres.Sql<Record<string, unknown>>;

let db: PGlite;
let server: PGLiteSocketServer;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  proxy = await startPgWireProxy({ targetPort: served.port, delayMs: 1 });
  sql = postgres(`postgres://postgres@127.0.0.1:${proxy.port}/postgres`, { max: 1, prepare: false });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await proxy?.close();
  await server?.stop();
  await db?.close();
});

describe("postgres.js parameter-type cache", () => {
  it("sends a repeated parameterized statement in one round trip", async () => {
    const roundTrips = async (run: () => Promise<unknown>) => {
      proxy.reset();
      await run();
      return proxy.stats().flights;
    };
    await sql`select 1`;
    const first = await roundTrips(() => sql`select ${"a"}::text as x, ${1}::int as y`);
    const second = await roundTrips(() => sql`select ${"b"}::text as x, ${2}::int as y`);
    const unparameterized = await roundTrips(() => sql`select 1 as x`);
    expect(first).toBe(2);
    expect(second).toBe(1);
    expect(unparameterized).toBe(1);
    // Types learned from the server still drive serialization: a text[] parameter stays an array.
    const [row] = await sql<{ n: number }[]>`select cardinality(${["a", "b", "c"]}::text[]) as n`;
    const [again] = await sql<{ n: number }[]>`select cardinality(${["x", "y"]}::text[]) as n`;
    expect([row?.n, again?.n]).toEqual([3, 2]);
  }, 60_000);
});
