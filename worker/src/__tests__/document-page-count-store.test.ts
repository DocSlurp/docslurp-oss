import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/** documents.page_count: the worker replaces intake's count of an Office file with the pages it measured, scoped to its own run. */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'W');
    insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage) values ('run1', 'o1', 'u1', 'w1', 'bulk', 'processing', 'queued');
    insert into workspace_runs(id, org_id, user_id, workspace_id, kind, status, stage) values ('run2', 'o1', 'u1', 'w1', 'bulk', 'processing', 'queued');
    insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, file_facts)
      values ('long-docx', 'o1', 'u1', 'w1', 'run1', 'contract.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'k1', 'processing', 1,
        '{"mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","format":"office-word","mismatch":"same-family","declaredMimeType":"application/msword","sniffedMimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","container":"zip","encoding":null}');
    insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('other-run', 'o1', 'u1', 'w1', 'run2', 'b.docx', 'application/msword', 'k2', 'processing', 1);
    insert into documents(id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, deduped_from_document_id)
      values ('copy', 'o1', 'u1', 'w1', 'run1', 'copy.docx', 'application/msword', 'k3', 'processing', 1, 'long-docx');
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

describe("Store.setDocumentPageCount", () => {
  it("ends a long DOCX with its measured page count, and loads the file facts intake persisted", async () => {
    expect(await store.setDocumentPageCount("run1", "long-docx", 300)).toBe(true);
    const [row] = (await db.query<{ page_count: number }>(`select page_count from documents where id = 'long-docx'`)).rows;
    expect(row!.page_count).toBe(300);
    const document = await store.loadDocument("long-docx");
    expect(document).toMatchObject({ pageCount: 300, fileFacts: { format: "office-word", mismatch: "same-family", declaredMimeType: "application/msword" } });
  }, 60_000);

  it("never writes another run's document or a deduplicated copy", async () => {
    expect(await store.setDocumentPageCount("run1", "other-run", 999)).toBe(false);
    expect(await store.setDocumentPageCount("run1", "copy", 999)).toBe(false);
    expect(await store.setDocumentPageCount("run1", "missing", 999)).toBe(false);
    const rows = (await db.query<{ id: string; page_count: number }>(`select id, page_count from documents where id in ('other-run','copy') order by id`)).rows;
    expect(rows).toEqual([{ id: "copy", page_count: 1 }, { id: "other-run", page_count: 1 }]);
  }, 60_000);
});

describe("Store.setDocumentFileFacts", () => {
  const full = {
    declaredMimeType: "application/msword",
    sniffedMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    format: "office-excel",
    container: "zip",
    encoding: null,
    mismatch: "corrected",
    inspection: "full",
  } as never;

  it("replaces a document's provisional facts and MIME type with the worker's full inspection", async () => {
    expect(await store.setDocumentFileFacts("run1", "long-docx", full)).toBe(true);
    const document = await store.loadDocument("long-docx");
    expect(document).toMatchObject({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fileFacts: { inspection: "full", mismatch: "corrected" } });
  }, 60_000);

  it("never writes another run's document or a deduplicated copy", async () => {
    expect(await store.setDocumentFileFacts("run1", "other-run", full)).toBe(false);
    expect(await store.setDocumentFileFacts("run1", "copy", full)).toBe(false);
    expect(await store.setDocumentFileFacts("run1", "missing", full)).toBe(false);
    const rows = (await db.query<{ id: string; mime_type: string }>(`select id, mime_type from documents where id in ('other-run','copy') order by id`)).rows;
    expect(rows).toEqual([{ id: "copy", mime_type: "application/msword" }, { id: "other-run", mime_type: "application/msword" }]);
  }, 60_000);
});
