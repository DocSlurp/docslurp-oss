import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** document_page_facts (migration 0054): source facts and vision outcomes written by different stages. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W');
    insert into documents(id, org_id, user_id, workspace_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w1', 'a.pdf', 'application/pdf', 'k', 'queued', 2);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  store = new Store(`postgres://postgres@127.0.0.1:${served.port}/postgres`, 60_000, {
    poolMax: 1,
    workerSlots: { ttlMs: 60_000, globalCap: 0, defaultOrgSlots: 2 },
  });
}, 120_000);

afterAll(async () => {
  await store?.close();
  await server?.stop();
  await db?.close();
});

describe("Store.upsertPageFacts", () => {
  it("keeps each stage's columns, is idempotent and skips unknown documents", async () => {
    await store.upsertPageFacts([
      { documentId: "d1", runId: "r1", pageNumber: 1, textBytes: 1200, wordCount: 200, imageCount: 0, factsSource: "pdftotext+pdfimages" },
      { documentId: "d1", runId: "r1", pageNumber: 2, textBytes: 0, wordCount: 0, imageCount: 1, factsSource: "pdftotext+pdfimages" },
      { documentId: "missing", runId: "r1", pageNumber: 1, textBytes: 5 },
    ]);
    await store.upsertPageFacts([
      { documentId: "d1", runId: "r1", pageNumber: 1, visionStatus: "not-selected", visionTextBytes: null },
      { documentId: "d1", runId: "r1", pageNumber: 2, visionStatus: "extracted", visionTextBytes: 900 },
    ]);
    // A retried extraction rewrites only the source facts.
    await store.upsertPageFacts([{ documentId: "d1", runId: "r1", pageNumber: 2, textBytes: 0, wordCount: 0, imageCount: 1, factsSource: "pdftotext+pdfimages" }]);
    const rows = (await db.query(`select document_id, page_number, text_bytes, image_count, vision_status, vision_text_bytes from document_page_facts order by document_id, page_number`)).rows;
    expect(rows).toEqual([
      { document_id: "d1", page_number: 1, text_bytes: 1200, image_count: 0, vision_status: "not-selected", vision_text_bytes: null },
      { document_id: "d1", page_number: 2, text_bytes: 0, image_count: 1, vision_status: "extracted", vision_text_bytes: 900 },
    ]);
    await db.exec(`delete from documents where id = 'd1'`);
    expect((await db.query(`select count(*)::int as n from document_page_facts`)).rows).toEqual([{ n: 0 }]);
  }, 60_000);
});
