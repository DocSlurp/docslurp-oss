import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures, normalizePipelineFeatures } from "@docslurp/shared";

import {
  seedPipelineFromProcessingDefaults,
  seedSearchSettingsFromProcessingDefaults,
} from "../services/processing-defaults.js";

describe("processing defaults", () => {
  it("leaves the pipeline alone without saved defaults", () => {
    expect(seedPipelineFromProcessingDefaults(defaultPipelineFeatures, null)).toBe(defaultPipelineFeatures);
  });

  it("switches on the opt-in features the user chose", () => {
    const pipeline = seedPipelineFromProcessingDefaults(defaultPipelineFeatures, {
      enableGraphRag: true,
      enableSummarization: true,
      piiReviewMode: true,
      contextualChunking: false,
    });
    expect(pipeline).toMatchObject({ graphRag: true, summarize: true, contextualChunkPreambles: false });
    expect(pipeline.piiPolicy).toMatchObject({ enabled: true, action: "flag_for_review" });
  });

  it("never weakens a stronger PII action or turns a template feature off", () => {
    const base = normalizePipelineFeatures({ summarize: true, piiPolicy: { enabled: true, action: "block_indexing" } });
    const pipeline = seedPipelineFromProcessingDefaults(base, { enableSummarization: false, piiReviewMode: true });
    expect(pipeline.summarize).toBe(true);
    expect(pipeline.piiPolicy.action).toBe("block_indexing");
  });

  it("skips GraphRAG when the pipeline does not embed", () => {
    const base = normalizePipelineFeatures({ embed: false, indexVectors: false });
    expect(seedPipelineFromProcessingDefaults(base, { enableGraphRag: true }).graphRag).toBe(false);
  });

  it("seeds the chat answer style only when it differs from the default", () => {
    expect(seedSearchSettingsFromProcessingDefaults({ defaultAnswerStyle: "balanced" })).toBeNull();
    expect(seedSearchSettingsFromProcessingDefaults({ defaultAnswerStyle: "concise" })).toEqual({ chat: { answerStyle: "concise" } });
  });
});
