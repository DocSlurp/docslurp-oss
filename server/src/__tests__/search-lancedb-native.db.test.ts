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
const statementParameters: unknown[][] = [];
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

/**
 * `hydrated: false` is an evolved, not yet backfilled table (the columns exist
 * but hold nulls); `evolved: false` is a table written before the hydration
 * columns existed; `legacy` writes the pre-embedding-space `chunks_org_…` table
 * instead of the embedding-space one.
 */
async function writeLanceTable(options: { hydrated: boolean; fts: boolean; evolved?: boolean; legacy?: boolean }): Promise<void> {
  const location = VectorNamespaceManager.getEmbeddingLocation(lanceDir, "org1", route.model, DIM);
  const legacyName = VectorNamespaceManager.getTableName("org1");
  const embeddingDb = await lancedb.connect(location.uri);
  if ((await embeddingDb.tableNames()).includes(location.table)) await embeddingDb.dropTable(location.table);
  const rootDb = await lancedb.connect(lanceDir);
  if ((await rootDb.tableNames()).includes(legacyName)) await rootDb.dropTable(legacyName);
  const rows = chunks.map((chunk) => ({
    id: chunk.id, documentId: chunk.documentId, chunkIndex: chunk.index, text: chunk.text, vector: vectors.get(chunk.id)!,
    metadata: { documentId: chunk.documentId, sourceKey: "k", filename: `${chunk.documentId}.pdf` },
    ...(options.hydrated ? {
      runId: "run1", pageNumber: chunk.page,
      hydration: encodeLanceChunkHydration({ runId: "run1", headingPath: chunk.headingPath, pageNumber: chunk.page, tokenEstimate: 12, metadata: chunk.metadata }),
    } : {}),
  }));
  const db = options.legacy ? rootDb : embeddingDb;
  const table = await db.createTable(options.legacy ? legacyName : location.table, rows);
  if (!options.hydrated && options.evolved !== false) await table.addColumns(LANCE_HYDRATION_COLUMN_SPECS.map((column) => ({ ...column })));
  if (options.fts) await table.createIndex("text", { config: lancedb.Index.fts({ withPosition: false }) });
  table.close();
  embeddingDb.close();
  rootDb.close();
  lance.resetLanceDbConnectionForTests();
}

beforeAll(async () => {
  lanceDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "docslurp-native-search-"));
  vi.stubEnv("LANCEDB_URI", lanceDir);
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {}, debug: (_connection, query, parameters) => { statements.push(query); statementParameters.push([...(parameters as unknown[])]); } });
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
        values (${id}, ${`doc${d}`}, 'run1', 'u', ${c}, ${chunk.text}, ${chunk.headingPath}, ${chunk.page}, 12, ${sql.json(chunk.metadata as postgres.JSONValue)})`;
    }
  }
  // A dedup copy of doc2: chunks in Postgres only, vectors owned by doc2.
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, deduped_from_document_id)
    values ('copy2', 'org1', 'u', 'w', 'run1', 'copy2.pdf', 'application/pdf', 'kc', 'completed', 'doc2')`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values ('vic', 'copy2', 'lancedb', 'b', 'p', ${route.model}, ${DIM})`;
  for (const chunk of chunks.filter((item) => item.documentId === "doc2")) {
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values (${`copy2-${chunk.index}`}, 'copy2', 'run1', 'u', ${chunk.index}, ${chunk.text}, ${chunk.headingPath}, ${chunk.page}, 12, ${sql.json(chunk.metadata as postgres.JSONValue)})`;
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
  it("is on unless SEARCH_LANCEDB_NATIVE turns it off; listed workspaces stay on when it is off", () => {
    expect(eligible.searchLanceDbNativeEnabled("w", {})).toBe(true);
    expect(eligible.searchLanceDbNativeEnabled(undefined, { SEARCH_LANCEDB_NATIVE: "" })).toBe(true);
    for (const off of ["0", "false", "off", "no"]) expect(eligible.searchLanceDbNativeEnabled("w", { SEARCH_LANCEDB_NATIVE: off })).toBe(false);
    expect(eligible.searchLanceDbNativeEnabled("w", { SEARCH_LANCEDB_NATIVE: "0", SEARCH_LANCEDB_NATIVE_WORKSPACES: "x, w" })).toBe(true);
    expect(eligible.searchLanceDbNativeEnabled(undefined, { SEARCH_LANCEDB_NATIVE: "0", SEARCH_LANCEDB_NATIVE_WORKSPACES: "w" })).toBe(false);
  });

  it("matches filenameContains like Postgres ILIKE, in linear time", async () => {
    const names = ["Report_2024.PDF", "a%b.txt", "back\\slash.md", "naïve résumé.docx", "line\nbreak", "x".repeat(64)];
    const patterns = ["report", "_2024", "REP%PDF", "a\\%b", "a\\_b", "%", "_", "", "slash", "\\\\", "RÉSUMÉ", "x_x", "%%x%%", "zz", "line_break"];
    for (const pattern of patterns) {
      const match = eligible.ilikeContainsMatcher(pattern);
      for (const name of names) {
        const [{ hit }] = await sql<{ hit: boolean }[]>`select ${name}::text ilike ${`%${pattern}%`} as hit`;
        expect([pattern, name, match(name)]).toEqual([pattern, name, hit]);
      }
    }
    const started = performance.now();
    for (const pattern of ["%%%%%!", "%%%%%%%%!", "%_%_%_%_%_%_%_%_!", "x%x%x%x%x%x%x%x%x%x%!"]) {
      expect(eligible.ilikeContainsMatcher(pattern)("x".repeat(64))).toBe(false);
      expect(eligible.ilikeContainsMatcher(pattern)("x".repeat(4_096))).toBe(false);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

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

  it("answers a warm search with one SQL read plus chunk-id checks", async () => {
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
    // Plus, per retrieval branch (vector, keyword; run in parallel), one primary-key check that the
    // LanceDB-hydrated hits' chunks still exist.
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(reads[0]).toMatch(/from workspaces w/);
    for (const read of reads.slice(1)) expect(read).toMatch(/select id from document_chunks where id in/);
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

  it("is on by default and serves an untouched table (no hydration columns, no FTS index) through the Postgres fallbacks", async () => {
    await writeLanceTable({ hydrated: false, fts: false, evolved: false });
    try {
      const queryVector = near("doc4-9");
      const legacy = await run(false, "cavitation erosion", { queryVector });
      vi.stubEnv("SEARCH_LANCEDB_NATIVE", undefined);
      const native = await search.hybridSearch("cavitation erosion", "u", { ...baseOptions, queryVector, filters: { workspaceId: "w" } });
      await session.drainSearchSessionWrites();
      expect(native.timings?.nativeLexicalUnindexed).toBe(1);
      expect(native.timings?.nativeHydrationPostgres).toBe(1);
      expect(native.results.length).toBeGreaterThan(0);
      expect(citations(native)).toEqual(citations(legacy));
    } finally {
      await writeLanceTable({ hydrated: true, fts: true });
    }
  });

  it("falls back to Postgres for a legacy chunks_org table", async () => {
    await writeLanceTable({ hydrated: false, fts: false, evolved: false, legacy: true });
    try {
      const queryVector = near("doc2-3");
      const legacy = await run(false, "cavitation erosion", { queryVector });
      const native = await run(true, "cavitation erosion", { queryVector });
      expect(native.timings?.nativeLexicalUnindexed).toBe(1);
      expect(native.results.length).toBeGreaterThan(0);
      expect(citations(native)).toEqual(citations(legacy));
    } finally {
      await writeLanceTable({ hydrated: true, fts: true });
    }
  });

  it("never serves text a correction reindex replaced (stale LanceDB rows)", async () => {
    const original = chunks.find((chunk) => chunk.id === "doc4-9")!;
    const corrected = original.text.replaceAll("cavitation", "corrosion");
    // What reindexDocumentCorrection does: the chunk comes back under a new id, LanceDB is untouched.
    await sql`delete from document_chunks where id = 'doc4-9'`;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values ('doc4-9-fixed', 'doc4', 'run1', 'u', 9, ${corrected}, ${original.headingPath}, ${original.page}, 12, ${sql.json(original.metadata as postgres.JSONValue)})`;
    await sql`insert into document_corrections (id, document_id, run_id, user_id, corrected_markdown, reindex_completed_at)
      values ('fix', 'doc4', 'run1', 'u', 'x', now() + interval '1 second')`;
    eligible.handleSearchEligibilityHint(JSON.stringify({ workspaceIds: ["w"] }));
    try {
      const queryVector = near("doc4-9");
      for (const query of ["cavitation erosion", "corrosion erosion"]) {
        const legacy = await run(false, query, { queryVector });
        const native = await run(true, query, { queryVector });
        expect(native.results.some((result) => result.text.includes("cavitation"))).toBe(false);
        expect(citations(native)).toEqual(citations(legacy));
      }
      const native = await run(true, "corrosion erosion", { queryVector });
      expect(native.results.some((result) => result.text === corrected)).toBe(true);
      expect(native.timings?.nativeHydrationStale).toBe(1);
    } finally {
      await sql`delete from document_corrections where id = 'fix'`;
      await sql`delete from document_chunks where id = 'doc4-9-fixed'`;
      await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
        values ('doc4-9', 'doc4', 'run1', 'u', 9, ${original.text}, ${original.headingPath}, ${original.page}, 12, ${sql.json(original.metadata as postgres.JSONValue)})`;
      eligible.handleSearchEligibilityHint(JSON.stringify({ workspaceIds: ["w"] }));
    }
  });

  it("keeps quoted phrases and -negation on Postgres FTS, which honours them", async () => {
    expect(search.nativeLexicalQuerySupported("cavitation erosion")).toBe(true);
    expect(search.nativeLexicalQuerySupported("state-of-the-art pump")).toBe(true);
    expect(search.nativeLexicalQuerySupported('"cavitation erosion"')).toBe(false);
    expect(search.nativeLexicalQuerySupported("cavitation -erosion")).toBe(false);
    expect(search.nativeLexicalQuerySupported("-erosion cavitation")).toBe(false);
    for (const query of ['"cavitation erosion"', "cavitation -erosion"]) {
      const queryVector = near("doc1-2");
      const legacy = await run(false, query, { queryVector });
      const native = await run(true, query, { queryVector });
      expect(native.timings?.nativeLexicalOperators).toBe(1);
      expect(citations(native)).toEqual(citations(legacy));
    }
  });

  it("stops serving a deleted document once the delete commits (no run_events hint)", async () => {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
      values ('gone', 'org1', 'u', 'w', 'run1', 'gone.pdf', 'application/pdf', 'kg', 'completed')`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values ('vig', 'gone', 'lancedb', 'b', 'p', ${route.model}, ${DIM})`;
    const set = await eligible.loadEligibleDocuments({ workspaceId: "w", embeddingModel: route.model, dimension: DIM });
    expect(set.documents.map((document) => document.id)).toContain("gone");
    const documents = await import("../services/documents.js");
    statements.length = 0;
    statementParameters.length = 0;
    expect(await documents.deleteDocuments(["gone"], "u")).toBe(1);
    const hint = statements.findIndex((statement) => /pg_notify/.test(statement));
    expect(statementParameters[hint]).toEqual(["search_eligibility", JSON.stringify({ workspaceIds: ["w"] })]);
    // Every API process drops the workspace on the hint (delivered at commit).
    eligible.handleSearchEligibilityHint(JSON.stringify({ workspaceIds: ["w"] }));
    const fresh = await eligible.loadEligibleDocuments({ workspaceId: "w", embeddingModel: route.model, dimension: DIM });
    expect(fresh).not.toBe(set);
    expect(fresh.documents.map((document) => document.id)).not.toContain("gone");
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
