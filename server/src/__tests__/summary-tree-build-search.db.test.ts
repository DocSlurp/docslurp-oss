import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { artifactUri, indexConfigHash, indexConfigOf, DISTINCT_TEST_PRICING, installTestPricing, normalizePipelineFeatures, resolveEmbeddingRoute, VectorNamespaceManager, type PipelineFeatures } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  registerSummaryTreeArtifact,
  runSummaryTreeForDocument,
  startMigratedPostgres,
  type SummaryTreeDocumentRun,
  type SummaryTreeStorage,
} from "@docslurp/worker/testing";

/**
 * Build -> search, end to end: the worker's real build (`runSummaryTreeForDocument`: grouping, artifact, registry,
 * state row, summary rows through the real LanceDB writer) and then the server's real search leg, against the same
 * migrated Postgres and the same LanceDB directory, in one process. Only the summary model and the embedder are
 * fakes; no provider is called. Nothing here seeds a tree row by hand: if the stage and the retrieval leg disagree
 * about a column, an id, a run or a table location, `guide` returns nothing and this test fails.
 */
vi.mock("../lib/ai.js", async (original) => ({
  ...await original<typeof import("../lib/ai.js")>(),
  resolveOpenRouterApiKey: () => undefined,
  generateOpenRouterText: () => { throw new Error("Unexpected inference"); },
}));

const PIPELINE: PipelineFeatures = normalizePipelineFeatures({ embed: true, indexVectors: true, summaryTree: { enabled: true } } as never);
const route = resolveEmbeddingRoute(PIPELINE.embedding);
const DIM = route.dimensions;
const BUCKET = "test-bucket";
const ENV = { DOCSLURP_SUMMARY_TREE_BUILD: "on" };
/** A signed-in user's scope, as `searchAccessScopeFor` builds it. */
const SCOPE = { orgId: "org1", projectIds: "org", modeCeiling: null, actor: { type: "session" } } as const;
const config = { costPer1kInputTokens: 0.001, costPer1kOutputTokens: 0.002, openRouterApiKey: "test-key" } as never;

let sql: postgres.Sql<Record<string, unknown>>;
let stop: () => Promise<void>;
let lanceDir: string;
let spoolDir: string;
let search: typeof import("../services/search.js");
let eligible: typeof import("../search/eligible-documents.js");
let lance: typeof import("../search/lancedb.js");
let session: typeof import("../search/session.js");
let controls: typeof import("../services/search-controls.js");

class MemoryStorage implements SummaryTreeStorage {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, Buffer>();
  uri(key: string) { return artifactUri(this.bucket, key); }
  async getBytes(key: string) {
    const found = this.objects.get(key);
    if (!found) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
    return found;
  }
  async putBytes(key: string, data: Uint8Array) { this.objects.set(key, Buffer.from(data)); }
  async listKeys(options?: { prefix?: string }) {
    return { keys: [...this.objects.keys()].filter((key) => key.startsWith(options?.prefix ?? "")).sort(), truncated: false };
  }
  async deleteKeys(keys: string[]) { for (const key of keys) this.objects.delete(key); }
  async openStream(key: string) {
    const data = await this.getBytes(key);
    return { stream: (async function* () { for (let at = 0; at < data.length; at += 64 * 1024) yield data.subarray(at, at + 64 * 1024); })() };
  }
}
const storage = new MemoryStorage();

/** A unit vector with `heat` of the query direction (the first axis) and the rest on its own axis. */
let axis = 1;
function vector(heat = 0): number[] {
  const out = new Array<number>(DIM).fill(0);
  out[0] = heat;
  out[axis] = Math.sqrt(1 - heat * heat);
  axis = axis + 1 < DIM ? axis + 1 : 1;
  return out;
}
const QUERY = (() => { const out = new Array<number>(DIM).fill(0); out[0] = 1; return out; })();

type Chunk = { id: string; documentId: string; chunkIndex: number; text: string; vector: number[]; headingPath: string[] };
const lanceChunks: Chunk[] = [];

/** A completed, indexed document: Postgres rows, chunk vectors for the chunk legs, and its embed-stage artifact. */
async function seedDocument(id: string, chunks: number, heat: (index: number) => number): Promise<void> {
  await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status, canonical_id, index_config_hash)
    values (${id}, 'org1', 'u', 'w', 'run-w', ${`${id}.md`}, 'text/markdown', ${`u/src/${id}`}, 'completed', ${`/${id}`}, ${indexConfigHash(indexConfigOf(PIPELINE))})`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', ${route.model}, ${DIM})`;
  const rows: Chunk[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const section = Math.floor(index / 10);
    const text = `${id} section ${section + 1} passage ${index}: the board approved the expansion plan and the new office.`;
    const row = { id: `${id}-${index}`, documentId: id, chunkIndex: index, text, vector: vector(heat(index)), headingPath: [`Section ${section + 1}`] };
    rows.push(row);
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number, token_estimate, metadata)
      values (${row.id}, ${id}, 'run-w', 'u', ${index}, ${text}, ${row.headingPath}, ${1 + Math.floor(index / 4)}, 24, ${sql.json({ overlapIndex: 0, rawText: text })})`;
  }
  lanceChunks.push(...rows);
  storage.objects.set(`u/run-w/embeddings/${id}.json`, Buffer.from(JSON.stringify({
    documentId: id,
    embedding: { provider: "test", model: route.model, dimensions: DIM, runtime: "local" },
    chunks: rows.map((row) => ({ index: row.chunkIndex, headingPath: row.headingPath, pageNumbers: [1 + Math.floor(row.chunkIndex / 4)], vector: row.vector, metadata: { rawText: row.text, overlapIndex: 0 } })),
  })));
  await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, artifact_uri, stats)
    values ('run-w', ${id}, 'embed', 'completed', 1, ${storage.uri(`u/run-w/embeddings/${id}.json`)}, ${sql.json({ chunks })})`;
}

const calls: string[] = [];
let failNode: string | null = null;

/** The real build of one document, as the stage and the backfill job run it. */
async function build(documentId: string, overrides: Partial<SummaryTreeDocumentRun> = {}) {
  const result = await runSummaryTreeForDocument({
    sql,
    storage,
    config,
    pipeline: PIPELINE,
    scope: { orgId: "org1", projectId: "w" },
    runId: "run-w",
    runRoot: "u/run-w",
    document: { id: documentId, normalizedFormat: "markdown", mimeType: "text/markdown" },
    embeddingArtifactUri: storage.uri(`u/run-w/embeddings/${documentId}.json`),
    usage: { record: () => undefined },
    spendRefusal: async () => null,
    overrides: {
      env: ENV, lanceRoot: lanceDir, tmpDirectory: spoolDir, concurrency: 4, tableChanged: () => undefined,
      summarize: async (request) => {
        calls.push(request.nodeId);
        if (failNode && request.nodeId.endsWith(failNode)) throw new Error("model unavailable");
        return { text: `Title ${request.nodeId}\nSummary of ${request.nodeId}.`, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 40 } };
      },
      // The summary of chunks 20..29 is the one nearest the query; every other summary is far from it.
      embed: async (texts) => texts.map((text) => vector(text.includes(":L1:20-29") ? 0.97 : 0)),
    },
    ...overrides,
  });
  if (result.artifactUri) await registerSummaryTreeArtifact(sql, { scope: { orgId: "org1", projectId: "w" }, documentId, runId: "run-w", artifactUri: result.artifactUri });
  return result;
}

async function guide(options: { resetCaches?: boolean } = {}) {
  if (options.resetCaches) eligible.resetEligibleDocumentCachesForTests();
  vi.stubEnv("DOCSLURP_SUMMARY_TREE_SERVE", "on");
  const response = await search.hybridSearch("qqqzzz", "u", {
    limit: 10, minScore: 0, useRerank: false, queryRewrite: false, selfQuery: false, parentRetrieval: false,
    useContextualCompression: false, useHyDE: false, stepback: false, iterativeMultiHop: false, useMmr: false,
    enableGraphExpansion: false, enableCommunityExpansion: false, queryVector: QUERY,
    summaryTree: "guide", filters: { projectId: "w" },
  } as never, SCOPE as never);
  await session.drainSearchSessionWrites();
  return response;
}
const cited = (response: Awaited<ReturnType<typeof guide>>, documentId: string) =>
  response.results.filter((result) => result.citation.documentId === documentId).map((result) => result.citation.chunkIndex);

beforeAll(async () => {
  installTestPricing({ ...DISTINCT_TEST_PRICING, summaryTreeCallCredits: () => 0.1 });
  lanceDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "docslurp-summary-tree-e2e-lance-"));
  spoolDir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "docslurp-summary-tree-e2e-spool-"));
  vi.stubEnv("LANCEDB_URI", lanceDir);
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'tree-e2e@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'tree-e2e', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org1', 'u', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name, pipeline) values ('w', 'org1', 'u', 'w', ${sql.json(PIPELINE as unknown as postgres.JSONValue)})`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('run-w', 'org1', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  // docB: twelve chunks, ten of them the chunk legs' top ten. Too short for a tree.
  await seedDocument("docB", 12, (index) => (index < 10 ? 0.95 - index * 0.01 : 0));
  // docT: forty cold chunks in four sections; only its tree can surface them.
  await seedDocument("docT", 40, () => 0);

  const location = VectorNamespaceManager.getEmbeddingLocation(lanceDir, "org1", "w", route.model, DIM);
  const db = await lancedb.connect(location.uri);
  (await db.createTable(location.table, lanceChunks.map(({ headingPath: _headingPath, ...row }) => ({ ...row })))).close();
  db.close();

  search = await import("../services/search.js");
  eligible = await import("../search/eligible-documents.js");
  lance = await import("../search/lancedb.js");
  session = await import("../search/session.js");
  controls = await import("../services/search-controls.js");
  const current = await controls.getProjectSearchSettings("w", "u");
  await controls.upsertProjectSearchSettings({ ...current, dedupeByFilename: false } as never);
}, 240_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await sql?.end();
  await stop?.();
  lance?.resetLanceDbConnectionForTests();
  if (lanceDir) await rm(lanceDir, { recursive: true, force: true });
  if (spoolDir) await rm(spoolDir, { recursive: true, force: true });
});

describe("summary tree: the built tree is what search serves", () => {
  it("serves guide chunks from a tree the real build wrote, and stops on partial rebuild, supersede and delete", async () => {
    // Nothing built yet: the leg has nothing to read.
    const before = await guide();
    expect(before.summaryTree).toMatchObject({ requested: "guide", applied: "off", skipped: "not-ready" });
    expect(cited(before, "docT")).toEqual([]);

    // The short document is skipped; the long one gets four section nodes and a root.
    expect(await build("docB")).toMatchObject({ status: "skipped", skipReason: "short" });
    await sql`insert into document_summaries (id, document_id, run_id, user_id, summary)
      values ('docT-sampled', 'docT', 'run-w', 'u', 'Earlier sampled summary')`;
    const built = await build("docT");
    expect(built).toMatchObject({ status: "ready", stats: { leaves: 40, groups: 4, nodes: 5, modelCalls: 5 } });
    const [state] = await sql<Array<Record<string, unknown>>>`
      select t.status, t.run_id, t.org_id, t.project_id, t.embedding_model, t.dimension, t.built_at, d.run_id as document_run_id
      from document_summary_trees t join documents d on d.id = t.document_id where t.document_id = 'docT'`;
    expect(state).toMatchObject({ status: "ready", run_id: "run-w", document_run_id: "run-w", org_id: "org1", project_id: "w", embedding_model: route.model, dimension: DIM });
    expect(state!.built_at).not.toBeNull();
    const summaries = await sql`select summary from document_summaries where document_id = 'docT' and run_id = 'run-w'`;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.summary).toContain(':L2:0-39');
    expect(summaries[0]!.summary).not.toContain('Earlier sampled summary');

    // The retrieval leg reads that tree: three chunks of the nearest section, after the chunk legs' protected prefix.
    const served = await guide({ resetCaches: true });
    expect(served.summaryTree).toMatchObject({ requested: "guide", applied: "guide" });
    expect(served.summaryTree).not.toHaveProperty("skipped");
    expect(cited(served, "docT")).toHaveLength(3);
    for (const chunkIndex of cited(served, "docT")) {
      expect(chunkIndex).toBeGreaterThanOrEqual(20);
      expect(chunkIndex).toBeLessThanOrEqual(29);
    }
    expect(served.results.slice(0, 7).map((result) => result.citation.documentId)).toEqual(Array(7).fill("docB"));
    for (const result of served.results) expect(result.text).not.toMatch(/^Title |Summary of/);

    // A rebuild with other text settings whose first section fails: it ends partial. With every cache still warm,
    // nothing of the tree is served.
    const otherProfile = PIPELINE.textGeneration.profile === "grounded-low" ? "provider-default" : "grounded-low";
    const rebuiltPipeline = normalizePipelineFeatures({ ...PIPELINE, textGeneration: { ...PIPELINE.textGeneration, profile: otherProfile } } as never);
    failNode = ":L1:0-9";
    expect(await build("docT", { pipeline: rebuiltPipeline })).toMatchObject({ status: "partial", reason: "group-failed:model-error" });
    failNode = null;
    expect((await sql`select status, built_at from document_summary_trees where document_id = 'docT'`)[0]).toMatchObject({ status: "partial", built_at: null });
    const afterPartial = await guide();
    expect(cited(afterPartial, "docT")).toEqual([]);
    expect((await guide({ resetCaches: true })).summaryTree).toMatchObject({ applied: "off", skipped: "not-ready" });

    // The next build resumes (only the failed group and what sits above it are called) and the tree is served again.
    calls.length = 0;
    const firstBuiltAt = state!.built_at as Date;
    const resumed = await build("docT", { pipeline: rebuiltPipeline });
    expect(resumed.status).toBe("ready");
    // The failed section and the root above it; the three sections that succeeded are read back from the artifact.
    expect(calls).toEqual(["docT:L1:0-9", "docT:L2:0-39"]);
    // built_at moved forward with the rebuild.
    const [rebuilt] = await sql<Array<{ built_at: Date }>>`select built_at from document_summary_trees where document_id = 'docT'`;
    expect(new Date(rebuilt!.built_at).getTime()).toBeGreaterThan(new Date(firstBuiltAt).getTime());
    const again = await guide({ resetCaches: true });
    expect(again.summaryTree).toMatchObject({ applied: "guide" });
    expect(cited(again, "docT")).toHaveLength(3);

    // Superseded: with the eligible set still cached, the request-time check drops every node.
    await sql`update documents set superseded_at = now() where id = 'docT'`;
    expect(cited(await guide(), "docT")).toEqual([]);
    expect(cited(await guide({ resetCaches: true }), "docT")).toEqual([]);
    await sql`update documents set superseded_at = null where id = 'docT'`;
    expect(cited(await guide({ resetCaches: true }), "docT")).toHaveLength(3);

    // Deleted: the state and registry rows cascade; the summaries table still holds the rows until the purge runs,
    // and none of them is served, cache warm or not.
    await sql`delete from documents where id = 'docT'`;
    expect(await sql`select 1 from document_summary_trees where document_id = 'docT'`).toHaveLength(0);
    expect(await sql`select 1 from document_summary_tree_nodes where document_id = 'docT'`).toHaveLength(0);
    expect(cited(await guide(), "docT")).toEqual([]);
    const afterDelete = await guide({ resetCaches: true });
    expect(cited(afterDelete, "docT")).toEqual([]);
    expect(afterDelete.summaryTree).toMatchObject({ applied: "off", skipped: "not-ready" });
  }, 240_000);
});
