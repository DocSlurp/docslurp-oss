import { withModelProvenance } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
const { withCallConfig } = await import("../lib/ai.js");

describe("server text call settings", () => {
  it("put the call's settings on its usage metadata, under any the call already reported", () => {
    const usage = withCallConfig({ inputTokens: 10, outputTokens: 2, metadata: { costSource: "provider", modelConfig: { maxOutputTokens: 64 } } },
      { operation: "api.search.hyde", maxOutputTokens: 150, reasoningEffort: "none" });
    expect(usage.metadata).toEqual({ costSource: "provider", modelConfig: { operation: "api.search.hyde", maxOutputTokens: 64, reasoningEffort: "none" } });
    // Search helpers record `...result.usage`, so the settings reach the row and its URI.
    const event = withModelProvenance({ provider: "openrouter", model: "vendor/search-1", metadata: usage.metadata });
    expect(event.metadata?.modelUri).toBe("llm://openrouter/vendor/search-1?maxOutputTokens=64&operation=api.search.hyde&reasoningEffort=none");
  });
});
