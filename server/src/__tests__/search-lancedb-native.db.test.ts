import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { normalizePipelineFeatures, resolveEmbeddingRoute, VectorNamespaceManager } from "@docslurp/shared";
import { encodeLanceChunkHydration, LANCE_HYDRATION_COLUMN_SPECS } from "@docslurp/shared/lancedb-hydration";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * SEARCH_LANCEDB_NATIVE against migrated Postgres and a real local LanceDB
 * table: native retrieval returns the same citations as the Postgres path
 * (hydration from LanceDB columns, Postgres only for rows without them and
 * for dedup copies), keyword search is BM25 top-k over the whole scope, a
 * warm search runs at most one SQL statement before it answers, and tables
 * without an FTS index fall back to Postgres FTS.
 */
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));

const statements: string[] = [];
let sql: postgres.Sql;
let stop: () => Promise<void>;
let lanceDir: string;
let search: typeof import("../services/search.js");
let eligible: typeof import("../search/eligible-documents.js");
let lance: typeof import("../search/lancedb.js");
let session: typeof import("../search/session.js");

const route = resolveEmbeddingRoute(normalizePipelineFeatures(null).embedding);
const DIM = route.dimensions;
const DOCS = 6;
const CHUNKS = 12;
const WORDS = ["pump", "valve", "seal", "torque", "bearing", "gasket", "filter", "impeller", "coupling", "flange", "rotor", "shaft"];

let seed = 7;
function rand(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function unit(vector: number[]): number[] {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}
const vectors = new Map<string, number[]>();

type ChunkSeed = { id: string; documentId: string; index: number; text: string; page: number; headingPath: string[]; metadata: Record<string, unknown> };
const chunks: ChunkSeed[] = [];

async function writeLanceTable(options: { hydrated: boolean; fts: boolean }): Promise<void> {
  const location = VectorNamespaceManager.getEmbeddingLocation(lanceDir, "org1", route.model, DIM);
  const db = await lancedb.connect(location.uri);
  if ((await db.tableNames()).includes(location.table)) await db.dropTable(location.table);
  const rows = chunks.map((chunk) => ({
    id: chunk.id, documentId: chunk.documentId, chunkIndex: chunk.index, text: chunk.text, vector: vectors.get(chunk.id)!,
    metadata: { documentId: chunk.documentId, sourceKey: "k", filename: `${chunk.documentId}.pdf` },
    ...(options.hydrated ? {
      runId: "run1", pageNumber: chunk.page,
      hydration: encodeLanceChunkHydration({ runId: "run1", headingPath: chunk.headingPath, pageNumber: chunk.page, tokenEstimate: 12, metadata: chunk.metadata }),
    } : {}),
  }));
  const table = await db.createTable(location.table, rows);
  // An evolved, not yet backfilled table: the columns exist but hold nulls.
  if (!options.hydrated) await table.addColumns(LANCE_HYDRATION_COLUMN_SPECS.map((column) => ({ ...column })));
  if (options.fts) await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: false }) });
  table.close();
  db.close();
  lance.resetLanceDbConnectionForTests();
}

beforeAll(async () => {
  lanceDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "docslurp-native-search-"));
  vi.stubEnv("LANCEDB_URI", lanceDir);
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {}, debug: (_connection, query) => { statements.push(query); } });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'native@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'native', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org1', 'u', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name) values ('w', 'org1', 'u', 'Native')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('run1', 'org1', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  for (let d = 1; d <= DOCS; d += 1) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values (${`doc${d}`}, 'org1', 'u', 'w', 'run1', ${`doc${d}.pdf`}, 'application/pdf', ${`k${d}`}, 'completed')`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`vi${d}`}, ${`doc${d}`}, 'lancedb', 'b', 'p', ${route.model}, ${DIM})`;
    for (let c = 0; c < CHUNKS; c += 1) {
      const words = Array.from({ length: 30 }, () => WORDS[Math.floor(rand() * WORDS.length)]);
      // One planted passage the keyword tests look for.
      if (d === 4 && c === 9) words.push("cavitation", "cavitation", "erosion");
      const id = `doc${d}-${c}`;
      const chunk = { id, documentId: `doc${d}`, index: c, text: words.join(" "), page: 1 + Math.floor(c / 3),
        headingPath: [`Section ${d}`, `Part ${c % 3}`],
        metadata: { pageNumbers: [1 + Math.floor(c / 3)], blockIds: [`b-${id}`], blockTypes: ["paragraph"], evidenceType: "paragraph",
          locator: { kind: "page", pageNumber: 1 + Math.floor(c / 3), charStart: null, charEnd: null, boxes: [] } } };
      chunks.push(chunk);
      vectors.set(id, unit(Array.from({ length: DIM }, () => rand() - 0.5)));
      await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
        values (${id}, ${`doc${d}`}, 'run1', 'u', ${c}, ${chunk.text}, ${chunk.headingPath}, ${chunk.page}, 12, ${sql.json(chunk.metadata)})`;
    }
  }
  // A dedup copy of doc2: chunks in Postgres only, vectors owned by doc2.
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, deduped_from_document_id)
    values ('copy2', 'org1', 'u', 'w', 'run1', 'copy2.pdf', 'application/pdf', 'kc', 'completed', 'doc2')`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values ('vic', 'copy2', 'lancedb', 'b', 'p', ${route.model}, ${DIM})`;
  for (const chunk of chunks.filter((item) => item.documentId === "doc2")) {
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values (${`copy2-${chunk.index}`}, 'copy2', 'run1', 'u', ${chunk.index}, ${chunk.text}, ${chunk.headingPath}, ${chunk.page}, 12, ${sql.json(chunk.metadata)})`;
  }
  search = await import("../services/search.js");
  eligible = await import("../search/eligible-documents.js");
  lance = await import("../search/lancedb.js");
  session = await import("../search/session.js");
  await writeLanceTable({ hydrated: true, fts: true });
}, 180_000);

afterEach(async () => {
  await session.drainSearchSessionWrites();
  vi.unstubAllEnvs();
  vi.stubEnv("LANCEDB_URI", lanceDir);
  eligible.resetEligibleDocumentCachesForTests();
});

afterAll(async () => {
  await sql?.end();
  await stop?.();
  lance?.resetLanceDbConnectionForTests();
  await rm(lanceDir, { recursive: true, force: true });
});

const baseOptions = {
  limit: 8, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false, parentRetrieval: false,
  useContextualCompression: false, useHyDE: false, stepback: false, iterativeMultiHop: false,
  enableGraphExpansion: false, enableCommunityExpansion: false,
};

function near(id: string): number[] {
  return unit(vectors.get(id)!.map((value) => value + (rand() - 0.5) * 0.002));
}

async function run(native: boolean, query: string, options: Record<string, unknown>) {
  vi.stubEnv("SEARCH_LANCEDB_NATIVE", native ? "1" : "0");
  const response = await search.hybridSearch(query, "u", { ...baseOptions, ...options, filters: { workspaceId: "w", ...(options.filters as object ?? {}) } });
  await session.drainSearchSessionWrites();
  return response;
}

const citations = (response: Awaited<ReturnType<typeof run>>) => response.results.map((result) => ({ text: result.text, citation: result.citation }));

describe("SEARCH_LANCEDB_NATIVE", () => {
  it("returns the Postgres path's citations for vector hits, hydrated from LanceDB", async () => {
    const queryVector = near("doc3-5");
    const legacy = await run(false, "qqqzzz", { queryVector });
    const native = await run(true, "qqqzzz", { queryVector });
    expect(legacy.results.length).toBeGreaterThan(0);
    expect(citations(native)).toEqual(citations(legacy));
    expect(native.results[0]!.citation.documentId).toBe("doc3");
    expect(native.timings?.nativeHydrationPostgres).toBeUndefined();
  });

  it("serves dedup copies through their owner's vectors with the copy's own chunks", async () => {
    const queryVector = near("doc2-4");
    const options = { queryVector, filters: { documentId: "copy2" } };
    const legacy = await run(false, "qqqzzz", options);
    const native = await run(true, "qqqzzz", options);
    expect(legacy.results[0]!.citation.documentId).toBe("copy2");
    expect(citations(native)).toEqual(citations(legacy));
  });

  it("ranks keyword hits with BM25 over the whole scope", async () => {
    const queryVector = near("doc1-0");
    const native = await run(true, "cavitation erosion", { queryVector });
    const legacy = await run(false, "cavitation erosion", { queryVector });
    const planted = (response: typeof native) => response.results.findIndex((result) => result.citation.documentId === "doc4" && result.citation.chunkIndex === 9);
    expect(planted(native)).toBeGreaterThanOrEqual(0);
    expect(planted(legacy)).toBeGreaterThanOrEqual(0);
    expect(native.timings?.nativeLexicalUnindexed).toBeUndefined();
  });

  it("answers a warm search with at most one SQL read", async () => {
    const queryVector = near("doc5-2");
    // Original documents only: hits serving a dedup copy are hydrated from Postgres by design.
    const filters = { documentIds: ["doc1", "doc2", "doc3", "doc4", "doc5", "doc6"] };
    await run(true, "torque bearing", { queryVector, filters });
    vi.stubEnv("SEARCH_LANCEDB_NATIVE", "1");
    statements.length = 0;
    const response = await search.hybridSearch("torque bearing", "u", { ...baseOptions, queryVector, filters: { workspaceId: "w", ...filters } });
    // Write-behind session and usage writes may already have started; they are not on the answer's path.
    const reads = statements.filter((statement) => !/^\s*(begin|commit|insert|delete|update|with recorded|savepoint|release)/i.test(statement));
    await session.drainSearchSessionWrites();
    expect(response.results.length).toBeGreaterThan(0);
    // The one: access, settings and pipeline (never cached).
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/from workspaces w/);
    expect(statements.some((statement) => /insert into search_sessions/.test(statement))).toBe(true);
  });

  it("hydrates rows without hydration columns from Postgres", async () => {
    await writeLanceTable({ hydrated: false, fts: true });
    try {
      const queryVector = near("doc6-7");
      const legacy = await run(false, "qqqzzz", { queryVector });
      const native = await run(true, "qqqzzz", { queryVector });
      expect(citations(native)).toEqual(citations(legacy));
      expect(native.timings?.nativeHydrationPostgres).toBe(1);
    } finally {
      await writeLanceTable({ hydrated: true, fts: true });
    }
  });

  it("falls back to Postgres FTS when the table has no FTS index", async () => {
    await writeLanceTable({ hydrated: true, fts: false });
    try {
      const queryVector = near("doc1-1");
      const legacy = await run(false, "cavitation erosion", { queryVector });
      const native = await run(true, "cavitation erosion", { queryVector });
      expect(native.timings?.nativeLexicalUnindexed).toBe(1);
      expect(citations(native)).toEqual(citations(legacy));
    } finally {
      await writeLanceTable({ hydrated: true, fts: true });
    }
  });

  it("drops cached eligibility when a run_events hint names the workspace's run", async () => {
    const set = await eligible.loadEligibleDocuments({ workspaceId: "w", embeddingModel: route.model, dimension: DIM });
    expect(set.documents.filter((document) => document.vectorReady)).toHaveLength(DOCS + 1);
    await sql`update documents set superseded_at = now() where id = 'doc6'`;
    try {
      expect(await eligible.loadEligibleDocuments({ workspaceId: "w", embeddingModel: route.model, dimension: DIM })).toBe(set);
      await eligible.invalidateSearchRuns(["run1"]);
      const fresh = await eligible.loadEligibleDocuments({ workspaceId: "w", embeddingModel: route.model, dimension: DIM });
      expect(fresh.documents.map((document) => document.id)).not.toContain("doc6");
    } finally {
      await sql`update documents set superseded_at = null where id = 'doc6'`;
    }
  });
});
