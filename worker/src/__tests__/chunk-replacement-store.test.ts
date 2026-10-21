import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

// A retried embed replaces the document's chunks. Until the replacement is
// complete the previous attempt's keyword marker is lifted, and chunk rows
// beyond the new set are dropped (without touching other documents).
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'embed', '{}', 2);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, lexical_searchable_at)
      values ('d1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 1, now()),
             ('d2', 'o1', 'u1', 'w', 'run-1', 'b.pdf', 'application/pdf', 'k2', 'processing', 1, now());
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text) values
      ('d1-000', 'd1', 'run-1', 'u1', 0, 'old zero'), ('d1-001', 'd1', 'run-1', 'u1', 1, 'old one'),
      ('d1-002', 'd1', 'run-1', 'u1', 2, 'old two'),
      ('d2-000', 'd2', 'run-1', 'u1', 0, 'other zero'), ('d2-001', 'd2', 'run-1', 'u1', 1, 'other one');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, { poolMax: 1 });
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

const lexical = async (id: string) =>
  (await sql<{ marked: boolean }[]>`select lexical_searchable_at is not null as marked from documents where id = ${id}`)[0]?.marked;

describe("chunk replacement on a retried embed", () => {
  it("lifts the previous marker when embed starts, but not for other stages", async () => {
    const state = await loadRunState(store, "run-1");
    await store.startDocumentStage(state, "d1", "index");
    expect(await lexical("d1")).toBe(true);
    await store.startDocumentStage(state, "d1", "embed");
    expect(await lexical("d1")).toBe(false);
    // The untouched document keeps serving.
    expect(await lexical("d2")).toBe(true);
  });

  it("drops only this document's chunks outside the replacement set", async () => {
    expect(await store.staleDocumentChunkIds("d1", ["d1-000", "d1-001"])).toEqual(["d1-002"]);
    const stale = await store.deleteStaleDocumentChunks("d1", ["d1-000", "d1-001"]);
    expect(stale).toEqual(["d1-002"]);
    expect(await sql`select id from document_chunks where document_id = 'd1' order by id`)
      .toEqual([{ id: "d1-000" }, { id: "d1-001" }]);
    expect(await sql`select id from document_chunks where document_id = 'd2' order by id`)
      .toEqual([{ id: "d2-000" }, { id: "d2-001" }]);
  });

  it("replaces, prunes and re-marks in order", async () => {
    await store.insertChunks([{
      id: "d1-000", documentId: "d1", runId: "run-1", userId: "u1", chunkIndex: 0,
      text: "new zero", headingPath: [], tokenEstimate: 2, metadata: {},
    }]);
    await store.deleteStaleDocumentChunks("d1", ["d1-000"]);
    expect(await lexical("d1")).toBe(false);
    await store.markDocumentLexicalSearchable("d1");
    expect(await lexical("d1")).toBe(true);
    expect(await sql`select id, text from document_chunks where document_id = 'd1'`).toEqual([{ id: "d1-000", text: "new zero" }]);
  });
});
