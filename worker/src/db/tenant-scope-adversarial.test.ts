import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DocumentOutOfScopeError } from "./missing-document.js";
import { Store } from "./store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Two organizations, two runs each side: every document-scoped port is called with the other tenant's (or another run's)
 * ids and must neither read nor write the other's rows. Adapted from the council's adversarial suite on #472.
 */
let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

const D1 = { orgId: "o1", runId: "r1", documentId: "d1" };
const wrongScopes = [
  { orgId: "o2", runId: "r2", documentId: "d1" },
  { orgId: "o2", runId: "r1", documentId: "d1" },
  { orgId: "o1", runId: "r1b", documentId: "d1" },
  { orgId: null, runId: "r1", documentId: "d1" },
];
const count = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0]!.n;
const chunk = (id: string, runId: string, text: string) => ({
  id, documentId: "d1", runId, userId: "u1", chunkIndex: 0, text, headingPath: ["Overview"], tokenEstimate: 2, metadata: { source: "test" },
});

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com'), ('u2', 'B', 'b@example.com');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'One', 'one', 'u1'), ('o2', 'Two', 'two', 'u2');
    insert into projects(id, org_id, user_id, name) values ('w1', 'o1', 'u1', 'Quarterly results'), ('w2', 'o2', 'u2', 'Other');
    insert into project_runs (monthly_reservation_cents, id, org_id, user_id, project_id, kind, status, stage, pipeline, total_documents) values
      (100, 'r1', 'o1', 'u1', 'w1', 'upload', 'processing', 'embed', '{}', 1),
      (100, 'r1b', 'o1', 'u1', 'w1', 'upload', 'processing', 'embed', '{}', 0),
      (100, 'r2', 'o2', 'u2', 'w2', 'upload', 'processing', 'embed', '{}', 1);
    insert into documents(id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, page_count)
      values ('d1', 'o1', 'u1', 'w1', 'r1', 'a.pdf', 'application/pdf', 'k1', 'processing', 2),
             ('d2', 'o2', 'u2', 'w2', 'r2', 'b.pdf', 'application/pdf', 'k2', 'processing', 2);
    insert into document_chunks(id, document_id, run_id, user_id, chunk_index, text) values ('d1-000', 'd1', 'r1', 'u1', 0, 'earnings beat');
    insert into document_pages(id, document_id, run_id, user_id, page_number, text) values ('d1-page-0001', 'd1', 'r1', 'u1', 1, 'page one');
    insert into document_chunks(id, document_id, run_id, user_id, chunk_index, text) values ('d2-000', 'd2', 'r2', 'u2', 0, 'other org text');
    insert into document_pages(id, document_id, run_id, user_id, page_number, text) values ('d2-page-0001', 'd2', 'r2', 'u2', 1, 'other org page');
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

describe("content port: another organization or run reads and writes nothing of d1", () => {
  it("in scope: chunks, pages, propositions and the summary are written", async () => {
    await store.content.insertChunks(D1, [chunk("d1-000", "r1", "earnings beat, rewritten")]);
    await store.content.insertPages(D1, [{ id: "d1-page-0002", documentId: "d1", runId: "r1", userId: "u1", pageNumber: 2, text: "two", tokenEstimate: 1 }]);
    await store.content.insertPropositions(D1, [{ id: "d1-p0", documentId: "d1", runId: "r1", userId: "u1", chunkIndex: 0, text: "p", sourceParagraph: "s", tokenEstimate: 1 }]);
    await store.content.insertSummary(D1, { id: "d1-summary", documentId: "d1", runId: "r1", userId: "u1", summary: "a summary" });
    expect((await db.query(`select text, heading_path, metadata from document_chunks where id = 'd1-000'`)).rows)
      .toEqual([{ text: "earnings beat, rewritten", heading_path: ["Overview"], metadata: { source: "test" } }]);
    expect(await count(`select count(*)::int as n from document_pages where document_id = 'd1'`)).toBe(2);
    expect(await count(`select count(*)::int as n from document_propositions where document_id = 'd1'`)).toBe(1);
    expect(await count(`select count(*)::int as n from document_summaries where document_id = 'd1'`)).toBe(1);
    expect(await store.content.staleDocumentChunkIds(D1, [])).toEqual(["d1-000"]);
  }, 60_000);

  it("out of scope: every insert throws a scope error and writes nothing", async () => {
    for (const scope of wrongScopes) {
      const runId = scope.runId;
      // Rows match the claimed scope, so only the database's scope predicate can refuse them.
      await expect(store.content.insertChunks(scope, [chunk("evil-c", runId, "x")])).rejects.toBeInstanceOf(DocumentOutOfScopeError);
      await expect(store.content.insertPages(scope, [{ id: "evil-p", documentId: "d1", runId, userId: "u2", pageNumber: 9, text: "x", tokenEstimate: 1 }]))
        .rejects.toBeInstanceOf(DocumentOutOfScopeError);
      await expect(store.content.insertPropositions(scope, [{ id: "evil-q", documentId: "d1", runId, userId: "u2", chunkIndex: 0, text: "x", sourceParagraph: "x", tokenEstimate: 1 }]))
        .rejects.toBeInstanceOf(DocumentOutOfScopeError);
      await expect(store.content.insertSummary(scope, { id: "evil-s", documentId: "d1", runId, userId: "u2", summary: "x" })).rejects.toBeInstanceOf(DocumentOutOfScopeError);
    }
    expect(await count(`select count(*)::int as n from document_chunks where id like 'evil%'`)).toBe(0);
    expect(await count(`select count(*)::int as n from document_pages where id like 'evil%'`)).toBe(0);
    expect(await count(`select count(*)::int as n from document_propositions where id like 'evil%'`)).toBe(0);
    expect(await count(`select count(*)::int as n from document_summaries where id like 'evil%'`)).toBe(0);
  }, 60_000);

  it("out of scope: rows that do not match their scope are refused before any SQL", async () => {
    await expect(store.content.insertChunks({ orgId: "o2", runId: "r2", documentId: "d2" }, [chunk("evil-m", "r1", "x")])).rejects.toThrow(/outside their write scope/);
  }, 60_000);

  it("out of scope: stale reads see nothing; prunes, markers and links change nothing", async () => {
    for (const scope of wrongScopes) {
      expect(await store.content.staleDocumentChunkIds(scope, [])).toEqual([]);
      expect(await store.content.deleteStaleDocumentChunks(scope, [])).toEqual([]);
      await store.content.finalizeDocumentChunks(scope, [], true);
      await store.content.markDocumentLexicalSearchable(scope);
      await store.content.linkChunksToPages(scope);
    }
    expect(await count(`select count(*)::int as n from document_chunks where document_id = 'd1'`)).toBe(1);
    expect(await count(`select count(*)::int as n from documents where id = 'd1' and lexical_searchable_at is not null`)).toBe(0);
    expect(await count(`select count(*)::int as n from document_chunks where document_id = 'd1' and parent_page_id is not null`)).toBe(0);
    // The document's own scope still works.
    await store.content.finalizeDocumentChunks(D1, ["d1-000"], true);
    expect(await count(`select count(*)::int as n from documents where id = 'd1' and lexical_searchable_at is not null`)).toBe(1);
  }, 60_000);

  it("page facts: a write under another organization or run skips d1's rows", async () => {
    const row = { documentId: "d1", pageNumber: 1, textBytes: 10, wordCount: 2, imageCount: 0, factsSource: "pdftotext" };
    await store.content.upsertPageFacts({ orgId: "o2", runId: "r2" }, [{ ...row, runId: "r2" }]);
    await store.content.upsertPageFacts({ orgId: "o2", runId: "r1" }, [{ ...row, runId: "r1" }]);
    await store.content.upsertPageFacts({ orgId: "o1", runId: "r1b" }, [{ ...row, runId: "r1b" }]);
    // Rows of another run than the write's scope are dropped too.
    await store.content.upsertPageFacts({ orgId: "o1", runId: "r1b" }, [{ ...row, runId: "r1" }]);
    expect(await count(`select count(*)::int as n from document_page_facts where document_id = 'd1'`)).toBe(0);
    await store.content.upsertPageFacts({ orgId: "o1", runId: "r1" }, [{ ...row, runId: "r1" }]);
    expect(await count(`select count(*)::int as n from document_page_facts where document_id = 'd1'`)).toBe(1);
  }, 60_000);
});

describe("records port: org o2's run cannot touch o1's document", () => {
  it("PII withholding: another org or run withholds (fail closed); the append refuses and writes nothing", async () => {
    await db.exec(`update documents set metadata = '{"pii":{"redacted":false,"blocked":false}}' where id = 'd1'`);
    expect(await store.records.documentPiiWithholds(D1)).toBe(false);
    for (const scope of wrongScopes) {
      expect(await store.records.documentPiiWithholds(scope)).toBe(true);
      await expect(store.records.appendWithheldArtifactUris(scope, ["s3://x/foreign"])).rejects.toThrow();
    }
    expect((await db.query<{ m: unknown }>(`select metadata->'pii'->'withheldArtifactUris' as m from documents where id = 'd1'`)).rows[0]!.m).toBeNull();
  }, 60_000);

  it("page-scoped withholding and its PII categories: another org or run reads the whole document as withheld, never o1's pages or types", async () => {
    await db.exec(`update documents set metadata = '{"pii":{"scope":"pages","withheldPages":[2],"patternTypes":["email"],"withheldPageTypes":{"2":["email"]},"withheldArtifactUris":["s3://x/p2"]}}' where id = 'd1'`);
    expect(await store.records.documentPiiWithholding(D1)).toEqual({ scope: "pages", pages: new Set([2]), pageTypes: new Map([[2, ["email"]]]), types: ["email"] });
    for (const scope of wrongScopes) expect(await store.records.documentPiiWithholding(scope)).toEqual({ scope: "document", reason: "missing-document" });
    await db.exec(`update documents set metadata = '{}' where id = 'd1'`);
  }, 60_000);

  it("title, file facts and parse source: another org's or run's write is a no-op", async () => {
    for (const scope of wrongScopes) {
      expect(await store.records.setDocumentTitleIfAbsent(scope, { title: "Foreign", source: "heading" })).toBe(false);
    }
    expect(await store.records.setDocumentParseSource("r2", "d1", null)).toBe(false);
    expect(await store.records.setDocumentFileFacts("r2", "d1", { mimeType: "text/plain" } as never)).toBe(false);
    expect((await db.query<{ t: string | null }>(`select metadata->>'title' as t from documents where id = 'd1'`)).rows[0]!.t).toBeNull();
  }, 60_000);
});

describe("graph and document loads", () => {
  it("another organization gets the generic graph scope and no chunks; a load is a scope error", async () => {
    expect(await store.graph.projectGraphScope({ orgId: "o2", projectId: "w1" })).toBe("Project");
    expect(await store.graph.loadDocumentGraphChunks("w2", "d1")).toEqual([]);
    await expect(store.loadDocument("d1", { orgId: "o2" })).rejects.toBeInstanceOf(DocumentOutOfScopeError);
    await expect(store.loadDocument("d1", { runId: "r2" })).rejects.toBeInstanceOf(DocumentOutOfScopeError);
  }, 60_000);
});

describe("scope errors name the predicate the row failed", () => {
  it("org, run, or both; a null organization is an org mismatch", async () => {
    const mismatch = async (scope: { orgId: string | null; runId: string; documentId: string }) =>
      (await store.content.insertSummary(scope, { id: "m-s", documentId: scope.documentId, runId: scope.runId, userId: "u1", summary: "x" })
        .catch((error: unknown) => error)) as DocumentOutOfScopeError;
    expect((await mismatch({ orgId: "o2", runId: "r1", documentId: "d1" })).mismatch).toBe("org");
    expect((await mismatch({ orgId: "o1", runId: "r1b", documentId: "d1" })).mismatch).toBe("run");
    expect((await mismatch({ orgId: "o2", runId: "r2", documentId: "d1" })).mismatch).toBe("org and run");
    expect((await mismatch({ orgId: null, runId: "r1", documentId: "d1" })).mismatch).toBe("org");
    expect((await mismatch({ orgId: "o2", runId: "r2", documentId: "d1" })).message).toMatch(/org and run mismatch/);
  }, 60_000);
});

describe("an id collision with another document's row never overwrites it", () => {
  it("chunk and page upserts leave the other document's rows as they were", async () => {
    await store.content.insertChunks(D1, [{ ...chunk("d2-000", "r1", "overwrite attempt") }]);
    await store.content.insertPages(D1, [{ id: "d2-page-0001", documentId: "d1", runId: "r1", userId: "u1", pageNumber: 1, text: "overwrite attempt", tokenEstimate: 1 }]);
    expect((await db.query(`select document_id, run_id, text from document_chunks where id = 'd2-000'`)).rows)
      .toEqual([{ document_id: "d2", run_id: "r2", text: "other org text" }]);
    expect((await db.query(`select document_id, run_id, text from document_pages where id = 'd2-page-0001'`)).rows)
      .toEqual([{ document_id: "d2", run_id: "r2", text: "other org page" }]);
  }, 60_000);
});

describe("lone UTF-16 surrogates are stored as U+FFFD, as the text protocol stored them", () => {
  it("chunks, pages, propositions and the summary accept \"ab\\ud83dcd\"", async () => {
    const broken = "ab\ud83dcd";
    const fixed = "ab\ufffdcd";
    await store.content.insertChunks(D1, [{ ...chunk("d1-sur", "r1", broken), headingPath: [broken], metadata: { rawText: broken, nested: [broken] } }]);
    await store.content.insertPages(D1, [{ id: "d1-page-sur", documentId: "d1", runId: "r1", userId: "u1", pageNumber: 7, text: broken, tokenEstimate: 1 }]);
    await store.content.insertPropositions(D1, [{ id: "d1-p-sur", documentId: "d1", runId: "r1", userId: "u1", chunkIndex: 0, text: broken, sourceParagraph: broken, tokenEstimate: 1 }]);
    await store.content.insertSummary(D1, { id: "d1-s-sur", documentId: "d1", runId: "r1", userId: "u1", summary: broken });
    expect((await db.query(`select text, heading_path, metadata from document_chunks where id = 'd1-sur'`)).rows)
      .toEqual([{ text: fixed, heading_path: [fixed], metadata: { rawText: fixed, nested: [fixed] } }]);
    expect((await db.query(`select text from document_pages where id = 'd1-page-sur'`)).rows).toEqual([{ text: fixed }]);
    expect((await db.query(`select text, source_paragraph from document_propositions where id = 'd1-p-sur'`)).rows).toEqual([{ text: fixed, source_paragraph: fixed }]);
    expect((await db.query(`select summary from document_summaries where id = 'd1-s-sur'`)).rows).toEqual([{ summary: fixed }]);
  }, 60_000);
});
