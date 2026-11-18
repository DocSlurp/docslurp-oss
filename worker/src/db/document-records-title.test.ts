import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "./store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** documents.metadata.title: the derived display title is written once and never overwritten. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1');
    insert into organizations(id, name, slug, created_by_user_id) values ('o2', 'Two', 'two', 'u1');
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W'), ('w2', 'o2', 'u1', 'W2');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values
      (100, 'r1', 'o1', 'u1', 'w1', 'upload', 'processing', 'extract', '{}', 2),
      (100, 'r2', 'o1', 'u1', 'w1', 'upload', 'processing', 'extract', '{}', 0),
      (100, 'r3', 'o2', 'u1', 'w2', 'upload', 'processing', 'extract', '{}', 0);
    insert into documents(id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w1', 'r1', 'a.pdf', 'application/pdf', 'k', 'queued', 2);
    insert into documents(id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count, metadata)
      values ('d2', 'o1', 'u1', 'w1', 'r1', 'b.pdf', 'application/pdf', 'k2', 'queued', 1, '{"title": "Renamed By User", "mapTitle": "Map"}');
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

/** A document as run r1 of organization o1 sees it. */
const row = (documentId: string) => ({ orgId: "o1", runId: "r1", documentId });

describe("PostgresDocumentRecords.setDocumentTitleIfAbsent", () => {
  it("adds the title beside existing metadata only when none is present", async () => {
    await db.exec(`update documents set metadata = '{"mapTitle": "Outline Title"}' where id = 'd1'`);
    expect(await store.records.setDocumentTitleIfAbsent(row("d1"), { title: "Board Update", source: "heading" })).toBe(true);
    // A re-run with a different derivation does not churn the stored title.
    expect(await store.records.setDocumentTitleIfAbsent(row("d1"), { title: "Something Else", source: "metadata" })).toBe(false);
    // A title already present (e.g. a user rename) wins.
    expect(await store.records.setDocumentTitleIfAbsent(row("d2"), { title: "Derived", source: "heading" })).toBe(false);
    expect(await store.records.setDocumentTitleIfAbsent(row("missing"), { title: "Derived", source: "heading" })).toBe(false);
    const rows = (await db.query(`select id, metadata from documents order by id`)).rows;
    expect(rows).toEqual([
      { id: "d1", metadata: { mapTitle: "Outline Title", title: "Board Update", titleSource: "heading" } },
      { id: "d2", metadata: { title: "Renamed By User", mapTitle: "Map" } },
    ]);
  }, 60_000);

  it("fills a blank title", async () => {
    await db.exec(`update documents set metadata = '{"title": "  "}' where id = 'd2'`);
    expect(await store.records.setDocumentTitleIfAbsent(row("d2"), { title: "Derived Title", source: "heading" })).toBe(true);
  }, 60_000);

  it("writes nothing outside the document's organization and run", async () => {
    await db.exec(`update documents set metadata = '{}' where id = 'd1'`);
    for (const wrong of [{ ...row("d1"), orgId: "o2" }, { ...row("d1"), runId: "r2" }, { ...row("d1"), runId: "r3", orgId: "o2" }, { ...row("d1"), orgId: null }]) {
      expect(await store.records.setDocumentTitleIfAbsent(wrong, { title: "Foreign", source: "heading" })).toBe(false);
    }
    expect((await db.query(`select metadata from documents where id = 'd1'`)).rows).toEqual([{ metadata: {} }]);
  }, 60_000);
});
