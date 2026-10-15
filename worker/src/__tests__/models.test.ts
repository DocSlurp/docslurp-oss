import { describe, expect, it } from "vitest";

import { cloneArtifacts, cloneJsonMap, mergePipelineFeatures } from "../models.js";
import { defaultPipelineFeatures } from "@docslurp/shared";

// ---------------------------------------------------------------------------
// mergePipelineFeatures
// ---------------------------------------------------------------------------

describe("mergePipelineFeatures", () => {
  it("returns defaults when called with no arguments", () => {
    const result = mergePipelineFeatures();
    expect(result).toEqual(defaultPipelineFeatures);
  });

  it("returns defaults when called with null", () => {
    const result = mergePipelineFeatures(null);
    expect(result).toEqual(defaultPipelineFeatures);
  });

  it("returns defaults when called with undefined", () => {
    const result = mergePipelineFeatures(undefined);
    expect(result).toEqual(defaultPipelineFeatures);
  });

  it("overrides top-level boolean fields", () => {
    const result = mergePipelineFeatures({ embed: false, summarize: true });
    expect(result.embed).toBe(false);
    expect(result.summarize).toBe(true);
    // Unspecified fields retain defaults
    expect(result.htmlExtraction).toBe(defaultPipelineFeatures.htmlExtraction);
    expect(result.markdownExtraction).toBe(defaultPipelineFeatures.markdownExtraction);
  });

  it("deep-merges the embedding route without exposing runtime tuning", () => {
    const result = mergePipelineFeatures({
      embedding: {
        target: "local",
        modelUri: "llm://ollama/nomic-embed-text",
      },
    });
    expect(result.embedding.modelUri).toBe("llm://ollama/nomic-embed-text");
    expect(result.embedding.target).toBe("local");
    expect(result.embedding).not.toHaveProperty("dimensions");
    expect(result.embedding).not.toHaveProperty("batchSize");
  });

  it("deep-merges the vision sub-object", () => {
    const result = mergePipelineFeatures({
      vision: {
        profile: "cheapest-local",
        target: "local",
        modelUri: "llm://local-cli/microsoft/Florence-2-small-ft",
        prompt: "<OCR>",
        maxPagesPerDocument: 4,
        remoteFallbackModelUri: null,
        benchmarkProfile: "difficult-pages"
      }
    });

    expect(result.vision.target).toBe("local");
    expect(result.vision.modelUri).toBe("llm://local-cli/microsoft/Florence-2-small-ft");
    expect(result.vision.prompt).toBe(defaultPipelineFeatures.vision.prompt);
    expect(result.vision.remoteFallbackModelUri).toBe(defaultPipelineFeatures.vision.remoteFallbackModelUri);
  });

  it("uses the provided vectorBackends array when non-empty", () => {
    const result = mergePipelineFeatures({ vectorBackends: ["lancedb"] });
    expect(result.vectorBackends).toEqual(["lancedb"]);
  });

  it("falls back to default vectorBackends when source array is empty", () => {
    const result = mergePipelineFeatures({ vectorBackends: [] });
    expect(result.vectorBackends).toEqual(defaultPipelineFeatures.vectorBackends);
  });

  it("returns a new object and does not mutate the defaults", () => {
    const before = { ...defaultPipelineFeatures };
    const result = mergePipelineFeatures({ embed: false });
    expect(result).not.toBe(defaultPipelineFeatures);
    // defaults are unchanged
    expect(defaultPipelineFeatures.embed).toBe(before.embed);
  });

  it("clones vectorBackends so mutations don't affect the source", () => {
    const source = ["lancedb" as const];
    const result = mergePipelineFeatures({ vectorBackends: source });
    result.vectorBackends.push("orama");
    expect(source).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// cloneJsonMap
// ---------------------------------------------------------------------------

describe("cloneJsonMap", () => {
  it("returns an empty object for null", () => {
    expect(cloneJsonMap(null)).toEqual({});
  });

  it("returns an empty object for undefined", () => {
    expect(cloneJsonMap(undefined)).toEqual({});
  });

  it("returns an empty object when called with no arguments", () => {
    expect(cloneJsonMap()).toEqual({});
  });

  it("returns a shallow clone equal to the source", () => {
    const source = { a: 1, b: "two", c: true };
    const clone = cloneJsonMap(source);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
  });

  it("mutations to the clone do not affect the source", () => {
    const source = { x: 1 };
    const clone = cloneJsonMap(source);
    (clone as Record<string, unknown>)["x"] = 99;
    expect(source.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// cloneArtifacts
// ---------------------------------------------------------------------------

describe("cloneArtifacts", () => {
  it("returns an empty object for null", () => {
    expect(cloneArtifacts(null)).toEqual({});
  });

  it("returns an empty object for undefined", () => {
    expect(cloneArtifacts(undefined)).toEqual({});
  });

  it("returns a shallow clone equal to the source", () => {
    const source = { "page-1": "s3://bucket/file.png", "page-2": "s3://bucket/file2.png" };
    const clone = cloneArtifacts(source);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
  });

  it("mutations to the clone do not affect the source", () => {
    const source = { key: "s3://bucket/artifact" };
    const clone = cloneArtifacts(source);
    clone["key"] = "changed";
    expect(source["key"]).toBe("s3://bucket/artifact");
  });
});
