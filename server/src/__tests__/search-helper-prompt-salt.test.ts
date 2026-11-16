import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Organization isolation for provider prompt caches: search helper prompts (rewrites, HyDE, compression, planning)
 * carry tenant queries and chunk text, and providers cache repeated prefixes automatically. Each prompt goes after
 * its organization's salt line, so identical text from two organizations never shares a cached prefix.
 */
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("ai")>()), generateText: generateTextMock }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => (model: string) => ({ model }) }));
vi.mock("@docslurp/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@docslurp/shared")>()),
  resolveOpenRouterUsage: async () => ({ inputTokens: 1, outputTokens: 1, costCents: 0, metadata: {} }),
}));

const { generateOpenRouterText } = await import("../lib/ai.js");

async function systemFor(orgId: string | null): Promise<string> {
  generateTextMock.mockClear();
  generateTextMock.mockResolvedValue({ text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, response: { id: "g" } });
  await generateOpenRouterText({ apiKey: "k", privacyMode: "standard", prompt: "identical tenant query and chunk text", maxOutputTokens: 8, orgId });
  return generateTextMock.mock.calls[0]![0].system as string;
}

describe("search helper prompt salt", () => {
  beforeEach(() => generateTextMock.mockReset());

  it("is stable within one organization and differs across organizations", async () => {
    const a1 = await systemFor("org-a");
    expect(a1).toMatch(/^Workspace [0-9a-f]{16}\.$/);
    expect(await systemFor("org-a")).toBe(a1);
    expect(await systemFor("org-b")).not.toBe(a1);
  });

  it("is random without an organization, so nothing is shared", async () => {
    expect(await systemFor(null)).not.toBe(await systemFor(null));
  });

  it("puts the tenant text after the salt (the prompt is never part of the system prefix)", async () => {
    await systemFor("org-a");
    expect(generateTextMock.mock.calls[0]![0].prompt).toBe("identical tenant query and chunk text");
  });
});
