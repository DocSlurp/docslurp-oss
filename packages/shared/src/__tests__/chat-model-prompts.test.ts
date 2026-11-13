import { describe, expect, it } from "vitest";
import { chatModelPromptAddendum } from "../chat-model-prompts.js";

describe("chat model prompt addenda", () => {
  it("adds Haiku's length guidance, also for its Nitro variant, and nothing for other models", () => {
    expect(chatModelPromptAddendum("anthropic/claude-haiku-5.5")).toMatch(/^Length: answer only what the question asks/);
    expect(chatModelPromptAddendum("anthropic/claude-haiku-5.5:nitro")).toBe(chatModelPromptAddendum("anthropic/claude-haiku-5.5"));
    // The length rule never suppresses the mandatory disclosures.
    expect(chatModelPromptAddendum("anthropic/claude-haiku-5.5")).toMatch(/never overrides .*failed or unavailable tools/);
    expect(chatModelPromptAddendum("openai/gpt-6-luna")).toBe("");
    expect(chatModelPromptAddendum("z-ai/glm-5.3-flash")).toBe("");
    expect(chatModelPromptAddendum(undefined)).toBe("");
  });
});
