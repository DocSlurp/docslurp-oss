import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { connect } from "@lancedb/lancedb";
import { LANCEDB_SUMMARIES_TABLE, VectorNamespaceManager, type SummaryRow } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteLanceDbDocumentRows,
  drainDocumentCleanupQueue,
  drainStorageCleanupQueue,
  purgeSupersededDocuments,
  type DeleteVectorRows,
  type SupersededPurgeOptions,
} from "../db/superseded-purge.js";
import {
  deleteDocumentSummaryRows,
  deleteSummaryRowsById,
  projectSummariesLocation,
  SummaryRowsRefused,
  writeSummaryRows,
} from "../stages/lancedb-summaries.js";
import { enqueueSummaryTreeCleanup, withdrawSummaryTreeForPii } from "../summary-tree/state-store.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

/**
 * Summary tree purge paths against a migrated Postgres and real LanceDB tables on disk: every way a document leaves
 * (delete, supersede, archive, project delete) takes its rows out of the project's `summaries` table and its
 * registry rows out of Postgres, and nothing of another document or project. After the strict delete the summary
 * text is in no file under the table.
 */

const MODEL = "model/x";
const DIM = 4;
const space = { model: MODEL, dimensions: DIM };

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;
let root: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@example.com'), ('u2', 'B', 'b@example.com')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, retain_document_versions)
    values ('o1', 'Org', 'org', 'u1', 1), ('o2', 'Other', 'other', 'u2', 1)`;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  root = await mkdtemp(path.join(tmpdir(), "docslurp-summary-tree-"));
  await sql`delete from projects`;
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
  await sql`delete from vector_index_tables`;
  await sql`update organizations set retain_document_versions = 1`;
  await sql`insert into projects(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('w2', 'o1', 'u1', 'W2'), ('x', 'o2', 'u2', 'X')`;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Scope = { orgId: string; projectId: string };
const W: Scope = { orgId: "o1", projectId: "w" };
const W2: Scope = { orgId: "o1", projectId: "w2" };
const X: Scope = { orgId: "o2", projectId: "x" };

async function seedDocument(id: string, scope: Scope, args: { canonicalId?: string; createdAt?: string } = {}) {
  const userId = scope.orgId === "o1" ? "u1" : "u2";
  await sql`
    insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status,
      canonical_id, created_at, page_count, file_size)
    values (${id}, ${scope.orgId}, ${userId}, ${scope.projectId}, null, ${`${id}.md`}, 'text/markdown', ${`${userId}/src/raw/${id}.md`},
      'queued', ${args.canonicalId ?? `/${id}`}, ${args.createdAt ?? "2026-01-01"}, 2, 10)
  `;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', ${MODEL}, ${DIM})`;
  // Completing a version supersedes the previous one in its chain.
  await sql`update documents set status = 'completed' where id = ${id}`;
}

function rowsFor(documentId: string, text: (index: number) => string, count = 6): SummaryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${documentId}:n${index}`,
    documentId,
    runId: "run-1",
    level: 1,
    chunkStart: index * 4,
    chunkEnd: index * 4 + 3,
    pageStart: index + 1,
    pageEnd: index + 1,
    headingPath: "Intro > Scope",
    text: text(index),
    vector: Array.from({ length: DIM }, (_, i) => Math.sin(index * 7 + i)),
  }));
}

/** A built tree: state row, node registry rows and the summary rows in the project's table. */
async function seedTree(documentId: string, scope: Scope, text: (index: number) => string) {
  await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension, node_count)
    values (${documentId}, ${scope.orgId}, ${scope.projectId}, 'run-1', 'ready', ${MODEL}, ${DIM}, 6)`;
  const rows = rowsFor(documentId, text);
  for (const row of rows) {
    await sql`insert into document_summary_tree_nodes (id, document_id, org_id, project_id, run_id, node_hash, level, status, chunk_start, chunk_end, page_start, page_end)
      values (${row.id}, ${documentId}, ${scope.orgId}, ${scope.projectId}, 'run-1', ${`hash-${row.id}`}, 1, 'ready', ${row.chunkStart}, ${row.chunkEnd}, ${row.pageStart}, ${row.pageEnd})`;
  }
  await writeSummaryRows({ sql, scope, space, documentId, runId: "run-1", rows, root });
}

/** Document ids with rows in a project's summaries table; null when the table does not exist. */
async function summaryDocuments(scope: Scope): Promise<string[] | null> {
  const location = projectSummariesLocation(scope, space, root);
  const connection = await connect(location.uri);
  try {
    if (!(await connection.tableNames()).includes(location.table)) return null;
    const table = await connection.openTable(location.table);
    try {
      const rows = await table.query().select(["documentId"]).limit(10_000).toArray() as Array<{ documentId: string }>;
      return [...new Set(rows.map((row) => row.documentId))].sort();
    } finally {
      table.close();
    }
  } finally {
    connection.close();
  }
}

async function filesContaining(needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if ((await readFile(file)).includes(needle)) hits.push(file);
  }
  return hits;
}

async function registry(documentId: string) {
  const [row] = await sql<{ trees: number; nodes: number }[]>`
    select (select count(*)::int from document_summary_trees where document_id = ${documentId}) as trees,
      (select count(*)::int from document_summary_tree_nodes where document_id = ${documentId}) as nodes
  `;
  return row!;
}

const storage = { bucket: "b", async listKeys() { return { keys: [] as string[] }; }, async deleteKeys() {} };

/** Real LanceDB deletes and drops under the test root. */
function options(overrides: Partial<SupersededPurgeOptions> = {}): SupersededPurgeOptions {
  return { graceSeconds: 0, batchSize: 10, deleteSources: false, lancedbRoot: root, ...overrides };
}

describe("summaries table location", () => {
  it("is a second table in the project's own database", () => {
    const chunks = VectorNamespaceManager.getEmbeddingLocation(root, "o1", "w", MODEL, DIM);
    const summaries = projectSummariesLocation(W, space, root);
    expect(chunks.table).toBe("chunks");
    expect(summaries).toEqual({ uri: chunks.uri, table: LANCEDB_SUMMARIES_TABLE });
    expect(VectorNamespaceManager.summariesLocation(chunks)).toEqual(summaries);
    expect(projectSummariesLocation(W2, space, root).uri).not.toBe(summaries.uri);
  });

  it("refuses a missing tenant scope and an unknown table name", () => {
    expect(() => projectSummariesLocation({ orgId: "o1", projectId: "" }, space, root)).toThrow(/tenant isolation/);
    expect(() => projectSummariesLocation({ orgId: null, projectId: "w" }, space, root)).toThrow(/tenant isolation/);
    expect(() => VectorNamespaceManager.getEmbeddingLocation(root, "o1", "w", MODEL, DIM, "other" as never)).toThrow(/known table/);
    expect(() => VectorNamespaceManager.getEmbeddingLocation(root, "o1", "../w", MODEL, DIM, "summaries")).toThrow(/safe projectId/);
  });
});

describe("writing summary rows", () => {
  it("writes only for a live document of that org and project that is indexed and tracked", async () => {
    await seedDocument("a", W);
    const rows = rowsFor("a", (index) => `summary ${index}`);
    const write = (overrides: Partial<Parameters<typeof writeSummaryRows>[0]> = {}) =>
      writeSummaryRows({ sql, scope: W, space, documentId: "a", runId: "run-1", rows, root, ...overrides });

    // No tree state row yet: nothing would gate serving or name the embedding space.
    await expect(write()).rejects.toThrow(SummaryRowsRefused);
    await sql`insert into document_summary_trees (document_id, org_id, project_id, run_id, status, embedding_model, dimension)
      values ('a', 'o1', 'w', 'run-1', 'building', ${MODEL}, ${DIM})`;

    // Another project, another org: the document is not theirs.
    await expect(write({ scope: W2 })).rejects.toThrow(/not a live document of this project/);
    await expect(write({ scope: X })).rejects.toThrow(/not a live document of this project/);
    await expect(write({ scope: { orgId: "o2", projectId: "w" } })).rejects.toThrow(/not a live document of this project/);
    // Rows that name another document or run, a vector of the wrong size, an embedding space the document is not in.
    await expect(write({ rows: [{ ...rows[0]!, documentId: "b" }] })).rejects.toThrow(/another document/);
    await expect(write({ rows: [{ ...rows[0]!, runId: "run-2" }] })).rejects.toThrow(/another run/);
    await expect(write({ rows: [{ ...rows[0]!, vector: [1, 2] }] })).rejects.toThrow(/embedding space/);
    await expect(write({ space: { model: "model/y", dimensions: DIM } })).rejects.toThrow(/not indexed in this embedding space/);
    await expect(write({ rows: [{ ...rows[0]!, id: "a' OR '1'='1" }] })).rejects.toThrow();
    await expect(write({ rows: [{ ...rows[0]!, chunkEnd: -1 }] })).rejects.toThrow();
    // A builder that does not hold the document's tree: another build took it, or it is no longer being built.
    await sql`update document_summary_trees set build_owner = 'run:run-2' where document_id = 'a'`;
    await expect(write({ owner: "run:run-1" })).rejects.toThrow(/no summary tree being built/);
    await sql`update document_summary_trees set status = 'ready', build_owner = null where document_id = 'a'`;
    await expect(write({ owner: "run:run-1" })).rejects.toThrow(/no summary tree being built/);
    // A corrected (or otherwise skipped) document has no tree to write rows for, with or without a named builder.
    await sql`update document_summary_trees set status = 'skipped', skip_reason = 'corrected' where document_id = 'a'`;
    await expect(write()).rejects.toThrow(/no summary tree being built/);
    await expect(write({ owner: "run:run-1" })).rejects.toThrow(/no summary tree being built/);
    expect(await summaryDocuments(W)).toBeNull();
    expect(await summaryDocuments(W2)).toBeNull();

    await sql`update document_summary_trees set status = 'building', skip_reason = null, build_owner = 'run:run-1' where document_id = 'a'`;
    await write({ owner: "run:run-1" });
    expect(await summaryDocuments(W)).toEqual(["a"]);
    // Replay converges on one row per id.
    await write();
    const location = projectSummariesLocation(W, space, root);
    const connection = await connect(location.uri);
    const table = await connection.openTable(location.table);
    expect(await table.countRows()).toBe(rows.length);
    expect((await table.schema()).fields.map((field) => field.name).sort()).toEqual(
      ["chunkEnd", "chunkStart", "documentId", "headingPath", "id", "level", "pageEnd", "pageStart", "runId", "text", "vector"],
    );
    table.close();
    connection.close();

    // A superseded version takes no more rows.
    await seedDocument("a2", W, { canonicalId: "/a", createdAt: "2026-01-02" });
    expect((await sql`select superseded_at is not null as superseded from documents where id = 'a'`)[0]).toEqual({ superseded: true });
    await expect(write()).rejects.toThrow(/not a live document of this project/);
  });

  it("deletes rows by id and by document, strictly, and treats a missing table as nothing to delete", async () => {
    await seedDocument("a", W);
    await seedDocument("b", W);
    await seedTree("a", W, (index) => `ERASEME-a-${index} confidential`);
    await seedTree("b", W, (index) => `KEEPME-b-${index}`);

    await deleteSummaryRowsById({ scope: W, space, ids: ["a:n0", "a:n1"], root });
    expect(await filesContaining("ERASEME-a-0")).toEqual([]);
    expect((await filesContaining("ERASEME-a-2")).length).toBeGreaterThan(0);
    await expect(deleteSummaryRowsById({ scope: W, space, ids: ["x' OR '1'='1"], root })).rejects.toThrow(SummaryRowsRefused);

    expect(await deleteDocumentSummaryRows({ scope: W, space, documentIds: ["a"], root })).toBeUndefined();
    expect(await summaryDocuments(W)).toEqual(["b"]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect((await filesContaining("KEEPME-b-")).length).toBeGreaterThan(0);

    expect(await deleteDocumentSummaryRows({ scope: W2, space, documentIds: ["a"], root })).toBe("missing");
    await expect(deleteSummaryRowsById({ scope: W2, space, ids: ["a:n0"], root })).resolves.toBeUndefined();
  });
});

describe("summary tree purge", () => {
  it("document delete removes that document's summary rows and registry rows, and no other document's or project's", async () => {
    await seedDocument("a", W);
    await seedDocument("b", W);
    await seedDocument("c", W2);
    await seedDocument("d", X);
    // Identical text in another project and another org: neither is touched.
    await seedTree("a", W, (index) => `ERASEME-${index} confidential`);
    await seedTree("b", W, (index) => `KEEPME-b-${index}`);
    await seedTree("c", W2, (index) => `ERASEME-${index} confidential`);
    await seedTree("d", X, (index) => `ERASEME-${index} confidential`);
    const tableFiles = async (scope: Scope) => {
      const prefix = projectSummariesLocation(scope, space, root).uri;
      return (await filesContaining("ERASEME-")).filter((file) => file.startsWith(`${prefix}/`));
    };
    expect((await tableFiles(W)).length).toBeGreaterThan(0);

    await sql`delete from documents where id = 'a'`;
    // The registry rows cascade with the document, before any sweep.
    expect(await registry("a")).toEqual({ trees: 0, nodes: 0 });
    expect(await registry("b")).toEqual({ trees: 1, nodes: 6 });

    expect(await drainDocumentCleanupQueue(sql, storage, options())).toEqual({ purged: 1, failed: 0 });

    expect(await summaryDocuments(W)).toEqual(["b"]);
    expect(await summaryDocuments(W2)).toEqual(["c"]);
    expect(await summaryDocuments(X)).toEqual(["d"]);
    // Strict cleanup: the text is in no file under the table, not just hidden by a deletion vector.
    expect(await tableFiles(W)).toEqual([]);
    expect((await tableFiles(W2)).length).toBeGreaterThan(0);
    expect((await tableFiles(X)).length).toBeGreaterThan(0);
    expect((await filesContaining("KEEPME-b-")).length).toBeGreaterThan(0);
    expect(await registry("c")).toEqual({ trees: 1, nodes: 6 });
    expect(await registry("d")).toEqual({ trees: 1, nodes: 6 });
    expect(await sql`select document_id from document_cleanup_queue`).toEqual([]);
  });

  it("keeps the delete queued until the strict summaries delete succeeds", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index} confidential`);
    await sql`delete from documents where id = 'a'`;

    const calls: Array<{ table: string; purgeHistory?: boolean }> = [];
    let fail = true;
    const flaky: DeleteVectorRows = async (args) => {
      calls.push({ table: args.table, ...(args.purgeHistory ? { purgeHistory: true } : {}) });
      if (args.table === LANCEDB_SUMMARIES_TABLE && fail) throw new Error("history prune failed");
      return await deleteLanceDbDocumentRows(args);
    };
    expect(await drainDocumentCleanupQueue(sql, storage, options({ deleteVectorRows: flaky }))).toEqual({ purged: 0, failed: 1 });
    expect(calls).toContainEqual({ table: LANCEDB_SUMMARIES_TABLE, purgeHistory: true });
    expect(await sql`select document_id, last_error from document_cleanup_queue`)
      .toEqual([{ document_id: "a", last_error: "history prune failed" }]);
    expect(await summaryDocuments(W)).toEqual(["a"]);

    fail = false;
    expect(await drainDocumentCleanupQueue(sql, storage, options({ deleteVectorRows: flaky }))).toEqual({ purged: 1, failed: 0 });
    expect(await summaryDocuments(W)).toEqual([]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect(await sql`select document_id from document_cleanup_queue`).toEqual([]);
  });

  it("supersede removes the old version's summary rows and registry rows and keeps the new version's", async () => {
    await seedDocument("v1", W, { canonicalId: "/doc", createdAt: "2026-01-01" });
    await seedTree("v1", W, (index) => `ERASEME-${index} old version`);
    await seedDocument("other", W);
    await seedTree("other", W, (index) => `KEEPME-other-${index}`);
    await seedDocument("v2", W, { canonicalId: "/doc", createdAt: "2026-01-02" });
    await seedTree("v2", W, (index) => `KEEPME-v2-${index}`);

    expect(await purgeSupersededDocuments(sql, storage, options())).toMatchObject({ purged: 1, failed: 0 });

    expect((await sql`select purged_at is not null as purged from documents where id = 'v1'`)[0]).toEqual({ purged: true });
    expect(await registry("v1")).toEqual({ trees: 0, nodes: 0 });
    expect(await registry("v2")).toEqual({ trees: 1, nodes: 6 });
    expect(await registry("other")).toEqual({ trees: 1, nodes: 6 });
    expect(await summaryDocuments(W)).toEqual(["other", "v2"]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect((await filesContaining("KEEPME-v2-")).length).toBeGreaterThan(0);
  });

  it("a failed summaries delete leaves the superseded version unpurged with its registry rows", async () => {
    await seedDocument("v1", W, { canonicalId: "/doc", createdAt: "2026-01-01" });
    await seedTree("v1", W, (index) => `ERASEME-${index} old version`);
    await seedDocument("v2", W, { canonicalId: "/doc", createdAt: "2026-01-02" });
    const failing: DeleteVectorRows = async (args) => {
      if (args.table === LANCEDB_SUMMARIES_TABLE) throw new Error("history prune failed");
      return await deleteLanceDbDocumentRows(args);
    };
    expect(await purgeSupersededDocuments(sql, storage, options({ deleteVectorRows: failing }))).toMatchObject({ purged: 0, failed: 1 });
    expect((await sql`select purged_at is not null as purged from documents where id = 'v1'`)[0]).toEqual({ purged: false });
    expect(await registry("v1")).toEqual({ trees: 1, nodes: 6 });
  });

  it("archive removes a retained version's summary rows and registry rows: an archived version is never searchable", async () => {
    await sql`update organizations set retain_document_versions = 2 where id = 'o1'`;
    await seedDocument("v1", W, { canonicalId: "/doc", createdAt: "2026-01-01" });
    await seedTree("v1", W, (index) => `ERASEME-${index} old version`);
    await seedDocument("v2", W, { canonicalId: "/doc", createdAt: "2026-01-02" });
    await seedTree("v2", W, (index) => `KEEPME-v2-${index}`);

    expect(await purgeSupersededDocuments(sql, storage, options())).toMatchObject({ archived: 1, purged: 0, failed: 0 });

    expect((await sql`select archived_at is not null as archived, purged_at is not null as purged from documents where id = 'v1'`)[0])
      .toEqual({ archived: true, purged: false });
    expect(await registry("v1")).toEqual({ trees: 0, nodes: 0 });
    expect(await registry("v2")).toEqual({ trees: 1, nodes: 6 });
    expect(await summaryDocuments(W)).toEqual(["v2"]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
  });

  it("finds summary rows through the tree state's embedding space when the vector index row is gone", async () => {
    await seedDocument("v1", W, { canonicalId: "/doc", createdAt: "2026-01-01" });
    await seedTree("v1", W, (index) => `ERASEME-${index} old version`);
    await sql`delete from vector_indexes where document_id = 'v1'`;
    await seedDocument("v2", W, { canonicalId: "/doc", createdAt: "2026-01-02" });

    expect(await purgeSupersededDocuments(sql, storage, options())).toMatchObject({ purged: 1, failed: 0 });
    expect(await summaryDocuments(W)).toEqual([]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
  });

  it("project delete drops the project's summaries table by name, with the LanceDB root outside the artifact bucket", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index} confidential`);
    await seedDocument("c", W2);
    await seedTree("c", W2, (index) => `KEEPME-c-${index}`);
    // What server data-deletion.ts queues for the project (asserted there); no prefix purge, so only the named drops run.
    await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason) values
      ('vector_table', 'o1', 'o1|w|model/x|4', ${sql.json({ projectId: "w", embeddingModel: MODEL, dimension: DIM })}, 'project_deleted'),
      ('vector_table', 'o1', 'o1|w|model/x|4|summaries', ${sql.json({ projectId: "w", embeddingModel: MODEL, dimension: DIM, table: "summaries" })}, 'project_deleted')`;
    await sql`delete from projects where id = 'w'`;
    expect(await registry("a")).toEqual({ trees: 0, nodes: 0 });

    expect(await drainStorageCleanupQueue(sql, storage, options())).toMatchObject({ failed: 0 });
    // The per-document sweep then finds no table left to delete from.
    expect(await drainDocumentCleanupQueue(sql, storage, options())).toMatchObject({ failed: 0 });

    expect(await summaryDocuments(W)).toBeNull();
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect(await summaryDocuments(W2)).toEqual(["c"]);
    expect(await registry("c")).toEqual({ trees: 1, nodes: 6 });
    expect(await sql`select kind from storage_cleanup_queue where kind = 'vector_table'`).toEqual([]);
  });

  it("refuses a queued table name outside the project database's known tables", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `KEEPME-a-${index}`);
    await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason) values
      ('vector_table', 'o1', 'o1|w|model/x|4|bogus', ${sql.json({ projectId: "w", embeddingModel: MODEL, dimension: DIM, table: "../../w2/vectors-model%2Fx-4/summaries" })}, 'project_deleted')`;
    expect(await drainStorageCleanupQueue(sql, storage, options())).toMatchObject({ purged: 0, failed: 1 });
    expect(await summaryDocuments(W)).toEqual(["a"]);
  });
});

describe("queued removal of one document's summary tree (summary_tree_document)", () => {
  function objectStore(keys: string[]) {
    const objects = new Set(keys);
    return {
      objects,
      bucket: "b",
      async listKeys({ prefix }: { prefix: string }) { return { keys: [...objects].filter((key) => key.startsWith(prefix)).sort() }; },
      async deleteKeys(deleted: string[]) { for (const key of deleted) objects.delete(key); },
    };
  }

  it("removes the document's rows strictly, its artifact and its registry rows, and nothing of another document", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index} text from before the correction`);
    await seedDocument("b", W);
    await seedTree("b", W, (index) => `KEEPME-b-${index}`);
    const store = objectStore([
      "u1/run-1/summary-tree/a/summaries.jsonl", "u1/run-1/summary-tree/a/parts/x.jsonl",
      "u1/run-1/summary-tree/b/summaries.jsonl", "u1/run-1/summary-tree/ab/summaries.jsonl", "u1/run-1/embeddings/a.json",
    ]);
    // What the API queues with a correction reindex: the ids only. The tree row is already `skipped`.
    await sql`update document_summary_trees set status = 'skipped', skip_reason = 'corrected' where document_id = 'a'`;
    await enqueueSummaryTreeCleanup(sql, { scope: W, documentId: "a", reason: "document_corrected", artifactRoots: ["u1/run-1/summary-tree/a"] });

    expect(await drainStorageCleanupQueue(sql, store, options())).toEqual({ purged: 1, failed: 0 });
    expect(await summaryDocuments(W)).toEqual(["b"]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect([...store.objects].sort()).toEqual(["u1/run-1/embeddings/a.json", "u1/run-1/summary-tree/ab/summaries.jsonl", "u1/run-1/summary-tree/b/summaries.jsonl"]);
    expect(await registry("a")).toEqual({ trees: 1, nodes: 0 });
    expect(await sql`select status, skip_reason from document_summary_trees where document_id = 'a'`).toEqual([{ status: "skipped", skip_reason: "corrected" }]);
    expect(await registry("b")).toEqual({ trees: 1, nodes: 6 });
    expect(await sql`select kind from storage_cleanup_queue`).toEqual([]);
  });

  it("removes what a build left for a document that no longer exists, from the spaces and folders the entry names", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index} late write`);
    // The document's own delete swept first; these rows and this part were written behind it.
    await sql`delete from documents where id = 'a'`;
    await sql`delete from document_cleanup_queue`;
    const store = objectStore(["u1/run-1/summary-tree/a/parts/late.jsonl"]);
    await enqueueSummaryTreeCleanup(sql, { scope: W, documentId: "a", reason: "document_gone", spaces: [space], artifactRoots: ["u1/run-1/summary-tree/a"] });
    expect(await drainStorageCleanupQueue(sql, store, options())).toEqual({ purged: 1, failed: 0 });
    expect(await summaryDocuments(W)).toEqual([]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect([...store.objects]).toEqual([]);
  });

  it("never leaves a tree ready over removed rows, and keeps the entry until the strict delete succeeds", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index}`);
    await enqueueSummaryTreeCleanup(sql, { scope: W, documentId: "a", reason: "pii_blocked" });
    let fail = true;
    const calls: Array<{ table: string; purgeHistory?: boolean }> = [];
    const flaky: DeleteVectorRows = async (args) => {
      calls.push({ table: args.table, ...(args.purgeHistory ? { purgeHistory: true } : {}) });
      if (fail) throw new Error("history prune failed");
      return await deleteLanceDbDocumentRows(args);
    };
    expect(await drainStorageCleanupQueue(sql, storage, options({ deleteVectorRows: flaky }))).toEqual({ purged: 0, failed: 1 });
    expect(calls).toEqual([{ table: LANCEDB_SUMMARIES_TABLE, purgeHistory: true }]);
    expect(await sql`select attempts, last_error from storage_cleanup_queue`).toEqual([{ attempts: 1, last_error: "history prune failed" }]);
    // Nothing was committed: the tree is as it was.
    expect(await sql`select status from document_summary_trees where document_id = 'a'`).toEqual([{ status: "ready" }]);
    // Asking again makes the entry due at once with its attempts reset.
    await enqueueSummaryTreeCleanup(sql, { scope: W, documentId: "a", reason: "pii_blocked" });
    expect(await sql`select attempts, last_error from storage_cleanup_queue`).toEqual([{ attempts: 0, last_error: null }]);
    fail = false;
    expect(await drainStorageCleanupQueue(sql, storage, options({ deleteVectorRows: flaky }))).toEqual({ purged: 1, failed: 0 });
    expect(await summaryDocuments(W)).toEqual([]);
    expect(await sql`select status, error, built_at, build_owner from document_summary_trees where document_id = 'a'`)
      .toEqual([{ status: "partial", error: "rows-removed", built_at: null, build_owner: null }]);
    expect(await registry("a")).toEqual({ trees: 1, nodes: 0 });
  });

  it("refuses an entry that names another tenant's document, a folder that is not the document's, or a malformed target", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `KEEPME-a-${index}`);
    await seedDocument("x1", X);
    await seedTree("x1", X, (index) => `KEEPME-x-${index}`);
    const store = objectStore(["u1/run-1/summary-tree/a/summaries.jsonl", "u1/run-1/embeddings/a.json", "u2/run-1/summary-tree/x1/summaries.jsonl"]);
    await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason) values
      ('summary_tree_document', 'o1', 'o1|w|x1', ${sql.json({ projectId: "w", documentId: "x1", spaces: [{ embeddingModel: MODEL, dimension: DIM }] })}, 'test'),
      ('summary_tree_document', 'o1', 'o1|w|a', ${sql.json({ projectId: "w", documentId: "a", artifactRoots: ["u1/run-1/embeddings"] })}, 'test'),
      ('summary_tree_document', 'o1', 'o1|w|../a', ${sql.json({ projectId: "w", documentId: "../a" })}, 'test'),
      ('summary_tree_document', 'o1', 'o1|w2|a', ${sql.json({ projectId: "w", documentId: "a" })}, 'test')`;
    expect(await drainStorageCleanupQueue(sql, store, options())).toEqual({ purged: 0, failed: 4 });
    expect(await summaryDocuments(W)).toEqual(["a"]);
    expect(await summaryDocuments(X)).toEqual(["x1"]);
    expect(store.objects.size).toBe(3);
    expect(await registry("a")).toEqual({ trees: 1, nodes: 6 });
    expect(await registry("x1")).toEqual({ trees: 1, nodes: 6 });
  });

  it("withdraws the tree of a document the PII policy blocks or redacts, and leaves a document without a tree alone", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index} written before the policy`);
    await seedDocument("b", W);
    await seedTree("b", W, (index) => `KEEPME-b-${index}`);
    await seedDocument("c", W);
    // First ingestion: no tree yet, nothing to withdraw, and nothing queued that could disturb the build to come.
    expect(await withdrawSummaryTreeForPii(sql, "c")).toBe(false);
    expect(await withdrawSummaryTreeForPii(sql, "missing")).toBe(false);
    expect(await sql`select 1 from storage_cleanup_queue`).toEqual([]);

    expect(await withdrawSummaryTreeForPii(sql, "a")).toBe(true);
    // Not served from this moment, before any sweep.
    expect(await sql`select status, error, built_at from document_summary_trees where document_id = 'a'`).toEqual([{ status: "partial", error: "pii-withheld", built_at: null }]);
    expect(await sql`select kind, target, reason from storage_cleanup_queue`).toEqual([{ kind: "summary_tree_document", target: "o1|w|a", reason: "pii_withheld" }]);
    expect(await drainStorageCleanupQueue(sql, storage, options())).toEqual({ purged: 1, failed: 0 });
    expect(await summaryDocuments(W)).toEqual(["b"]);
    expect(await filesContaining("ERASEME-")).toEqual([]);
    expect(await registry("a")).toEqual({ trees: 1, nodes: 0 });
    expect(await registry("b")).toEqual({ trees: 1, nodes: 6 });
  });

  it("says once, at error level, when a cleanup row reaches its attempt limit and will not be retried", async () => {
    await seedDocument("a", W);
    await seedTree("a", W, (index) => `ERASEME-${index}`);
    await seedDocument("d", W);
    await seedTree("d", W, (index) => `ERASEME-d-${index}`);
    // A queued removal of a live document's tree, and a deleted document's own cleanup: both strict deletes keep failing.
    await enqueueSummaryTreeCleanup(sql, { scope: W, documentId: "a", reason: "document_corrected" });
    await sql`delete from documents where id = 'd'`;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: DeleteVectorRows = async () => { throw new Error("history prune failed for s3://bucket/secret-path"); };
    const limitLines = () => errors.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("status=attempt-limit-reached"));
    for (let attempt = 1; attempt <= 9; attempt++) {
      await drainStorageCleanupQueue(sql, storage, options({ deleteVectorRows: failing }));
      await drainDocumentCleanupQueue(sql, storage, options({ deleteVectorRows: failing }));
    }
    expect(limitLines()).toEqual([]);
    await drainStorageCleanupQueue(sql, storage, options({ deleteVectorRows: failing }));
    await drainDocumentCleanupQueue(sql, storage, options({ deleteVectorRows: failing }));
    const [queued] = await sql<{ id: string }[]>`select id::text from storage_cleanup_queue`;
    expect(limitLines().sort()).toEqual([
      "[cleanup] status=attempt-limit-reached queue=document_cleanup_queue id=d org=o1 attempts=10 action=manual-reconciliation-required",
      `[cleanup] status=attempt-limit-reached queue=storage_cleanup_queue id=${queued!.id} kind=summary_tree_document org=o1 attempts=10 action=manual-reconciliation-required`,
    ]);
    // Stable and free of the failure's own text.
    expect(limitLines().join(" ")).not.toContain("secret-path");
    // The rows stay (the data is still there) and are not claimed again: nothing more is logged.
    await drainStorageCleanupQueue(sql, storage, options({ deleteVectorRows: failing }));
    await drainDocumentCleanupQueue(sql, storage, options({ deleteVectorRows: failing }));
    expect(limitLines()).toHaveLength(2);
    expect(await sql`select attempts from storage_cleanup_queue`).toEqual([{ attempts: 10 }]);
    expect(await sql`select attempts from document_cleanup_queue`).toEqual([{ attempts: 10 }]);
    expect(await summaryDocuments(W)).toEqual(["a", "d"]);
  });
});
