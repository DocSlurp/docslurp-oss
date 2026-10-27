import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { decodeLanceChunkHydration, encodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { legacyEmbeddingLocations, legacyOrgTable } from "../stages/lancedb-legacy-layout.js";
import { relocateAllOrgVectors, relocateOrgVectors } from "../stages/lancedb-relocate.js";

/**
 * Moving org-level LanceDB tables into per-workspace databases against
 * migrated Postgres and real local LanceDB: rows follow their document's
 * workspace, same-workspace dedup copies keep reading their source's rows, a
 * copy in another workspace gets its own rebound rows, orphans stay behind,
 * reruns converge and --drop-legacy removes the old tables.
 */
const MODEL = "provider/model.v1";
const DIM = 4;

let lanceDir: string;
let sql: postgres.Sql;
let stop: () => Promise<void>;

const vector = (seed: number) => Array.from({ length: DIM }, (_, k) => Math.sin(seed * 7 + k));
const row = (id: string, documentId: string, chunkIndex: number, seed: number, runId = "run-1") => ({
  id, documentId, chunkIndex, text: `text ${id}`, vector: vector(seed),
  metadata: { documentId, sourceKey: "k", filename: "f.pdf" },
  runId, pageNumber: 1,
  hydration: encodeLanceChunkHydration({ runId, headingPath: ["H"], pageNumber: 1, tokenEstimate: 3, metadata: { documentId } }),
});

async function createTable(uri: string, table: string, rows: Array<Record<string, unknown>>) {
  const db = await connect(uri);
  (await db.createTable(table, rows)).close();
  db.close();
}

async function readRows(uri: string, table = "chunks") {
  const db = await connect(uri);
  try {
    if (!(await db.tableNames()).includes(table)) return null;
    const opened = await db.openTable(table);
    try {
      const rows = await opened.query().select(["id", "documentId", "runId", "hydration"]).toArray() as Array<{ id: string; documentId: string; runId: string | null; hydration: string | null }>;
      return rows.map((entry) => ({ id: entry.id, documentId: entry.documentId, runId: entry.runId, hydration: entry.hydration }))
        .sort((a, b) => a.id.localeCompare(b.id));
    } finally { opened.close(); }
  } finally { db.close(); }
}

async function texts(uri: string) {
  const db = await connect(uri);
  try {
    const table = await db.openTable("chunks");
    try {
      const rows = await table.query().select(["id", "text"]).toArray() as Array<{ id: string; text: string }>;
      return Object.fromEntries(rows.map((entry) => [entry.id, entry.text]).sort());
    } finally { table.close(); }
  } finally { db.close(); }
}

const workspaceUri = (workspaceId: string) => VectorNamespaceManager.getEmbeddingLocation(lanceDir, "org1", workspaceId, MODEL, DIM).uri;

beforeAll(async () => {
  lanceDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "lance-relocate-"));
  vi.stubEnv("LANCEDB_URI", lanceDir);
  vi.stubEnv("LANCEDB_FTS_INDEX", "0");
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'relocate@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'relocate', 'u')`;
  for (const workspace of ["w1", "w2"]) {
    await sql`insert into workspaces (id, org_id, user_id, name) values (${workspace}, 'org1', 'u', ${workspace})`;
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values (${`run-${workspace}`}, 'org1', 'u', ${workspace}, 'bulk-upload', 'completed', 'completed', '{}')`;
  }
  const documents = [
    { id: "a", workspace: "w1", dedupedFrom: null },
    { id: "b", workspace: "w2", dedupedFrom: null },
    { id: "same-copy", workspace: "w1", dedupedFrom: "a" },
    { id: "cross-copy", workspace: "w2", dedupedFrom: "a" },
  ];
  for (const document of documents) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, deduped_from_document_id)
      values (${document.id}, 'org1', 'u', ${document.workspace}, ${`run-${document.workspace}`}, 'f.pdf', 'application/pdf', 'k', 'completed', ${document.dedupedFrom})`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`vi-${document.id}`}, ${document.id}, 'lancedb', 'b', 'p', ${MODEL}, ${DIM})`;
  }
  // Current chunks. The cross-workspace copy was seeded with random chunk ids and has no chunk 1;
  // a-002 was replaced by a reprocess (its legacy row is stale).
  for (const [id, documentId, runId, index] of [
    ["a-000", "a", "run-w1", 0], ["a-001", "a", "run-w1", 1], ["b-000", "b", "run-w2", 0], ["b-old", "b", "run-w2", 5],
    ["cross-uuid-0", "cross-copy", "run-w2", 0],
  ] as const) {
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
      values (${id}, ${documentId}, ${runId}, 'u', ${index}, 'text')`;
  }
  await sql`update documents set source_key = 'copy-key', filename = 'copy.pdf' where id = 'cross-copy'`;

  const [embedding] = legacyEmbeddingLocations(lanceDir, "org1", MODEL, DIM);
  await createTable(embedding!.uri, embedding!.table, [
    row("a-000", "a", 0, 1), row("a-001", "a", 1, 2), row("a-002", "a", 2, 9), row("b-000", "b", 0, 3), row("gone-000", "gone", 0, 4),
  ]);
  // The org-wide table is the oldest layout: its stale copy of a-000 must not win.
  const org = legacyOrgTable(lanceDir, "org1");
  await createTable(org.uri, org.table, [{ ...row("b-old", "b", 5, 5), chunkIndex: null }, { ...row("a-000", "a", 0, 1), text: "older a-000" }]);
  // Written by the worker after the upgrade: relocation never replaces it.
  await createTable(workspaceUri("w2"), "chunks", [{ ...row("b-000", "b", 0, 3, "run-new"), text: "reindexed" }]);
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
  await rm(lanceDir, { recursive: true, force: true });
});

describe("lancedb relocate", () => {
  it("changes nothing on a dry run", async () => {
    const result = await relocateOrgVectors({ sql, orgId: "org1", dryRun: true, log: () => {} });
    expect(result).toMatchObject({ orphanRows: 1, staleRows: 1, unmatchedCopyRows: 1, skippedExisting: 3, errors: [], droppedLegacy: [] });
    expect(result.sources.map((source) => [source.rows, source.read])).toEqual([[5, 5], [2, 2]]);
    expect(await readRows(workspaceUri("w1"))).toBeNull();
  }, 60_000);

  it("moves every row into the workspace databases that read it, then converges on a rerun", async () => {
    const result = await relocateOrgVectors({ sql, orgId: "org1", log: () => {} });
    expect(result.errors).toEqual([]);
    expect(await readRows(workspaceUri("w1"))).toEqual([
      expect.objectContaining({ id: "a-000", documentId: "a", runId: "run-1" }),
      expect.objectContaining({ id: "a-001", documentId: "a" }),
    ]);
    const w2 = await readRows(workspaceUri("w2"));
    expect(w2!.map((entry) => [entry.id, entry.documentId])).toEqual([
      ["b-000", "b"], ["b-old", "b"], ["cross-uuid-0", "cross-copy"],
    ]);
    expect(w2!.find((entry) => entry.id === "b-000")!.runId).toBe("run-new");
    const copy = w2!.find((entry) => entry.id === "cross-uuid-0")!;
    expect(copy.runId).toBe("run-w2");
    expect(decodeLanceChunkHydration(copy.hydration)).toMatchObject({ runId: "run-w2", metadata: { documentId: "cross-copy" } });
    expect(await texts(workspaceUri("w1"))).toEqual({ "a-000": "text a-000", "a-001": "text a-001" });
    expect((await texts(workspaceUri("w2")))["cross-uuid-0"]).toBe("text a-000");

    const again = await relocateOrgVectors({ sql, orgId: "org1", log: () => {} });
    expect(again.errors).toEqual([]);
    expect(again.written).toEqual([]);
    expect((await readRows(workspaceUri("w2")))!.map((entry) => entry.id)).toEqual(w2!.map((entry) => entry.id));
  }, 120_000);

  it("registers maintained tables for the sweep, and --maintain-all also maintains already-relocated ones", async () => {
    const keys = async () => (await sql<{ table_key: string; lance_uri: string }[]>`select table_key, lance_uri from vector_index_tables order by 1`)
      .map((entry) => entry.lance_uri);
    expect(await keys()).toEqual([workspaceUri("w1"), workspaceUri("w2")].sort());
    await sql`delete from vector_index_tables`;
    const quiet = await relocateOrgVectors({ sql, orgId: "org1", log: () => {} });
    expect(quiet.maintained).toEqual([]);
    const all = await relocateOrgVectors({ sql, orgId: "org1", maintainAll: true, log: () => {} });
    expect(all.errors).toEqual([]);
    expect(all.maintained.map((entry) => entry.uri).sort()).toEqual([workspaceUri("w1"), workspaceUri("w2")].sort());
    expect(await keys()).toEqual([workspaceUri("w1"), workspaceUri("w2")].sort());
  }, 120_000);

  it("drops the legacy tables only with --drop-legacy, after a clean run", async () => {
    const results = await relocateAllOrgVectors({ sql, dropLegacy: true, log: () => {} });
    expect(results).toHaveLength(1);
    expect(results[0]!.droppedLegacy).toHaveLength(2);
    const [embedding] = legacyEmbeddingLocations(lanceDir, "org1", MODEL, DIM);
    expect(await readRows(embedding!.uri, embedding!.table)).toBeNull();
    expect(await readRows(lanceDir, legacyOrgTable(lanceDir, "org1").table)).toBeNull();
    expect((await readRows(workspaceUri("w1")))!.map((entry) => entry.id)).toEqual(["a-000", "a-001"]);
  }, 120_000);

  it("points pending vector writes queued with the org-level layout at the workspace database", async () => {
    const migration = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)),
      "../../../server/db/migrations/0082_workspace_vector_databases.sql"), "utf8");
    const rewrite = migration.split("--> statement-breakpoint").find((statement) => statement.includes("UPDATE vector_index_outbox"))!;
    const oldUri = `${lanceDir}/org1/vectors/provider%2Fmodel%2Ev1/4`;
    await sql`insert into vector_index_outbox (table_key, lance_uri, lance_table, org_id, document_id, run_id, artifact_key, metadata, record_count)
      values (${`${oldUri}#chunks`}, ${oldUri}, 'chunks', 'org1', 'b', 'run-w2', 'k', '{}', 1)`;
    await sql.unsafe(rewrite);
    const newUri = `${lanceDir}/org1/w2/vectors-provider%2Fmodel%2Ev1-4`;
    expect(newUri).toBe(workspaceUri("w2"));
    expect(await sql`select lance_uri, table_key from vector_index_outbox where document_id = 'b'`)
      .toEqual([{ lance_uri: newUri, table_key: `${newUri}#chunks` }]);
  }, 60_000);
});
