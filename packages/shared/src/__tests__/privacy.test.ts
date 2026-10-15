import { describe, expect, it } from "vitest";

import {
  assertProviderAllowed,
  buildBlockedPrivacyAuditEntry,
  isPrivacyModeViolation,
  isProviderCallAllowed,
  normalizePipelineFeatures,
  pipelineFeaturesSchema,
  PrivacyModeViolationError,
  privacyModeAuditsBlockedCalls,
  resolveProviderTarget,
  workspaceTemplates,
} from "../index.js";

const hosted = { provider: "openrouter", model: "vendor/model", operation: "test.text" };
const local = { provider: "transformers.js", model: "Xenova/all-MiniLM-L6-v2", operation: "test.embed" };

describe("privacy guard", () => {
  it("classifies providers fail-closed", () => {
    expect(resolveProviderTarget({ provider: "transformers.js" })).toBe("local");
    expect(resolveProviderTarget({ provider: "ollama" })).toBe("local");
    expect(resolveProviderTarget({ provider: "openai" })).toBe("hosted");
    expect(resolveProviderTarget({ provider: "something-new" })).toBe("hosted");
    expect(resolveProviderTarget({ provider: "ollama", target: "hosted" })).toBe("hosted");
    expect(resolveProviderTarget({ provider: "vllm", modelUri: "llm://openrouter/x/y" })).toBe("hosted");
    expect(resolveProviderTarget({ provider: "vllm", modelUri: "not a uri" })).toBe("hosted");
  });

  it("allows hosted calls only in standard mode", () => {
    expect(isProviderCallAllowed("standard", hosted)).toBe(true);
    expect(isProviderCallAllowed(undefined, hosted)).toBe(true);
    expect(isProviderCallAllowed("local-only", hosted)).toBe(false);
    expect(isProviderCallAllowed("strict-privacy", hosted)).toBe(false);
    expect(isProviderCallAllowed("mystery-mode", hosted)).toBe(false);
    expect(isProviderCallAllowed("local-only", local)).toBe(true);
    expect(isProviderCallAllowed("strict-privacy", local)).toBe(true);
  });

  it("throws a typed violation for blocked calls", () => {
    expect(() => assertProviderAllowed("standard", hosted)).not.toThrow();
    expect(() => assertProviderAllowed("local-only", local)).not.toThrow();
    let caught: unknown;
    try {
      assertProviderAllowed("local-only", hosted);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PrivacyModeViolationError);
    expect(isPrivacyModeViolation(caught)).toBe(true);
    expect((caught as PrivacyModeViolationError).privacyMode).toBe("local-only");
  });

  it("audits only strict-privacy and marks rows as blocked", () => {
    expect(privacyModeAuditsBlockedCalls("strict-privacy")).toBe(true);
    expect(privacyModeAuditsBlockedCalls("local-only")).toBe(false);
    expect(buildBlockedPrivacyAuditEntry({ privacyMode: "strict-privacy", call: hosted, workspaceId: "ws", runId: "run" }))
      .toEqual({ workspaceId: "ws", runId: "run", documentId: null, modelId: "openrouter/vendor/model", endpoint: "blocked:test.text", privacyMode: "strict-privacy" });
  });
});

describe("privacyMode pipeline validation", () => {
  it("rejects hosted embeddings outside standard mode", () => {
    const result = pipelineFeaturesSchema.safeParse(
      { ...normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted" } }), privacyMode: "local-only" },
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path.join(".") === "embedding")).toBe(true);
    expect(() => normalizePipelineFeatures({ embedding: { profile: "cheapest-hosted" }, privacyMode: "standard" })).not.toThrow();
    expect(() => normalizePipelineFeatures({ embed: false, embedding: { profile: "cheapest-hosted" }, privacyMode: "local-only" })).not.toThrow();
  });

  it("rejects a hosted vision fallback outside standard mode", () => {
    expect(() => normalizePipelineFeatures({
      privacyMode: "strict-privacy",
      vision: { profile: "cheapest-local", remoteFallbackModelUri: "llm://openrouter/google/gemini-2.5-flash-lite" },
    })).toThrow();
  });

  it("keeps strict-privacy templates free of hosted routes", () => {
    const strict = workspaceTemplates.filter((template) => template.pipeline.privacyMode !== "standard");
    expect(strict.length).toBeGreaterThan(0);
    for (const template of strict) {
      expect(template.pipeline.embedding.target).toBe("local");
      expect(template.pipeline.vision.target).toBe("local");
      expect(template.pipeline.summarize).toBe(false);
      expect(template.pipeline.propositionIndex).toBe(false);
    }
  });
});
