import { describe, expect, it } from "vitest";
import { chatModelPromptAddendum } from "../chat-model-prompts.js";

describe("chat model prompt addenda", () => {
  it("adds Haiku's length guidance and nothing for other models", () => {
    expect(chatModelPromptAddendum("anthropic/claude-haiku-5.5")).toMatch(/^Length: answer only what the question asks/);
    // Only reviewed catalog variants inherit (nitroBaseModel); an unlisted suffix gets nothing.
    expect(chatModelPromptAddendum("anthropic/claude-haiku-5.5:nitro")).toBe("");
    // The length rule never suppresses the mandatory disclosures.
    expect(chatModelPromptAddendum("anthropic/claude-haiku-5.5")).toMatch(/never overrides .*failed or unavailable tools/);
    expect(chatModelPromptAddendum("openai/gpt-6-luna")).toBe("");
    expect(chatModelPromptAddendum("z-ai/glm-5.3-flash")).toBe("");
    expect(chatModelPromptAddendum(undefined)).toBe("");
  });
});
