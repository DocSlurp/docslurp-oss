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
 * The native-search backfill against migrated Postgres and real local
 * per-workspace LanceDB databases that predate the hydration columns: it fills
 * only the selected workspace's database, is idempotent, leaves no rewritten
 * row outside the vector index, and tolerates an ingest write landing while it
 * runs.
 */
const MODEL = "test-model";
const DIM = 8;
const DOCS = 4;
const CHUNKS = 80;

let lanceDir: string;
let sql: postgres.Sql;
let stop: () => Promise<void>;

const vector = (seed: number) => Array.from({ length: DIM }, (_, k) => Math.sin(seed * 13 + k));
const location = (workspaceId = "w") => VectorNamespaceManager.getEmbeddingLocation(lanceDir, "org1", workspaceId, MODEL, DIM);

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
  const rows: Record<string, Array<Record<string, unknown>>> = { w: [], other: [] };
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
      rows[workspace]!.push({ id, documentId, chunkIndex: c, text: `pump seal ${c}`, vector: vector(d * CHUNKS + c), metadata: { documentId, sourceKey: "k", filename: "f" } });
    }
  }
  for (const [workspace, workspaceRows] of Object.entries(rows)) {
    const db = await connect(location(workspace).uri);
    const table = await db.createTable(location(workspace).table, workspaceRows);
    await table.createIndex("vector", { config: Index.hnswSq({ distanceType: "l2", numPartitions: 1 }) });
    table.close();
    db.close();
  }
}, 180_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
  vi.unstubAllEnvs();
  await rm(lanceDir, { recursive: true, force: true });
});

async function readTable(workspaceId = "w") {
  const db = await connect(location(workspaceId).uri);
  const table = await db.openTable(location(workspaceId).table);
  try {
    // A database not backfilled yet has no hydration columns: those read as undefined.
    const present = new Set((await table.schema()).fields.map((field) => field.name));
    const columns = ["id", "runId", "pageNumber", "hydration"].filter((name) => present.has(name));
    const rows = await table.query().select(columns).limit(100_000).toArray() as Array<{ id: string; runId?: string | null; pageNumber?: number | null; hydration?: string | null }>;
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
  it("fills the workspace's database only, keeps its rows in the vector index and is idempotent", async () => {
    const lines: string[] = [];
    const results = await backfillWorkspaceLanceHydration({ sql, workspaceId: "w", batchDocs: 3, log: (line) => lines.push(line) });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ workspaceId: "w", uri: location().uri, chunkRows: DOCS * CHUNKS, ftsBuilt: true, optimized: true, rowsWithoutHydration: 0 });
    const after = await readTable();
    expect(decodeLanceChunkHydration(after.rows.get("w-doc1-7")!.hydration)).toEqual({
      v: 1, runId: "run-w", headingPath: ["Intro"], pageNumber: 3, tokenEstimate: 9, metadata: { blockIds: ["b-w-doc1-7"] },
    });
    expect(after.rows.get("w-doc1-7")!.pageNumber).toBe(3);
    expect(after.rows.has(`other-doc${DOCS}-0`)).toBe(false);
    // Another workspace's database is untouched.
    expect((await readTable("other")).rows.get(`other-doc${DOCS}-0`)!.hydration).toBeUndefined();
    // Without the optimize, every rewritten row would be flat-scanned by vector search.
    expect(after.stats).toMatchObject({ numUnindexedRows: 0 });
    expect(after.indices.some((index) => index.columns.includes("text"))).toBe(true);

    const [second] = await backfillWorkspaceLanceHydration({ sql, workspaceId: "w", batchDocs: 3, log: () => {} });
    expect(second).toMatchObject({ chunkRows: DOCS * CHUNKS, ftsBuilt: false, rowsWithoutHydration: 0 });
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
    const before = await readTable("other");
    const [result] = await backfillWorkspaceLanceHydration({ sql, workspaceId: "other", dryRun: true, log: () => {} });
    expect(result).toMatchObject({ workspaceId: "other", chunkRows: CHUNKS, optimized: false, rowsWithoutHydration: null });
    const after = await readTable("other");
    expect(after.rows.get(`other-doc${DOCS}-0`)!.hydration).toBeUndefined();
    expect(after.rows.size).toBe(before.rows.size);
  }, 60_000);
  it("--org and --all cover every workspace database of the org, once each", async () => {
    const lines: string[] = [];
    const results = await backfillOrgLanceHydration({ sql, orgId: "org1", log: (line) => lines.push(line) });
    expect(results.map((result) => result.workspaceId).sort()).toEqual(["other", "w"]);
    expect(results.find((result) => result.workspaceId === "other")).toMatchObject({
      uri: location("other").uri, chunkRows: CHUNKS, ftsBuilt: true, optimized: true, rowsWithoutHydration: 0,
    });
    expect(lines.filter((line) => line.startsWith("[backfill] table=") && line.includes("documents="))).toHaveLength(2);
    const { rows } = await readTable("other");
    expect(decodeLanceChunkHydration(rows.get(`other-doc${DOCS}-3`)!.hydration)?.runId).toBe("run-other");

    const all = await backfillAllLanceHydration({ sql, log: () => {} });
    expect(all.filter((result) => !result.skipped)).toHaveLength(2);
    expect(all.every((result) => !result.error)).toBe(true);
  }, 120_000);

  it("leaves chunks of pages materialized on demand unhydrated (search serves them through a committed chunk row)", async () => {
    const id = "w-doc0:p9:gabc123abc123:c0";
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values (${id}, 'w-doc0', 'run-w', 'u', 8000, 'deferred page', ${[]}, 9, 3, ${sql.json({ pageNumber: 9, materializedBy: "query", deferred: true })})`;
    await writeLanceDbRecords(location().uri, location().table, [{ id, documentId: "w-doc0", chunkIndex: 8000, text: "deferred page", vector: vector(7_777), metadata: { documentId: "w-doc0" } }]);
    const [result] = await backfillWorkspaceLanceHydration({ sql, workspaceId: "w", batchDocs: 10, log: () => {} });
    expect(result!.rowsWithoutHydration).toBe(1);
    const { rows } = await readTable();
    expect(rows.get(id)!.hydration ?? null).toBeNull();
    expect(decodeLanceChunkHydration(rows.get("w-doc0-0")!.hydration)?.runId).toBe("run-w");
  }, 120_000);
});
