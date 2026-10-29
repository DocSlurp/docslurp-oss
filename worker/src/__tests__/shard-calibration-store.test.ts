import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** Shard calibration reads fleet-wide timing aggregates: newest first, bounded, numeric columns only. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  const row = (id: string, user: string, metric: string, key: string, ms: number, pages: number, age: string, rss?: number) => sql`
    insert into performance_log (id, user_id, scope, stage_name, metric, value, unit, tags, metadata, created_at)
    values (${id}, ${user}, 'document', 'extract-markdown', ${metric}, ${ms}, 'ms', ${sql.array(["shard"])},
      ${sql.json({ profileKey: key, pages, executor: "doppler-vm", ...(rss === undefined ? {} : { maxRssMiB: rss }) })},
      now() - ${age}::interval)`;
  await row("p1", "u1", "shard_timing_ms", "extract-markdown:doppler-vm", 2_300, 32, "1 hour", 210);
  await row("p2", "u2", "shard_timing_ms", "extract-markdown:doppler-vm", 3_100, 96, "2 hours");
  await row("p3", "u1", "shard_timing_ms", "extract-markdown:doppler-vm", 9_999, 64, "30 days");
  await row("p4", "u1", "shard_timing_ms", "embed:fly-shared-slot", 5_000, 64, "1 hour");
  await row("p5", "u1", "stage-duration", "extract-markdown:doppler-vm", 7_000, 64, "1 hour");
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("Store.loadShardObservations", () => {
  it("returns recent timings for one profile, newest first, across tenants", async () => {
    expect(await store.loadShardObservations("extract-markdown:doppler-vm")).toEqual([
      { pages: 32, ms: 2_300, maxRssMiB: 210 },
      { pages: 96, ms: 3_100 },
    ]);
  });

  it("honours the limit", async () => {
    expect(await store.loadShardObservations("extract-markdown:doppler-vm", 1)).toEqual([{ pages: 32, ms: 2_300, maxRssMiB: 210 }]);
  });

  it("exposes only numeric measurements", async () => {
    for (const row of await store.loadShardObservations("extract-markdown:doppler-vm")) {
      expect(Object.keys(row).every((k) => ["pages", "ms", "maxRssMiB"].includes(k))).toBe(true);
      expect(Object.values(row).every((v) => typeof v === "number")).toBe(true);
    }
  });

  it("has a partial index for the lookup", async () => {
    const [index] = await sql<Array<{ indexdef: string }>>`
      select indexdef from pg_indexes where indexname = 'performance_log_shard_timing_idx'`;
    expect(index?.indexdef).toMatch(/shard_timing_ms/);
  });
});
