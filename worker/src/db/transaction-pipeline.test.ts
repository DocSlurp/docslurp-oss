import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";
import { pipelineTransaction } from "./transaction-pipeline.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
const statements: string[] = [];

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec("create table pt_items (id int primary key, note text not null)");
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, {
    max: 1, prepare: false, debug: (_connection: number, query: string) => { statements.push(query.trim().toLowerCase().slice(0, 20)); },
  });
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

describe("pipelineTransaction", () => {
  it("commits statements that see each other's writes and returns their results", async () => {
    const [, , read] = await pipelineTransaction(sql, (tx) => [
      tx`insert into pt_items (id, note) values (1, 'a')`,
      tx`update pt_items set note = 'b' where id = 1`,
      tx<{ note: string }[]>`select note from pt_items where id = 1`,
    ]);
    expect(read[0]?.note).toBe("b");
    expect((await sql`select note from pt_items where id = 1`)[0]?.note).toBe("b");
  });

  it("rolls everything back and throws the root-cause error", async () => {
    await expect(pipelineTransaction(sql, (tx) => [
      tx`insert into pt_items (id, note) values (2, 'x')`,
      tx`insert into pt_items (id, note) values (1, 'duplicate')`,
      tx`insert into pt_items (id, note) values (3, 'y')`,
    ])).rejects.toMatchObject({ code: "23505" });
    expect(await sql`select id from pt_items where id in (2, 3)`).toHaveLength(0);
    // The connection is clean for the next user.
    expect(await sql`select 1 as ok`).toHaveLength(1);
  });

  it("continues in the same transaction with dependent work, and rolls back if it fails", async () => {
    await pipelineTransaction(sql, (tx) => [tx`insert into pt_items (id, note) values (4, 'z')`], async (tx, [inserted]) => {
      expect(inserted.count).toBe(1);
      await tx`update pt_items set note = 'z2' where id = 4`;
    });
    expect((await sql`select note from pt_items where id = 4`)[0]?.note).toBe("z2");
    await expect(pipelineTransaction(sql, (tx) => [tx`insert into pt_items (id, note) values (5, 'w')`], async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await sql`select id from pt_items where id = 5`).toHaveLength(0);
  });

  it("sends begin, statements and commit without waiting between them", async () => {
    statements.length = 0;
    await pipelineTransaction(sql, (tx) => [tx`select 1`, tx`select 2`]);
    expect(statements).toEqual(["begin", "select 1", "select 2", "commit"]);
  });
});
