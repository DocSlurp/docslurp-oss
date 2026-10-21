import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connect, Index } from "@lancedb/lancedb";
import { VectorNamespaceManager } from "@docslurp/shared";
import { decodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "../test/migrated-postgres.js";
import { buildVectorRecords } from "../stages/index-vectors.js";
import { backfillAllLanceHydration, backfillOrgLanceHydration, backfillWorkspaceLanceHydration } from "../stages/lancedb-native-backfill.js";
import { writeLanceDbRecords } from "../stages/lancedb-writer.js";

/**
 * The native-search backfill against migrated Postgres and a real local
 * LanceDB table that predates the hydration columns: it fills only the
 * workspace's rows, is idempotent, leaves no rewritten row outside the vector
 * index, and tolerates an ingest write landing while it runs.
 */
const MODEL = "test-model";
const DIM = 8;
const DOCS = 4;
const CHUNKS = 80;

let lanceDir: string;
let sql: postgres.Sql;
let stop: () => Promise<void>;

const vector = (seed: number) => Array.from({ length: DIM }, (_, k) => Math.sin(seed * 13 + k));
const location = () => VectorNamespaceManager.getEmbeddingLocation(lanceDir, "org1", MODEL, DIM);

beforeAll(async () => {
  lanceDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "lance-native-backfill-"));
  vi.stubEnv("LANCEDB_URI", lanceDir);
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'backfill@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'backfill', 'u')`;
  for (const workspace of ["w", "other"]) {
    await sql`insert into workspaces (id, org_id, user_id, name) values (${workspace}, 'org1', 'u', ${workspace})`;
    await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values (${`run-${workspace}`}, 'org1', 'u', ${workspace}, 'bulk-upload', 'completed', 'completed', '{}')`;
  }
  // Rows written by the previous release: no hydration columns at all.
  const rows: Array<Record<string, unknown>> = [];
  for (let d = 0; d < DOCS + 1; d += 1) {
    const workspace = d === DOCS ? "other" : "w";
    const documentId = `${workspace}-doc${d}`;
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values (${documentId}, 'org1', 'u', ${workspace}, ${`run-${workspace}`}, ${`${documentId}.pdf`}, 'application/pdf', ${`k-${documentId}`}, 'completed')`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`vi-${documentId}`}, ${documentId}, 'lancedb', 'b', 'p', ${MODEL}, ${DIM})`;
    for (let c = 0; c < CHUNKS; c += 1) {
      const id = `${documentId}-${c}`;
      await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
        values (${id}, ${documentId}, ${`run-${workspace}`}, 'u', ${c}, ${`pump seal ${c}`}, ${["Intro"]}, ${1 + (c % 5)}, 9, ${sql.json({ blockIds: [`b-${id}`] })})`;
      rows.push({ id, documentId, chunkIndex: c, text: `pump seal ${c}`, vector: vector(d * CHUNKS + c), metadata: { documentId, sourceKey: "k", filename: "f" } });
    }
  }
  const db = await connect(location().uri);
  const table = await db.createTable(location().table, rows);
  await table.createIndex("vector", { config: Index.hnswSq({ distanceType: "l2" }) });
  table.close();
  db.close();
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
  await rm(lanceDir, { recursive: true, force: true });
});

async function readTable() {
  const db = await connect(location().uri);
  const table = await db.openTable(location().table);
  try {
    const rows = await table.query().select(["id", "runId", "pageNumber", "hydration"]).limit(100_000).toArray() as Array<{ id: string; runId: string | null; pageNumber: number | null; hydration: string | null }>;
    const indices = await table.listIndices();
    const vectorIndex = indices.find((index) => index.columns.includes("vector"))!;
    const stats = await table.indexStats(vectorIndex.name);
    return { rows: new Map(rows.map((row) => [row.id, row])), indices, stats };
  } finally {
    table.close();
    db.close();
  }
}

describe("lancedb native backfill", () => {
  it("fills the workspace's rows only, keeps them in the vector index and is idempotent", async () => {
    const lines: string[] = [];
    const [first] = await backfillWorkspaceLanceHydration({ sql, workspaceId: "w", batchDocs: 3, log: (line) => lines.push(line) });
    expect(first).toMatchObject({ chunkRows: DOCS * CHUNKS, ftsBuilt: true, optimized: true, rowsWithoutHydration: CHUNKS });
    const after = await readTable();
    expect(decodeLanceChunkHydration(after.rows.get("w-doc1-7")!.hydration)).toEqual({
      v: 1, runId: "run-w", headingPath: ["Intro"], pageNumber: 3, tokenEstimate: 9, metadata: { blockIds: ["b-w-doc1-7"] },
    });
    expect(after.rows.get("w-doc1-7")!.pageNumber).toBe(3);
    // Another workspace of the same org table is untouched.
    expect(after.rows.get(`other-doc${DOCS}-0`)!.hydration).toBeNull();
    // Without the optimize, every rewritten row would be flat-scanned by vector search.
    expect(after.stats).toMatchObject({ numUnindexedRows: 0 });
    expect(after.indices.some((index) => index.columns.includes("text"))).toBe(true);

    const [second] = await backfillWorkspaceLanceHydration({ sql, workspaceId: "w", batchDocs: 3, log: () => {} });
    expect(second).toMatchObject({ chunkRows: DOCS * CHUNKS, ftsBuilt: false, rowsWithoutHydration: CHUNKS });
    const again = await readTable();
    expect(again.rows.size).toBe(after.rows.size);
    expect(again.rows.get("w-doc1-7")!.hydration).toBe(after.rows.get("w-doc1-7")!.hydration);
    expect(again.stats).toMatchObject({ numUnindexedRows: 0 });
  }, 120_000);

  it("tolerates an ingest write while it runs", async () => {
    const artifact = { chunks: [0, 1].map((index) => ({ id: `fresh-${index}`, index, text: `fresh ${index}`, tokenEstimate: 3, vector: vector(9_000 + index), headingPath: [], pageNumber: 2, metadata: {} })) };
    await Promise.all([
      backfillWorkspaceLanceHydration({ sql, workspaceId: "w", batchDocs: 1, log: () => {} }),
      writeLanceDbRecords(location().uri, location().table, buildVectorRecords(artifact, "w-fresh", { filename: "fresh.pdf" }, "run-w")),
    ]);
    const { rows } = await readTable();
    expect(decodeLanceChunkHydration(rows.get("fresh-0")!.hydration)?.runId).toBe("run-w");
    expect(decodeLanceChunkHydration(rows.get("w-doc0-0")!.hydration)?.runId).toBe("run-w");
  }, 120_000);

  it("changes nothing on a dry run", async () => {
    const before = await readTable();
    const [result] = await backfillWorkspaceLanceHydration({ sql, workspaceId: "other", dryRun: true, log: () => {} });
    expect(result).toMatchObject({ chunkRows: CHUNKS, optimized: false, rowsWithoutHydration: null });
    const after = await readTable();
    expect(after.rows.get(`other-doc${DOCS}-0`)!.hydration).toBeNull();
    expect(after.rows.size).toBe(before.rows.size);
  }, 60_000);
  it("--org and --all also cover the legacy chunks_org table, once per table", async () => {
    // A legacy table holding one document's rows, written before hydration columns existed.
    const db = await connect(lanceDir);
    const legacyName = VectorNamespaceManager.getTableName("org1");
    const legacyRows = Array.from({ length: 5 }, (_, c) => ({ id: `w-doc0-${c}`, documentId: "w-doc0", text: `pump seal ${c}`, vector: vector(c), metadata: { documentId: "w-doc0" } }));
    const legacy = await db.createTable(legacyName, legacyRows);
    legacy.close();
    try {
      const lines: string[] = [];
      const results = await backfillOrgLanceHydration({ sql, orgId: "org1", log: (line) => lines.push(line) });
      const byKind = Object.fromEntries(results.map((result) => [result.kind, result]));
      expect(byKind.embedding).toMatchObject({ chunkRows: (DOCS + 1) * CHUNKS, rowsWithoutHydration: 0, ftsPresent: true });
      expect(byKind["root-embedding"]).toMatchObject({ skipped: "missing" });
      expect(byKind.legacy).toMatchObject({ ftsBuilt: true, ftsPresent: true, optimized: true, rowsWithoutHydration: 0 });
      // Both workspaces of the org, and each table once.
      expect(lines.filter((line) => line.startsWith("[backfill] table=") && line.includes("kind=embedding"))).toHaveLength(1);
      const reopened = await db.openTable(legacyName);
      const [row] = await reopened.query().where("id = 'w-doc0-3'").select(["hydration"]).toArray() as Array<{ hydration: string }>;
      expect(decodeLanceChunkHydration(row!.hydration)?.runId).toBe("run-w");
      reopened.close();

      const all = await backfillAllLanceHydration({ sql, log: () => {} });
      expect(all.filter((result) => !result.skipped).map((result) => result.kind).sort()).toEqual(["embedding", "legacy"]);
      expect(all.every((result) => !result.error)).toBe(true);
    } finally {
      await db.dropTable(legacyName);
      db.close();
    }
  }, 120_000);
});
