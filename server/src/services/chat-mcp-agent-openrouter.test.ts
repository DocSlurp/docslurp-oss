import { afterEach, expect, it, vi } from "vitest";

// Real OpenAI-compatible provider and OpenRouter usage capture; only the network is faked.
const record = vi.fn();
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: record }));
vi.mock("../lib/privacy.js", () => ({ allowHostedCallForWorkspace: vi.fn(async () => true), loadWorkspacePrivacyMode: vi.fn(async () => "standard"), openRouterCall: vi.fn() }));
vi.mock("./workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => ({ id: "ws" })) }));
vi.mock("../lib/posthog-ai-observability.js", () => ({ posthogAiTelemetry: () => ({}) }));
vi.mock("./mcp-tools.js", () => ({ createMcpDispatcher: () => vi.fn(), mcpManifest: () => ({ capabilities: [] }) }));
const { runChatMcpAgent } = await import("./chat-mcp-agent.js");

afterEach(() => { vi.unstubAllGlobals(); record.mockReset(); });

/** Shape of an OpenRouter streamed chat completion for an alias that routed to a dated build. */
function openRouterStream(model: string): Response {
  const base = { id: "gen-1760900000-abc", provider: "DeepSeek", model, object: "chat.completion.chunk", created: 1760900000, system_fingerprint: null };
  const chunks = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null, native_finish_reason: null, logprobs: null }] },
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: " there." }, finish_reason: null, native_finish_reason: null, logprobs: null }] },
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop", native_finish_reason: "stop", logprobs: null }] },
    { ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 6, total_tokens: 126, cost: 0.0000216, is_byok: false,
      prompt_tokens_details: { cached_tokens: 0 }, cost_details: { upstream_inference_cost: null }, completion_tokens_details: { reasoning_tokens: 0 } } },
  ];
  const body = [": OPENROUTER PROCESSING", ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}`), "data: [DONE]"].join("\n\n") + "\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

it("reports the routed OpenRouter build as resolvedModel, not the requested alias", async () => {
  const fetchMock = vi.fn(async () => openRouterStream("deepseek/deepseek-v4.1-flash-20261017"));
  vi.stubGlobal("fetch", fetchMock);
  const result = await runChatMcpAgent({
    actor: { type: "session", userId: "user", sessionId: "s", user: { id: "user", name: "User", email: "" } },
    workspaceId: "ws", orgId: "org", sessionId: "conversation", query: "Say hello", history: [], apiKey: "fake",
    privacyMode: "standard", model: "deepseek/deepseek-v4.1-flash", maxOutputTokens: 100,
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).model).toBe("deepseek/deepseek-v4.1-flash");
  expect(result.answer).toBe("Hello there.");
  expect(result.debug).toMatchObject({ resolvedModel: "deepseek/deepseek-v4.1-flash-20261017", resolvedProvider: "DeepSeek",
    stepUsage: [{ step: 0, model: "deepseek/deepseek-v4.1-flash-20261017", inputTokens: 120, outputTokens: 6 }] });
  expect(result.usage.costCents).toBeCloseTo(0.00216, 10);
  expect(record.mock.calls[0]![0].usage.metadata).toMatchObject({ responseModel: "deepseek/deepseek-v4.1-flash-20261017", costSource: "provider" });
});
