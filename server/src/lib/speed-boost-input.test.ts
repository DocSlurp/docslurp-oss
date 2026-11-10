import { describe, expect, it } from "vitest";
import { projectChatInputSchema } from "./search-input.js";
import { normalizePipelineFeatures, pipelineFeatureOverridesSchema } from "@docslurp/shared";

describe("Speed boost opt-in contracts", () => {
  it.each([undefined, false, true])("accepts only explicit true as on (%s)", (speedBoost) => {
    expect((projectChatInputSchema.parse({ q: "Hello", speedBoost }).speedBoost ?? false)).toBe(speedBoost === true);
    expect(normalizePipelineFeatures({ speedBoost }).speedBoost).toBe(speedBoost === true);
  });
  it.each(["true", "false", 1, null, {}, []])("rejects malformed JSON flag %j", (speedBoost) => {
    expect(projectChatInputSchema.safeParse({ q: "Hello", speedBoost }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ speedBoost }).success).toBe(false);
  });
});
