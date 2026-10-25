import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, indexConfigHash, indexConfigOf, type PipelineFeatures } from "@docslurp/shared";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Search serves every live document from the index config it was built with: one vector search per config in
 * `workspaces.index_configs`, each restricted to that config's documents, the query embedded once per distinct
 * model, the lists fused with RRF. With a single config nothing extra runs.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let serving: typeof import("../search/index-serving.js");
let setup: typeof import("../search/session-setup.js");
let queries = 0;

const withModel = (modelUri: string): PipelineFeatures => ({
  ...defaultPipelineFeatures,
  embedding: { ...defaultPipelineFeatures.embedding, target: "local" as const, modelUri: modelUri as never },
});
const A = withModel("llm://transformers.js/Xenova/all-MiniLM-L6-v2");
const B = withModel("llm://transformers.js/Xenova/gte-small");
const C = withModel("llm://transformers.js/Xenova/bge-m3");
const D = { ...C, chunkOverlap: !C.chunkOverlap };
const cfg = (pipeline: PipelineFeatures) => indexConfigOf(pipeline);
const hash = (pipeline: PipelineFeatures) => indexConfigHash(indexConfigOf(pipeline));

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  const counting = new Proxy(sql, {
    apply(target, thisArg, args) {
      queries += 1;
      return Reflect.apply(target as never, thisArg, args);
    },
  });
  vi.doMock("../db.js", () => ({ sql: counting }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  serving = await import("../search/index-serving.js");
  setup = await import("../search/session-setup.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

async function seed(docHashes: Array<string | null>, configs: Record<string, unknown> | null, pipeline: PipelineFeatures = C) {
  await sql`delete from vector_indexes`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
  await sql`delete from workspaces`;
  await sql`delete from organizations`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into workspaces(id, org_id, user_id, name, pipeline, index_configs)
    values ('w', 'o1', 'u1', 'W', ${sql.json(JSON.parse(JSON.stringify(pipeline)))}, ${configs ? sql.json(JSON.parse(JSON.stringify(configs))) : null})`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
    values ('r', 'o1', 'u1', 'w', 'upload', 'completed', 'index', '{}', ${docHashes.length})`;
  for (const [i, h] of docHashes.entries()) {
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, index_config_hash)
      values (${`d${i}`}, 'o1', 'u1', 'w', 'r', ${`f${i}`}, 'application/pdf', ${`k${i}`}, 'completed', 1, ${h})`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`v${i}`}, ${`d${i}`}, 'lancedb', 'b', 'p', 'm', 384)`;
  }
}

const chunk = (id: string, score = 0.9) => ({ id, score });
type Serve = { embedding: { modelUri?: string }; hash: { op: string; value: string } | null } | null;

describe("servedVectorSearch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs no query and no extra search when only one config exists", async () => {
    await seed([hash(C)], { [hash(C)]: cfg(C) });
    const search = vi.fn(async () => [chunk("a")]);
    const embed = vi.fn(async () => [1]);
    queries = 0;
    const result = await serving.servedVectorSearch({
      workspaceId: "w", pipeline: C, indexConfigs: { [hash(C)]: cfg(C) }, queryVector: [0], query: "q", deps: { search, embed },
    });
    expect(queries).toBe(0);
    expect(result).toEqual([chunk("a")]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith([0], null);
    expect(embed).not.toHaveBeenCalled();
  });

  it("loads the config map with the pipeline in a single query", async () => {
    await seed([hash(C)], { [hash(C)]: cfg(C) });
    queries = 0;
    const loaded = await setup.loadWorkspaceIndexing("w");
    expect(queries).toBe(1);
    expect(Object.keys(loaded.indexConfigs)).toEqual([hash(C)]);
    expect(loaded.pipeline.embedding.modelUri).toBe("llm://transformers.js/Xenova/bge-m3");
  });

  it("serves documents of three configs, each scored with its own model and restricted by its hash", async () => {
    await seed([hash(A), hash(B), hash(C)], { [hash(A)]: cfg(A), [hash(B)]: cfg(B), [hash(C)]: cfg(C) });
    const search = vi.fn(async (_vector: number[], serve: Serve) => {
      const value = serve?.hash?.value;
      return value === hash(C) ? [chunk("c1"), chunk("shared")] : value === hash(B) ? [chunk("b1"), chunk("shared")] : [chunk("a1")];
    });
    const embed = vi.fn(async (_text: string, embedding: { modelUri?: string }) => (embedding.modelUri?.includes("gte") ? [2] : [1]));
    const result = await serving.servedVectorSearch({
      workspaceId: "w", pipeline: C, indexConfigs: { [hash(A)]: cfg(A), [hash(B)]: cfg(B), [hash(C)]: cfg(C) },
      queryVector: [0], query: "the effective query", deps: { search: search as never, embed },
    });

    // The query is embedded once per other model, with the effective query text.
    expect(embed).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls.map(([text]) => text)).toEqual(["the effective query", "the effective query"]);
    const calls = search.mock.calls.map(([vector, serve]) => ({ vector, op: serve?.hash?.op, value: serve?.hash?.value, model: serve?.embedding.modelUri }));
    expect(calls).toContainEqual({ vector: [0], op: "eq", value: hash(C), model: "llm://transformers.js/Xenova/bge-m3" });
    expect(calls).toContainEqual({ vector: [2], op: "eq", value: hash(B), model: "llm://transformers.js/Xenova/gte-small" });
    expect(calls).toContainEqual({ vector: [1], op: "eq", value: hash(A), model: "llm://transformers.js/Xenova/all-MiniLM-L6-v2" });
    // Documents from all three configs are returned; fusion is rank based (no raw cross-model scores).
    expect(result.map((r) => r.id).sort()).toEqual(["a1", "b1", "c1", "shared"]);
    expect(result[0]!.id).toBe("shared");
    expect(result.every((r) => r.score! < 0.1)).toBe(true);
  });

  it("embeds once for configs that share a vector space (chunking-only difference)", async () => {
    await seed([hash(C), hash(D)], { [hash(C)]: cfg(C), [hash(D)]: cfg(D) }, D);
    const search = vi.fn(async () => [chunk("x")]);
    const embed = vi.fn(async () => [5]);
    await serving.servedVectorSearch({
      workspaceId: "w", pipeline: D, indexConfigs: { [hash(C)]: cfg(C), [hash(D)]: cfg(D) }, queryVector: [0], query: "q", deps: { search, embed },
    });
    expect(embed).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("re-embeds the query for a config that differs only in pooling", async () => {
    const Cls = withModel("llm://transformers.js/Xenova/bge-m3?pooling=cls");
    expect(hash(Cls)).not.toBe(hash(C));
    await seed([hash(C), hash(Cls)], { [hash(C)]: cfg(C), [hash(Cls)]: cfg(Cls) }, Cls);
    const search = vi.fn(async (_vector: number[], _serve: Serve) => [chunk("x")]);
    const embed = vi.fn(async (_text: string, _embedding: { modelUri?: string }) => [7]);
    await serving.servedVectorSearch({
      workspaceId: "w", pipeline: Cls, indexConfigs: { [hash(C)]: cfg(C), [hash(Cls)]: cfg(Cls) }, queryVector: [0], query: "q", deps: { search: search as never, embed },
    });
    // The mean-pooled documents are searched with a mean-pooled query, never the current CLS vector.
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![1]).toMatchObject({ modelUri: "llm://transformers.js/Xenova/bge-m3" });
    const vectors = search.mock.calls.map(([vector, serve]) => ({ vector, value: serve?.hash?.value }));
    expect(vectors).toContainEqual({ vector: [7], value: hash(C) });
    expect(vectors).toContainEqual({ vector: [0], value: hash(Cls) });
  });

  it("serves the three configs with the most documents and records a diagnostic when there are more", async () => {
    const E = withModel("llm://transformers.js/Xenova/gte-small");
    const F = { ...E, chunkOverlap: !E.chunkOverlap };
    await seed([hash(A), hash(A), hash(A), hash(B), hash(B), hash(C), hash(F)], {
      [hash(A)]: cfg(A), [hash(B)]: cfg(B), [hash(C)]: cfg(C), [hash(F)]: cfg(F),
    });
    const search = vi.fn(async () => [chunk("x")]);
    const diagnostic = vi.fn();
    await serving.servedVectorSearch({
      workspaceId: "w", pipeline: C, indexConfigs: { [hash(A)]: cfg(A), [hash(B)]: cfg(B), [hash(C)]: cfg(C), [hash(F)]: cfg(F) },
      queryVector: [0], query: "q", deps: { search, embed: vi.fn(async () => [1]), diagnostic },
    });
    expect(search).toHaveBeenCalledTimes(3);
    expect(diagnostic).toHaveBeenCalledWith("indexConfigs", expect.objectContaining({ configs: 4, served: 3 }));
  });

  it("prunes drained configs lazily and keeps the current one", async () => {
    await seed([hash(C), hash(C)], { [hash(A)]: cfg(A), [hash(C)]: cfg(C) });
    const search = vi.fn(async () => [chunk("a")]);
    await serving.servedVectorSearch({
      workspaceId: "w", pipeline: C, indexConfigs: { [hash(A)]: cfg(A), [hash(C)]: cfg(C) }, queryVector: [0], query: "q", deps: { search, embed: vi.fn() },
    });
    await vi.waitFor(async () => {
      const [ws] = await sql<{ index_configs: Record<string, unknown> }[]>`select index_configs from workspaces where id = 'w'`;
      expect(Object.keys(ws!.index_configs)).toEqual([hash(C)]);
    });
  });

  it("sweeper prune empties entries once re-indexed documents replace the old ones", async () => {
    await seed([hash(B)], { [hash(A)]: cfg(A), [hash(B)]: cfg(B), [hash(C)]: cfg(C) });
    expect(await serving.pruneDrainedIndexConfigs(sql as never)).toBe(0);
    let [ws] = await sql<{ index_configs: Record<string, unknown> }[]>`select index_configs from workspaces where id = 'w'`;
    expect(Object.keys(ws!.index_configs).sort()).toEqual([hash(B), hash(C)].sort());
    await sql`update documents set index_config_hash = ${hash(C)}`;
    expect(await serving.pruneDrainedIndexConfigs(sql as never)).toBe(1);
    [ws] = await sql<{ index_configs: Record<string, unknown> }[]>`select index_configs from workspaces where id = 'w'`;
    expect(Object.keys(ws!.index_configs)).toEqual([hash(C)]);
  });
});
