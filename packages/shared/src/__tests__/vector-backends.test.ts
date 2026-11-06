import { describe, expect, it } from "vitest";

import {
  assertSupportedVectorBackends,
  defaultPipelineFeatures,
  normalizePipelineFeatures,
  pipelineFeaturesSchema,
  SUPPORTED_VECTOR_BACKENDS,
  UnsupportedVectorBackendError,
  vectorBackendSchema,
} from "../index.js";

/** Chroma was removed (owner decision 2026-11-05): a config naming it is refused loudly at parse, never rerouted. */
describe("vector backend validation", () => {
  it("accepts lancedb, orama and milvus only", () => {
    expect([...SUPPORTED_VECTOR_BACKENDS]).toEqual(["lancedb", "orama", "milvus"]);
    expect(vectorBackendSchema.options).toEqual(["lancedb", "orama", "milvus"]);
  });

  it("refuses chroma in API input and stored pipelines with an unsupported-vector-backend error", () => {
    const parsed = vectorBackendSchema.safeParse("chroma");
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("unsupported vector backend: chroma (supported: lancedb, orama, milvus; Chroma support was removed)");
    // A stored project pipeline (normalizePipelineFeatures) and a full pipeline (the API's schema) naming it both fail.
    expect(() => normalizePipelineFeatures({ vectorBackends: ["chroma"] } as never)).toThrow(/unsupported vector backend: chroma/);
    expect(() => pipelineFeaturesSchema.parse({ ...defaultPipelineFeatures, vectorBackends: ["lancedb", "chroma"] })).toThrow(/unsupported vector backend: chroma/);
  });

  it("assertSupportedVectorBackends normalizes, de-duplicates and refuses, never filters", () => {
    expect(assertSupportedVectorBackends([" LanceDB", "milvus", "lancedb", ""], "VECTOR_BACKENDS")).toEqual(["lancedb", "milvus"]);
    expect(() => assertSupportedVectorBackends(["lancedb", "Chroma"], "VECTOR_BACKENDS")).toThrow(UnsupportedVectorBackendError);
    expect(() => assertSupportedVectorBackends(["chroma"], "VECTOR_BACKENDS")).toThrow("VECTOR_BACKENDS: unsupported vector backend: chroma");
  });
});
