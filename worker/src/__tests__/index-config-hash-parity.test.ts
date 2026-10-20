import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures, indexConfigHash, indexConfigOf, normalizePipelineFeatures } from "@docslurp/shared";

import { mergePipelineFeatures } from "../models.js";

/**
 * The index stage stamps `documents.index_config_hash` from the run's pipeline as the worker loads it
 * (`mergePipelineFeatures`); the API compares it with the hash of the workspace pipeline it normalizes
 * (`normalizePipelineFeatures`). Both routes must give the same hash for the same stored config.
 */
const stored: Array<[string, unknown]> = [
  ["null", null],
  ["empty", {}],
  ["defaults", defaultPipelineFeatures],
  ["partial embedding", { embedding: { target: "local", modelUri: "llm://transformers.js/Xenova/gte-small" } }],
  ["embedding profile only", { embedding: { profile: "good-fast-local" } }],
  ["custom dimensions", { embedding: { modelUri: "llm://openai/text-embedding-3-small", target: "hosted", dimensions: 512 } }],
  ["late chunking", { embedding: { lateChunking: true, lateChunkingWindow: 3 } }],
  ["chunk flags", { chunkOverlap: true, contextualChunkPreambles: false }],
  ["vector backends", { vectorBackends: ["lancedb"] }],
  ["unrelated fields", { summarize: true, graphRag: true }],
];

describe("index_config_hash parity between worker and API", () => {
  it.each(stored)("%s", (_name, source) => {
    const worker = indexConfigHash(indexConfigOf(mergePipelineFeatures(source as never)));
    const api = indexConfigHash(indexConfigOf(normalizePipelineFeatures(source as never)));
    expect(worker).toBe(api);
  });

  it("does not depend on unrelated features", () => {
    const a = indexConfigHash(indexConfigOf(normalizePipelineFeatures({ summarize: true })));
    const b = indexConfigHash(indexConfigOf(normalizePipelineFeatures({ summarize: false })));
    expect(a).toBe(b);
  });
});
