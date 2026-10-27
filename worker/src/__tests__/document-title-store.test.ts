import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
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
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W');
    insert into documents(id, org_id, user_id, workspace_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w1', 'a.pdf', 'application/pdf', 'k', 'queued', 2);
    insert into documents(id, org_id, user_id, workspace_id, filename, mime_type, source_key, status, page_count, metadata)
      values ('d2', 'o1', 'u1', 'w1', 'b.pdf', 'application/pdf', 'k2', 'queued', 1, '{"title": "Renamed By User", "mapTitle": "Map"}');
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

describe("Store.setDocumentTitleIfAbsent", () => {
  it("adds the title beside existing metadata only when none is present", async () => {
    await db.exec(`update documents set metadata = '{"mapTitle": "Outline Title"}' where id = 'd1'`);
    expect(await store.setDocumentTitleIfAbsent("d1", { title: "Board Update", source: "heading" })).toBe(true);
    // A re-run with a different derivation does not churn the stored title.
    expect(await store.setDocumentTitleIfAbsent("d1", { title: "Something Else", source: "metadata" })).toBe(false);
    // A title already present (e.g. a user rename) wins.
    expect(await store.setDocumentTitleIfAbsent("d2", { title: "Derived", source: "heading" })).toBe(false);
    expect(await store.setDocumentTitleIfAbsent("missing", { title: "Derived", source: "heading" })).toBe(false);
    const rows = (await db.query(`select id, metadata from documents order by id`)).rows;
    expect(rows).toEqual([
      { id: "d1", metadata: { mapTitle: "Outline Title", title: "Board Update", titleSource: "heading" } },
      { id: "d2", metadata: { title: "Renamed By User", mapTitle: "Map" } },
    ]);
  }, 60_000);

  it("fills a blank title", async () => {
    await db.exec(`update documents set metadata = '{"title": "  "}' where id = 'd2'`);
    expect(await store.setDocumentTitleIfAbsent("d2", { title: "Derived Title", source: "heading" })).toBe(true);
  }, 60_000);
});
