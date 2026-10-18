import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import * as lancedb from "@lancedb/lancedb";
import { normalizePipelineFeatures, resolveEmbeddingRoute, VectorNamespaceManager } from "@docslurp/shared";
import { startMigratedPostgres } from "../../../worker/src/test/migrated-postgres.js";

// Bind only the database connection; execute actual SQL, access checks, lexical
// acquisition, LanceDB acquisition, fusion, ranking, packing and session writes.
let sql: postgres.Sql;
const databaseBinding = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
vi.mock("../db.js", () => ({ get sql() {
  if (!databaseBinding.sql) throw new Error("Isolated database is not initialized");
  return databaseBinding.sql;
} }));
let stop: () => Promise<void>;
let directory: string;
let hybridSearch: typeof import("../services/search.js").hybridSearch;
let resetLanceDbConnectionForTests: () => void;
const forbiddenInference = vi.hoisted(() => vi.fn(() => { throw new Error("Inference forbidden in local retrieval integration test"); }));
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  embedConfiguredText: forbiddenInference,
  generateOpenRouterText: forbiddenInference,
  resolveOpenRouterApiKey: () => undefined,
}));

beforeAll(async () => {
  const database = await startMigratedPostgres(); stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  databaseBinding.sql = sql;
  directory = await mkdtemp(join(tmpdir(), "docslurp-retrieval-controls-"));
  vi.stubEnv("LANCEDB_URI", directory);
  const pipeline = { privacyMode: "local-only", embedding: { profile: "good-fast-local" } } as const;
  const model = resolveEmbeddingRoute(normalizePipelineFeatures(pipeline).embedding).model;
  await sql`insert into "user" (id, name, email) values ('rank-user', 'Ranking', 'ranking@example.invalid')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('rank-org', 'Ranking', 'ranking', 'rank-user')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('rank-org', 'rank-user', 'owner')`;
  await sql`insert into workspaces (id, org_id, user_id, name, pipeline) values ('rank-ws', 'rank-org', 'rank-user', 'Ranking', ${sql.json(pipeline)}), ('other-ws', 'rank-org', 'rank-user', 'Other', ${sql.json(pipeline)})`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline) values ('rank-run', 'rank-org', 'rank-user', 'rank-ws', 'bulk-upload', 'completed', 'completed', '{}'::jsonb), ('foreign-run', 'rank-org', 'rank-user', 'other-ws', 'bulk-upload', 'completed', 'completed', '{}'::jsonb)`;
  await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
    values ('rank-doc', 'rank-org', 'rank-user', 'rank-ws', 'rank-run', 'manual.txt', 'text/plain', 'local/manual', 'completed', 240),
    ('foreign-doc', 'rank-org', 'rank-user', 'other-ws', 'foreign-run', 'other.txt', 'text/plain', 'local/other', 'completed', 1)`;
  const rows = Array.from({ length: 240 }, (_, i) => ({
    id: `rank-${i}`, document_id: 'rank-doc', run_id: 'rank-run', user_id: 'rank-user', chunk_index: i,
    text: `Pump maintenance schedule ${i}. ${i === 49 ? 'Cobalt calibration takes eighteen months.' : 'Inspect the pressure gauge.'}`,
    heading_path: ['Maintenance'], token_estimate: 20, page_number: i + 1, metadata: {},
  }));
  await sql`insert into document_chunks ${sql(rows)}`;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, page_number, metadata)
    values ('foreign-chunk', 'foreign-doc', 'foreign-run', 'rank-user', 0, 'Pump maintenance cobalt calibration', '{}', 10, 1, '{}'::jsonb)`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension) values ('rank-index', 'rank-doc', 'lancedb', 'local', 'local/rank', ${model}, 3), ('foreign-index', 'foreign-doc', 'lancedb', 'local', 'local/foreign', ${model}, 3)`;
  const location = VectorNamespaceManager.getEmbeddingLocation(directory, 'rank-org', model, 3);
  const db = await lancedb.connect(location.uri);
  const table = await db.createTable(location.table, [
    ...rows.map((r, i) => ({ id: r.id, documentId: r.document_id, chunkIndex: i, vector: [1 - i / 100, i / 100, 0] })),
    { id: 'foreign-chunk', documentId: 'foreign-doc', chunkIndex: 0, vector: [1, 0, 0] },
  ]);
  expect(await table.vectorSearch([1, 0, 0]).limit(50).toArray()).toHaveLength(50);
  table.close(); db.close();
  const { loadWorkspacePipeline } = await import("../search/session-setup.js");
  expect(resolveEmbeddingRoute((await loadWorkspacePipeline("rank-ws")).embedding).model).toBe(model);
  ({ hybridSearch } = await import("../services/search.js"));
  const lance = await import("../search/lancedb.js");
  resetLanceDbConnectionForTests = lance.resetLanceDbConnectionForTests;
  expect(await lance.lanceDbVectorSearch({ orgId: "rank-org", embeddingModel: model, queryVector: [1, 0, 0], documentIds: ["rank-doc"], limit: 50 })).toHaveLength(50);
}, 120_000);

afterAll(async () => {
  resetLanceDbConnectionForTests?.();
  await sql?.end(); await stop?.();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("actual hybrid retrieval with isolated SQL and LanceDB", () => {
  it("holds acquisition depth constant across rerank modes and separates packing from relevance", async () => {
    for (const candidateDepth of [50, 100, 200]) {
      for (const useRerank of [false, true]) {
        const options = { filters: { workspaceId: 'rank-ws' }, queryVector: [1, 0, 0], candidateDepth, useRerank,
          limit: 10, minScore: 0, useMmr: false, parentRetrieval: false, summarySeed: false,
          queryRewrite: false, queryDecompose: false, stepback: false, selfQuery: false, iterativeMultiHop: false,
          useHyDE: false, useContextualCompression: false, enableGraphExpansion: false, enableCommunityExpansion: false };
        const relevance = await hybridSearch('pump maintenance', 'rank-user', { ...options, resultOrder: 'relevance' });
        const prompt = await hybridSearch('pump maintenance', 'rank-user', { ...options, resultOrder: 'prompt' });
        expect(relevance.results).toHaveLength(10);
        expect(prompt.results.map(r => r.citation.chunkIndex).sort((a, b) => (a ?? 0) - (b ?? 0)))
          .toEqual(relevance.results.map(r => r.citation.chunkIndex).sort((a, b) => (a ?? 0) - (b ?? 0)));
        expect(prompt.results[9].citation.chunkIndex).toBe(relevance.results[1].citation.chunkIndex);
        expect(relevance.results.every(r => r.citation.documentId === 'rank-doc')).toBe(true);
        expect(relevance.results.every(r => r.citation.pageNumber === (r.citation.chunkIndex ?? 0) + 1)).toBe(true);
        const [session] = await sql`select metadata from search_sessions where id = ${relevance.sessionId}`;
        expect(session.metadata.diagnostics.candidateSelection).toMatchObject({ candidateDepth, resultOrder: 'relevance', candidateWindowCount: Math.min(240, candidateDepth) });
        expect(session.metadata.diagnostics.candidateSelection.adapterCounts.slice(0, 2)).toEqual([Math.min(240, candidateDepth), Math.min(240, candidateDepth)]);
        expect(relevance.usageEvents).toHaveLength(0);
      }
    }
    expect(forbiddenInference).not.toHaveBeenCalled();
  }, 120_000);
});
