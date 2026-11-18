import { embeddingRouteSpaceUri, embeddingSpaceUri, normalizePipelineFeatures, resolveEmbeddingRoute } from "@docslurp/shared";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Vector compatibility with the exact embedding space (migration 0192): a row matches a query on the bare model id
 * and dimension, and also on the `llm://` space URI when both the row and the query know one. A row written before
 * the URI existed (null) still matches the model it was built with; a row from another provider (or other pooling)
 * that shares the bare id and dimension does not.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let eligible: typeof import("../search/eligible-documents.js");
let locator: typeof import("../search/deferred/page-vector-locator.js");

const route = resolveEmbeddingRoute(normalizePipelineFeatures(null).embedding);
const DIM = route.dimensions;
const current = embeddingRouteSpaceUri(route, DIM)!;
// Same bare id and dimension, another provider: a different space.
const otherProvider = embeddingSpaceUri({ provider: "another-host", model: route.model, dimensions: DIM })!;

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('u', 'User', 'space@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org1', 'Org', 'space', 'u')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'org1', 'u', 'Space')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline) values ('run1', 'org1', 'u', 'w', 'bulk-upload', 'completed', 'completed', '{}')`;
  const rows: Array<[string, string | null]> = [["legacy", null], ["exact", current], ["foreign", otherProvider]];
  for (const [id, uri] of rows) {
    await sql`insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status)
      values (${id}, 'org1', 'u', 'w', 'run1', ${`${id}.pdf`}, 'application/pdf', ${`k-${id}`}, 'completed')`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension, embedding_model_uri, embedding_model_class)
      values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', ${route.model}, ${DIM}, ${uri}, ${uri ? "embeddingProfile=cheapest-hosted" : null})`;
  }
  eligible = await import("../search/eligible-documents.js");
  locator = await import("../search/deferred/page-vector-locator.js");
}, 120_000);

afterEach(() => {
  eligible.resetEligibleDocumentCachesForTests();
  locator.clearPageVectorCache();
});
afterAll(async () => { await sql?.end(); await stop?.(); });

const ready = async (embeddingModelUri: string | null | undefined) => {
  const set = await eligible.loadEligibleDocuments({ projectId: "w", embeddingModel: route.model, dimension: DIM, embeddingModelUri });
  return set.documents.filter((document) => document.vectorReady).map((document) => document.id).sort();
};

describe("vector_indexes compatibility", () => {
  it("serves rows without a URI and rows in the exact space, not another provider's rows under the same bare id", async () => {
    expect(await ready(current)).toEqual(["exact", "legacy"]);
    expect(await ready(otherProvider)).toEqual(["foreign", "legacy"]);
  });

  it("matches on the bare id alone when the query has no URI", async () => {
    expect(await ready(null)).toEqual(["exact", "foreign", "legacy"]);
    expect(await ready(undefined)).toEqual(["exact", "foreign", "legacy"]);
  });

  it("keeps different dimensions apart as before", async () => {
    const set = await eligible.loadEligibleDocuments({ projectId: "w", embeddingModel: route.model, dimension: DIM + 1, embeddingModelUri: embeddingRouteSpaceUri(route, DIM + 1) });
    expect(set.documents.filter((document) => document.vectorReady)).toEqual([]);
  });
});

describe("document_page_vectors compatibility", () => {
  it("loads legacy and exact-space page vectors, not another provider's under the same model id", async () => {
    const dims = 8;
    const vector = new Float32Array(dims).fill(0.5);
    const bits = Buffer.from([0xff]);
    const int8 = Buffer.from(new Int8Array(dims).fill(64).buffer);
    const model = "gemini-embedding-2";
    const google = embeddingSpaceUri({ provider: "google", model, dimensions: dims });
    const foreign = embeddingSpaceUri({ provider: "another-host", model, dimensions: dims });
    for (const [doc, page, uri] of [["legacy", 1, null], ["exact", 1, google], ["foreign", 1, foreign]] as const) {
      await sql`insert into document_page_vectors (document_id, page_number, model, model_uri, dims, bits, int8, scale, project_id, org_id)
        values (${doc}, ${page}, ${model}, ${uri}, ${dims}, ${bits}, ${int8}, ${1 / 127}, 'w', 'org1')`;
    }
    const hits = async (modelUri: string | null) => (await locator.locatePageImageCandidates({ projectId: "w", documentIds: [], model, modelUri, queryVector: vector, k: 10 }))
      .map((hit) => hit.documentId).sort();
    expect(await hits(google)).toEqual(["exact", "legacy"]);
    locator.clearPageVectorCache();
    expect(await hits(null)).toEqual(["exact", "foreign", "legacy"]);
    const { pageQuerySpaceUri } = await import("../search/deferred/page-query-embedder.js");
    expect(pageQuerySpaceUri(model, dims)).toBe(google);
  });
});
