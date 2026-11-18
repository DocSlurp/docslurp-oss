import {
  embeddingProfileCatalog,
  embeddingRouteSpaceUri,
  embeddingSpaceUri,
  indexConfigOf,
  normalizePipelineFeatures,
  resolveEmbeddingRoute,
  setPrivateModelEndpointRegistryForTests,
} from "@docslurp/shared";
import {
  createGeminiPageEmbedder,
  createPrivateEndpointPageEmbedder,
  resolveEmbeddingModel,
  workerConfigFromEnv,
} from "@docslurp/worker/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
const { embeddingConfigFor } = await import("../search/index-serving.js");
const { pageQuerySpaceUri } = await import("../search/deferred/page-query-embedder.js");

/**
 * The space a vector row is written in (the worker's embedding route) must be the space search looks it up in (the
 * server's route for the same pipeline, or for a stored index config): otherwise every new row would stop matching.
 */
const PRIVATE_TEXT = "llm://private/gpu1/BAAI/bge-m3";
const PRIVATE_PAGES = "llm://private/gpu1/jinaai/jina-embeddings-v5-omni-nano";

beforeAll(() => {
  setPrivateModelEndpointRegistryForTests([{
    alias: "gpu1", baseUrl: "https://gpu1.example.com/v1", auth: { tokenEnv: "TEST_PARITY_EMBED_TOKEN" },
    models: [
      { id: "BAAI/bge-m3", capability: "embedding", dimensions: 1024 },
      { id: "jinaai/jina-embeddings-v5-omni-nano", capability: "embedding", dimensions: 768 },
    ],
    attestation: { tenancy: "single-tenant", hostProvider: "example", region: "us-east-1" },
  }]);
});
afterAll(() => setPrivateModelEndpointRegistryForTests(undefined));

const config = { ...workerConfigFromEnv() };
const cases: Array<[string, Parameters<typeof normalizePipelineFeatures>[0]]> = [
  ...Object.keys(embeddingProfileCatalog).map((profile) => [`profile ${profile}`, { embedding: { profile } }] as [string, Parameters<typeof normalizePipelineFeatures>[0]]),
  ["local route with cls pooling", { embedding: { profile: "cheapest-local", modelUri: "llm://transformers.js/Xenova/bge-small-en-v1.5?pooling=cls" } }],
  ["private route", { embedding: { profile: "cheapest-hosted", modelUri: PRIVATE_TEXT, target: "private" } }],
  ["custom dimensions", { embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", dimensions: 512 } }],
];

describe("embedding space parity, worker write vs server read", () => {
  it.each(cases)("%s", (_name, input) => {
    const pipeline = normalizePipelineFeatures(input as never);
    const written = resolveEmbeddingModel(config, pipeline);
    const writtenUri = embeddingRouteSpaceUri(written, written.dimensions);
    expect(writtenUri).toMatch(/^llm:\/\//);
    // Current pipeline: search resolves the project's embedding config.
    const current = resolveEmbeddingRoute(pipeline.embedding);
    expect(embeddingRouteSpaceUri(current, current.dimensions)).toBe(writtenUri);
    // An older index: search reproduces the stored config's route while the project now uses another model.
    const later = normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-large" } } as never);
    const stored = resolveEmbeddingRoute(embeddingConfigFor(later.embedding, indexConfigOf(pipeline)));
    expect(embeddingRouteSpaceUri(stored, stored.dimensions)).toBe(writtenUri);
  });

  it("tells pooling and dimensions apart", () => {
    const uri = (input: Parameters<typeof normalizePipelineFeatures>[0]) => {
      const route = resolveEmbeddingModel(config, normalizePipelineFeatures(input as never));
      return embeddingRouteSpaceUri(route, route.dimensions);
    };
    const mean = uri({ embedding: { profile: "cheapest-local", modelUri: "llm://transformers.js/Xenova/bge-small-en-v1.5" } });
    const cls = uri({ embedding: { profile: "cheapest-local", modelUri: "llm://transformers.js/Xenova/bge-small-en-v1.5?pooling=cls" } });
    expect(cls).not.toBe(mean);
    expect(uri({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", dimensions: 256 } }))
      .not.toBe(uri({ embedding: { profile: "cheapest-hosted", modelUri: "llm://openai/text-embedding-3-small", dimensions: 512 } }));
  });
});

describe("page vector parity, worker page embedders vs server query space", () => {
  it("Gemini", () => {
    const embedder = createGeminiPageEmbedder({ apiKey: "test" });
    const written = embeddingSpaceUri({ provider: embedder.provider, model: embedder.model, dimensions: embedder.dims });
    expect(pageQuerySpaceUri(embedder.model, embedder.dims)).toBe(written);
  });

  it("private endpoint", () => {
    const embedder = createPrivateEndpointPageEmbedder({ modelUri: PRIVATE_PAGES, privacyMode: "standard" });
    const written = embeddingSpaceUri({ provider: embedder.provider, model: embedder.model, dimensions: embedder.dims });
    expect(written).toMatch(/^llm:\/\//);
    expect(pageQuerySpaceUri(embedder.model, embedder.dims)).toBe(written);
  });
});
