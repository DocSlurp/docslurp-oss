import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ recordUsageEvent: vi.fn(async () => null) }));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: vi.fn(async () => undefined) }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.recordUsageEvent }));

const {
  configuredOutputModerator, LLAMA_GUARD_MODEL, llamaGuardOutputModerator, MODERATED_ANSWER, MODERATION_UNAVAILABLE_ANSWER, moderateChatAnswer, moderationAppliesTo, noopOutputModerator,
} = await import("../services/chat-output-moderation.js");

const browserKey = { type: "apiKey", userId: "u", apiKey: { keyId: "pub-1", userId: "u", orgId: "org-1", keyType: "client", scopes: ["chat"], workspaceIds: ["ws-1"], rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [] } } as never;
const serverKey = { type: "apiKey", userId: "u", apiKey: { keyId: "k", userId: "u", orgId: "org-1", keyType: "server", scopes: ["chat"], workspaceIds: [], rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [] } } as never;
const appSession = { type: "session", userId: "u", sessionId: "s", user: { id: "u", email: "", name: "" } } as never;
const response = { id: "a", sessionId: "chat-1", answer: "Here is how [1].", citations: [{ text: "x" }], evidenceSpans: [{}] } as unknown as import("@docslurp/shared").WorkspaceChatResponse;

function guardFetch(content: string) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(LLAMA_GUARD_MODEL);
    expect(body.provider).toEqual({ only: ["deepinfra"], allow_fallbacks: false, data_collection: "deny" });
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 800, completion_tokens: 5 } }), { status: 200 });
  });
}

beforeEach(() => mocks.recordUsageEvent.mockClear());

describe("output moderation", () => {
  it("is off by default and rejects unknown modes", () => {
    expect(configuredOutputModerator({})).toBeNull();
    expect(configuredOutputModerator({ CHAT_OUTPUT_MODERATION: "off" })).toBeNull();
    expect(() => configuredOutputModerator({ CHAT_OUTPUT_MODERATION: "llama-guard" })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => configuredOutputModerator({ CHAT_OUTPUT_MODERATION: "magic" })).toThrow(/Unknown/);
    expect(configuredOutputModerator({ CHAT_OUTPUT_MODERATION: "llama-guard", OPENROUTER_API_KEY: "k" })?.name).toBe("llama-guard-4");
  });

  it("applies only to public browser-key answers", () => {
    expect(moderationAppliesTo(browserKey)).toBe(true);
    expect(moderationAppliesTo(serverKey)).toBe(false);
    expect(moderationAppliesTo(appSession)).toBe(false);
  });

  it("parses Llama Guard verdicts and prices from token counts", async () => {
    const unsafe = await llamaGuardOutputModerator({ apiKey: "k", fetch: guardFetch("unsafe\nS1,S9") as never }).moderate({ question: "q", answer: "a" });
    expect(unsafe).toMatchObject({ flagged: true, categories: ["S1", "S9"], usage: { inputTokens: 800, outputTokens: 5 } });
    // 805 tokens x $0.18 per 1M = $0.0001449 = 0.01449 cents.
    expect(unsafe.usage?.costCents).toBeCloseTo(0.01449, 5);
    const safe = await llamaGuardOutputModerator({ apiKey: "k", fetch: guardFetch("safe") as never }).moderate({ question: "q", answer: "a" });
    expect(safe.flagged).toBe(false);
  });

  it("replaces a flagged public answer, drops citations and records usage with scope", async () => {
    const moderator = llamaGuardOutputModerator({ apiKey: "k", fetch: guardFetch("unsafe\nS9") as never });
    const out = await moderateChatAnswer(response, { actor: browserKey, question: "q", userId: "u", workspaceId: "ws-1", orgId: "org-1", privacyMode: "standard", moderator });
    expect(out).toMatchObject({ answer: MODERATED_ANSWER, citations: [], evidenceSpans: [] });
    expect(mocks.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      scope: { orgId: "org-1", workspaceId: "ws-1", sessionId: "chat-1" },
      usage: expect.objectContaining({ metric: "chat-output-moderation", model: LLAMA_GUARD_MODEL, inputTokens: 800, outputTokens: 5 }),
    }));
  });

  it("preserves private callers and withholds public answers when checks cannot run", async () => {
    const moderate = vi.fn();
    const moderator = { name: "test", moderate };
    for (const actor of [appSession, serverKey]) {
      expect(await moderateChatAnswer(response, { actor, question: "q", userId: "u", workspaceId: "ws-1", privacyMode: "standard", moderator })).toBe(response);
    }
    expect(await moderateChatAnswer(response, { actor: browserKey, question: "q", userId: "u", workspaceId: "ws-1", privacyMode: "local-only", moderator })).toMatchObject({ answer: MODERATION_UNAVAILABLE_ANSWER, citations: [] });
    expect(moderate).not.toHaveBeenCalled();
    moderate.mockRejectedValueOnce(new Error("timeout"));
    expect(await moderateChatAnswer(response, { actor: browserKey, question: "q", userId: "u", workspaceId: "ws-1", privacyMode: "standard", moderator })).toMatchObject({ answer: MODERATION_UNAVAILABLE_ANSWER, citations: [] });
    expect(await moderateChatAnswer(response, { actor: browserKey, question: "q", userId: "u", workspaceId: "ws-1", privacyMode: "standard", moderator: noopOutputModerator })).toBe(response);
  });
});


describe("moderation boundary failures", () => {
  it.each(["", "sure", "uns", "safe extra", "unsafe nonsense"])("withholds malformed verdict %j and still records reported usage", async content => {
    const moderator = llamaGuardOutputModerator({ apiKey: "k", fetch: guardFetch(content) as never });
    const out = await moderateChatAnswer(response, { actor: browserKey, question: "q", userId: "u", workspaceId: "ws-1", privacyMode: "standard", moderator });
    expect(out).toMatchObject({ answer: MODERATION_UNAVAILABLE_ANSWER, citations: [] });
    expect(mocks.recordUsageEvent).toHaveBeenCalled();
  });
  it("refuses an oversized answer before sending any truncated content", async () => {
    const fetch = vi.fn();
    const moderator = llamaGuardOutputModerator({ apiKey: "k", fetch });
    const out = await moderateChatAnswer({ ...response, answer: "a".repeat(16_001) }, { actor: browserKey, question: "q", userId: "u", workspaceId: "ws-1", privacyMode: "standard", moderator });
    expect(out).toMatchObject({ answer: MODERATION_UNAVAILABLE_ANSWER });
    expect(fetch).not.toHaveBeenCalled();
  });
});
