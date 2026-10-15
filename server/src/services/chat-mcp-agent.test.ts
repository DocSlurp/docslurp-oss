import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

const mocks = vi.hoisted(() => ({ provider: vi.fn(), record: vi.fn(), dispatch: vi.fn(), createDispatch: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: () => ({ chat: mocks.provider }) }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.record }));
vi.mock("../lib/posthog-ai-observability.js", () => ({ posthogAiTelemetry: () => ({}) }));
vi.mock("./mcp-tools.js", () => ({
  createMcpDispatcher: mocks.createDispatch,
  mcpManifest: () => ({ capabilities: [{ id: "workspace.search", title: "Search", description: "Retrieve", category: "tool", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }] }),
}));
vi.mock("@docslurp/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@docslurp/shared")>(),
  createOpenRouterUsageCapture: () => ({ fetch: vi.fn(), usage: () => undefined }),
  resolveOpenRouterUsage: async ({ usage }: { usage: { inputTokens: number; outputTokens: number } }) => ({ ...usage, costCents: 0.01 }),
}));
const { runChatMcpAgent } = await import("./chat-mcp-agent.js");
const actor = { type: "session" as const, userId: "user", sessionId: "browser-session", user: { id: "user", name: "User", email: "" } };
const args = { actor, workspaceId: "ws", orgId: "org", sessionId: "conversation", query: "What is the policy?", history: [], apiKey: "fake", privacyMode: "standard" as const, model: "test", maxOutputTokens: 100 };

function step(toolCall: boolean): Awaited<ReturnType<MockLanguageModelV4["doStream"]>> {
  return { stream: simulateReadableStream({ chunks: [
    { type: "stream-start", warnings: [] },
    ...(toolCall ? [{ type: "tool-call" as const, toolCallId: "call", toolName: "workspace_search", input: '{"q":"policy"}' }]
      : [{ type: "text-start" as const, id: "text" }, { type: "text-delta" as const, id: "text", delta: "The policy is supported [1]." }, { type: "text-end" as const, id: "text" }]),
    { type: "finish", finishReason: { unified: toolCall ? "tool-calls" : "stop", raw: undefined },
      usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } } },
  ], initialDelayInMs: 0, chunkDelayInMs: 0 }) };
}

beforeEach(() => {
  mocks.record.mockReset(); mocks.dispatch.mockReset(); mocks.createDispatch.mockReset();
  mocks.createDispatch.mockReturnValue(mocks.dispatch);
  mocks.dispatch.mockResolvedValue(Response.json({ results: [{ text: "The policy is supported.", score: 1, citation: { filename: "policy.pdf", documentId: "doc", chunkIndex: 0, headingPath: [], pageNumber: 1 } }] }));
});

describe("chat MCP agent with the real SDK loop", () => {
  it("passes tool results into the next turn, streams the answer, and persists every model step", async () => {
    const model = new MockLanguageModelV4({ doStream: [step(true), step(false)] });
    mocks.provider.mockReturnValue(model);
    const deltas: string[] = [];
    const result = await runChatMcpAgent({ ...args, workspaceInstructions: "Preserve original headings.", onTextDelta: delta => { deltas.push(delta); } });
    expect(mocks.createDispatch).toHaveBeenCalledWith(actor);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain("Preserve original headings.");
    expect(JSON.stringify(model.doStreamCalls[1]!.prompt)).toContain("The policy is supported.");
    expect(result.answer).toBe(deltas.join(""));
    expect(result.citations).toHaveLength(1);
    expect(result.toolCalls).toMatchObject([{ name: "workspace.search", status: "success" }]);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    for (const [entry] of mocks.record.mock.calls) {
      expect(entry).toMatchObject({ userId: "user", scope: { workspaceId: "ws", orgId: "org", sessionId: "conversation" }, usage: { inputTokens: 10, outputTokens: 4 } });
    }
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 8, totalTokens: 28 });
  });

  it("does not retry model failures or lose usage from earlier completed steps", async () => {
    let calls = 0;
    mocks.provider.mockReturnValue(new MockLanguageModelV4({ doStream: async () => {
      if (calls++ === 0) return step(true);
      throw new Error("Provider unavailable");
    } }));
    await expect(runChatMcpAgent(args)).rejects.toThrow("Provider unavailable");
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });
});
