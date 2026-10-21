import { describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

/**
 * A client that disconnects mid-turn must stop the agent: the model loop, the
 * in-flight tool and everything nested under it. Real HTTP, a real socket
 * close (like killing curl), and a host layer that re-creates the Request the
 * way the in-process Astro mount does, with garbage collection forced so a
 * dropped intermediate Request would break the abort chain.
 */
const mocks = vi.hoisted(() => ({ provider: vi.fn(), record: vi.fn(), dispatch: vi.fn() }));
vi.mock("../lib/chat-agent-model.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/chat-agent-model.js")>(),
  createChatAgentModel: () => mocks.provider(),
}));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.record }));
vi.mock("../search/query-bounds.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  const store = new AsyncLocalStorage<{ signal?: AbortSignal }>();
  return { withSearchSignal: <T>(signal: AbortSignal | undefined, fn: () => Promise<T>) => store.run({ signal }, fn), currentSearchSignal: () => store.getStore()?.signal };
});
vi.mock("../lib/privacy.js", () => ({ allowHostedCallForWorkspace: vi.fn(async () => true), loadWorkspacePrivacyMode: vi.fn(async () => "standard"), openRouterCall: vi.fn() }));
vi.mock("../services/workspaces.js", () => ({ resolveWorkspaceRef: vi.fn(async () => ({ id: "ws" })) }));
vi.mock("../lib/posthog-ai-observability.js", () => ({ posthogAiTelemetry: () => ({}) }));
vi.mock("../services/mcp-tools.js", () => ({
  createMcpDispatcher: () => mocks.dispatch,
  mcpManifest: () => ({ capabilities: [{ id: "search", title: "Search", description: "Retrieve", category: "tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } }] }),
}));
vi.mock("@docslurp/shared", async importOriginal => ({
  ...await importOriginal<typeof import("@docslurp/shared")>(),
  createOpenRouterUsageCapture: () => ({ fetch: vi.fn(), usage: () => undefined, providerName: () => undefined }),
  resolveOpenRouterUsage: async ({ usage }: { usage: { inputTokens: number; outputTokens: number } }) => ({ ...usage, costCents: 0.01 }),
}));

const { runChatMcpAgent } = await import("../services/chat-mcp-agent.js");
const { forwardRequest } = await import("../lib/forward-request.js");
const { currentSearchSignal } = await import("../search/query-bounds.js");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const actor = { type: "session" as const, userId: "user", sessionId: "browser", user: { id: "user", name: "User", email: "" } };
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 4, text: 4, reasoning: 0 } };

describe("chat agent client disconnect over HTTP", () => {
  it("stops the agent, its tool and nested search when the client socket closes", async () => {
    const model = new MockLanguageModelV4({ doStream: [
      { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "tool-call", toolCallId: "t1", toolName: "search", input: '{"q":"policy"}' },
        { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
      ], initialDelayInMs: 0, chunkDelayInMs: 0 }) },
    ] });
    mocks.provider.mockReturnValue(model);
    const nested: { signal?: AbortSignal; searchSignal?: AbortSignal } = {};
    let dispatched!: () => void;
    const dispatchedPromise = new Promise<void>(resolve => { dispatched = resolve; });
    mocks.dispatch.mockImplementation(async (_path: string, init: RequestInit) => {
      nested.signal = init.signal!;
      nested.searchSignal = currentSearchSignal();
      dispatched();
      // A slow search that only ends when cancelled.
      return await new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
    });

    let turn!: Promise<unknown>;
    const api = new Hono().post("/v1/chat", async (c) => {
      turn = runChatMcpAgent({ actor, workspaceId: "ws", orgId: "org", sessionId: "chat", query: "What is the policy?", history: [],
        apiKey: "fake", privacyMode: "standard", model: "test", maxOutputTokens: 100, signal: c.req.raw.signal, abortedStepLookupDelayMs: 0 });
      await turn.catch(() => undefined);
      return c.json({ ok: true });
    });
    // The host layer: re-create the Request with new headers, as the app's API proxy does.
    const server = serve({ fetch: (request: Request) => api.fetch(forwardRequest(request, { headers: new Headers(request.headers) })), port: 0, hostname: "127.0.0.1" });
    await new Promise<void>(resolve => server.once("listening", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat", headers: { "content-type": "application/json" } });
      client.on("error", () => undefined);
      client.end(JSON.stringify({ q: "What is the policy?" }));
      await dispatchedPromise;
      for (let i = 0; i < 3; i++) { gc(); await new Promise(resolve => setTimeout(resolve, 10)); }
      const closedAt = Date.now();
      client.destroy();
      await expect(turn).rejects.toBeDefined();
      expect(Date.now() - closedAt).toBeLessThan(2_000);
      expect(nested.signal?.aborted).toBe(true);
      expect(nested.searchSignal?.aborted).toBe(true);
      expect(model.doStreamCalls).toHaveLength(1);
      // The step that returned the tool call was billed by the provider; it is still recorded.
      expect(mocks.record).toHaveBeenCalledTimes(1);
      expect(mocks.record.mock.calls[0]![0].usage.metadata).toMatchObject({ turnOutcome: "aborted", abortReason: "client_disconnect" });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe("forwardRequest", () => {
  it("keeps the client's abort after garbage collection", async () => {
    const client = new AbortController();
    const original = new Request("http://app.local/v1/chat", { method: "POST", body: "{}", signal: client.signal, duplex: "half" } as RequestInit);
    const forwarded = forwardRequest(original, { url: "http://app.local/v1/chat?x=1", headers: { "x-request-id": "r1" } });
    for (let i = 0; i < 3; i++) { gc(); await new Promise(resolve => setTimeout(resolve, 10)); }
    client.abort();
    expect(forwarded.signal.aborted).toBe(true);
    expect(forwarded.headers.get("x-request-id")).toBe("r1");
    expect(forwarded.url).toBe("http://app.local/v1/chat?x=1");
    expect(await forwarded.text()).toBe("{}");
  });
});
