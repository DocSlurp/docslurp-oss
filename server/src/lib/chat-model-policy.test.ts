import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./request-actor.js", () => ({ isPlatformAdminActor: vi.fn(async (actor?: { admin?: boolean }) => actor?.admin === true) }));
const getProjectAccess = vi.fn(async (projectId: string) => ({ projectId, orgId: projectId === "ws-eval" ? "org-eval" : "org-other" }));
vi.mock("../services/organizations.js", () => ({ getProjectAccess }));

const {
  ChatModelNotAllowedError, chatEvalAccess, chatModelRefused, chatTurnNeedsEvalAccess, configuredChatEvalModels, parseChatEvalModels,
  resolveChatAgentLimits, resolveChatModelRequest, resolveSpeedBoostChatModel,
} = await import("./chat-model-policy.js");
const { chatAgentProviderOptions } = await import("../services/chat-mcp-agent.js");

const evalModels = new Set(["liquid/lfm-2.5-24b-a2b", "minimax/minimax-m3.1-flash:free"]);

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("DOCSLURP_CHAT_EVAL_MODELS", () => {
  it("admits priced OpenRouter ids and rejects retired, prohibited, unpriced and malformed ids", () => {
    const { models, rejected } = parseChatEvalModels(
      " liquid/lfm-2.5-24b-a2b, minimax/minimax-m3.1-flash:free,liquid/lfm-2.5-24b-a2b, openai/gpt-6-sol-pro, acme/ultra-1, acme/unpriced-model, not a model, openai/gpt-6-astra",
    );
    expect(models).toEqual(["liquid/lfm-2.5-24b-a2b"]);
    expect(rejected).toEqual([
      { id: "minimax/minimax-m3.1-flash:free", reason: "missing-price" },
      { id: "openai/gpt-6-sol-pro", reason: "prohibited-model" },
      { id: "acme/ultra-1", reason: "prohibited-model" },
      { id: "acme/unpriced-model", reason: "missing-price" },
      { id: "not a model", reason: "invalid-id" },
      { id: "openai/gpt-6-astra", reason: "missing-price" },
    ]);
  });

  it("logs each rejection with its reason when the configuration loads and never admits it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const models = configuredChatEvalModels("qwen/qwen3.8-max-prime,openai/gpt-6-luna-pro");
    expect([...models]).toEqual(["qwen/qwen3.8-max-prime"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("model=openai/gpt-6-luna-pro reason=prohibited-model"));
    expect(configuredChatEvalModels("qwen/qwen3.8-max-prime,openai/gpt-6-luna-pro")).toBe(models);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("chat model resolution", () => {
  it("uses the default only when model is omitted and honours catalog models for everyone", () => {
    expect(resolveChatModelRequest({ requested: undefined, isAdmin: false, evalModels })).toMatchObject({ model: "z-ai/glm-5.3-flash", source: "default" });
    expect(resolveChatModelRequest({ requested: "  ", isAdmin: false, evalModels }).source).toBe("default");
    expect(resolveChatModelRequest({ requested: "anthropic/claude-haiku-5.5", isAdmin: false, evalModels })).toMatchObject({ model: "anthropic/claude-haiku-5.5", source: "catalog" });
  });

  it("refuses unknown models instead of silently falling back", () => {
    expect(() => resolveChatModelRequest({ requested: "deepseek/deepseek-v4-flash", isAdmin: true, evalModels })).toThrow(ChatModelNotAllowedError);
    const error = (() => { try { resolveChatModelRequest({ requested: "missing/model", isAdmin: false, evalModels }); } catch (caught) { return caught; } })();
    expect(error).toMatchObject({ status: 400, code: "model_not_allowed" });
  });

  it("accepts llm://openrouter/<id> wherever a bare id works, resolving to the bare id", () => {
    expect(resolveChatModelRequest({ requested: " llm://openrouter/anthropic/claude-haiku-5.5 ", isAdmin: false, evalModels })).toMatchObject({ model: "anthropic/claude-haiku-5.5", source: "catalog" });
    expect(resolveChatModelRequest({ requested: "LLM://OpenRouter/z-ai/glm-5.3-flash:nitro", isAdmin: false, evalModels })).toMatchObject({ model: "z-ai/glm-5.3-flash:nitro", source: "catalog" });
    expect(resolveChatModelRequest({ requested: "llm://openrouter/liquid/lfm-2.5-24b-a2b", isAdmin: true, evalModels })).toMatchObject({ model: "liquid/lfm-2.5-24b-a2b", source: "eval" });
    expect(chatTurnNeedsEvalAccess("llm://openrouter/anthropic/claude-haiku-5.5")).toBe(false);
    expect(chatTurnNeedsEvalAccess("llm://openrouter/liquid/lfm-2.5-24b-a2b")).toBe(true);
    expect(parseChatEvalModels("llm://openrouter/liquid/lfm-2.5-24b-a2b").models).toEqual(["liquid/lfm-2.5-24b-a2b"]);
  });

  it("refuses llm:// URIs that do not name an allowed hosted chat model", () => {
    for (const requested of [
      "llm://openrouter/", "llm://openrouter/anthropic/claude-haiku-5.5?x=1", "llm://openrouter/anthropic/claude-haiku-5.5#a",
      "llm://anthropic/claude-haiku-5.5", "llm://private/gpu1/anthropic/claude-haiku-5.5", "llm://openrouter/openai/gpt-6-sol-pro",
      "llm://openrouter/liquid/lfm-2.5-24b-a2b",
    ]) {
      expect(() => resolveChatModelRequest({ requested, isAdmin: false, evalModels }), requested).toThrow(ChatModelNotAllowedError);
    }
    expect(() => resolveChatModelRequest({ requested: "llm://openrouter/openai/gpt-6-sol-pro", isAdmin: true, evalModels: new Set(["openai/gpt-6-sol-pro"]) })).toThrow(ChatModelNotAllowedError);
  });

  it("allows eval models to admins only", () => {
    expect(resolveChatModelRequest({ requested: "liquid/lfm-2.5-24b-a2b", isAdmin: true, evalModels })).toMatchObject({ model: "liquid/lfm-2.5-24b-a2b", source: "eval" });
    expect(() => resolveChatModelRequest({ requested: "liquid/lfm-2.5-24b-a2b", isAdmin: false, evalModels })).toThrow(ChatModelNotAllowedError);
  });

  it("never admits a prohibited id even if it reaches the allowlist", () => {
    expect(() => resolveChatModelRequest({ requested: "openai/gpt-6-sol-pro", isAdmin: true, evalModels: new Set(["openai/gpt-6-sol-pro"]) })).toThrow(ChatModelNotAllowedError);
  });

  it("reads the allowlist from the environment for route pre-checks", async () => {
    vi.stubEnv("DOCSLURP_CHAT_EVAL_MODELS", "xiaomi/mimo-v2.6-flash");
    expect(await chatModelRefused({ admin: true } as never, "xiaomi/mimo-v2.6-flash")).toBe(false);
    expect(await chatModelRefused({ admin: false } as never, "xiaomi/mimo-v2.6-flash")).toBe(true);
    expect(await chatModelRefused(undefined, undefined)).toBe(false);
    expect(await chatModelRefused(undefined, "unknown/model")).toBe(true);
  });

  it("asks for reasoning only when the model reference requests it", () => {
    for (const model of ["deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash"]) {
      expect(chatAgentProviderOptions(model)).toBeUndefined();
      expect(chatAgentProviderOptions(model, "none")).toBeUndefined();
      expect(chatAgentProviderOptions(model, "high")).toEqual({ openrouter: { reasoning: { effort: "high" } } });
    }
  });

  it("reads the reasoning level from the model reference's options", () => {
    expect(resolveChatModelRequest({ requested: undefined, isAdmin: false })).toMatchObject({ model: "z-ai/glm-5.3-flash", reasoning: "none" });
    expect(resolveChatModelRequest({ requested: "llm://openrouter/deepseek/deepseek-v4.1-flash-1017?reasoning=high", isAdmin: false }))
      .toEqual({ model: "deepseek/deepseek-v4.1-flash-1017", source: "catalog", reasoning: "high" });
    expect(resolveChatModelRequest({ requested: "z-ai/glm-5.3-flash?effort=low", isAdmin: false })).toMatchObject({ model: "z-ai/glm-5.3-flash", reasoning: "low" });
    expect(resolveChatModelRequest({ requested: "z-ai/glm-5.3-flash?reasoning_effort=minimal", isAdmin: false })).toMatchObject({ reasoning: "minimal" });
    expect(resolveChatModelRequest({ requested: "z-ai/glm-5.3-flash?reasoning=off", isAdmin: false })).toMatchObject({ reasoning: "none" });
    for (const requested of ["z-ai/glm-5.3-flash?reasoning=max", "z-ai/glm-5.3-flash?temperature=2", "z-ai/glm-5.3-flash?reasoning=low&effort=high", "z-ai/glm-5.3-flash#x"]) {
      expect(() => resolveChatModelRequest({ requested, isAdmin: true, evalModels: new Set() }), requested).toThrow(ChatModelNotAllowedError);
    }
  });
});

describe("agent limits", () => {
  it("defaults to 8 steps, 16 tool calls and search concurrency 6", () => {
    expect(resolveChatAgentLimits(undefined, false)).toEqual({ maxSteps: 8, baseSteps: 4, maxToolCalls: 16, searchConcurrency: 6, clamped: [] });
  });

  it("lets non-admins lower limits but clamps raised ones to the defaults", () => {
    expect(resolveChatAgentLimits({ maxSteps: 2, maxToolCalls: 3, searchConcurrency: 1 }, false)).toEqual({ maxSteps: 2, baseSteps: 2, maxToolCalls: 3, searchConcurrency: 1, clamped: [] });
    expect(resolveChatAgentLimits({ maxSteps: 12, maxToolCalls: 24, searchConcurrency: 8 }, false))
      .toEqual({ maxSteps: 8, baseSteps: 8, maxToolCalls: 16, searchConcurrency: 6, clamped: ["maxSteps", "maxToolCalls", "searchConcurrency"] });
  });

  it("gives admins the full range, bounded by the schema maximums", () => {
    expect(resolveChatAgentLimits({ maxSteps: 12, maxToolCalls: 24, searchConcurrency: 8 }, true)).toEqual({ maxSteps: 12, baseSteps: 12, maxToolCalls: 24, searchConcurrency: 8, clamped: [] });
    expect(resolveChatAgentLimits({ maxSteps: 99 }, true).maxSteps).toBe(12);
  });
});

describe("DOCSLURP_CHAT_EVAL_ORG_IDS", () => {
  const session = { type: "session" as const, userId: "u", sessionId: "s", user: { id: "u", email: "", name: "" } };
  const key = (keyType: "server" | "client") => ({ type: "apiKey" as const, userId: "u",
    apiKey: { keyId: "k", userId: "u", orgId: "org-eval", keyType, allowedDomains: [], scopes: ["search"], rateLimitRpm: 60, rateLimitPpd: 1, rateLimits: [], projectIds: [] } });

  it("grants eval access for projects owned by a listed org, to sessions and server keys only", async () => {
    vi.stubEnv("DOCSLURP_CHAT_EVAL_ORG_IDS", " org-eval , org-two");
    expect(await chatEvalAccess(session, "ws-eval")).toBe(true);
    expect(await chatEvalAccess(key("server"), "ws-eval")).toBe(true);
    expect(await chatEvalAccess(key("client"), "ws-eval")).toBe(false);
    // The project's owning org decides, not the key's or caller's org.
    expect(await chatEvalAccess(key("server"), "ws-plain")).toBe(false);
    expect(await chatEvalAccess(session, undefined)).toBe(false);
    expect(await chatEvalAccess(undefined, "ws-eval")).toBe(false);
  });

  it("is off when unset, while platform admins keep access everywhere", async () => {
    getProjectAccess.mockClear();
    expect(await chatEvalAccess(session, "ws-eval")).toBe(false);
    expect(getProjectAccess).not.toHaveBeenCalled();
    expect(await chatEvalAccess({ ...session, admin: true } as never, "ws-plain")).toBe(true);
  });

  it("pre-checks stream models against the turn's project", async () => {
    vi.stubEnv("DOCSLURP_CHAT_EVAL_ORG_IDS", "org-eval");
    vi.stubEnv("DOCSLURP_CHAT_EVAL_MODELS", "liquid/lfm-2.5-24b-a2b");
    expect(await chatModelRefused(session, "liquid/lfm-2.5-24b-a2b", "ws-eval")).toBe(false);
    expect(await chatModelRefused(session, "liquid/lfm-2.5-24b-a2b", "ws-plain")).toBe(true);
    expect(await chatModelRefused(key("client"), "liquid/lfm-2.5-24b-a2b", "ws-eval")).toBe(true);
  });
});

describe("eval access lookups", () => {
  const session = { type: "session" as const, userId: "u", sessionId: "s", user: { id: "u", email: "", name: "" } };

  it("is needed only for a non-catalog model or a raised agent limit", () => {
    expect(chatTurnNeedsEvalAccess(undefined)).toBe(false);
    expect(chatTurnNeedsEvalAccess("  ")).toBe(false);
    expect(chatTurnNeedsEvalAccess("z-ai/glm-5.3-flash", { maxSteps: 6, maxToolCalls: 2, searchConcurrency: 4 })).toBe(false);
    expect(chatTurnNeedsEvalAccess("liquid/lfm-2.5-24b-a2b")).toBe(true);
    expect(chatTurnNeedsEvalAccess(undefined, { maxSteps: 9 })).toBe(true);
    expect(chatTurnNeedsEvalAccess(undefined, { searchConcurrency: 8 })).toBe(true);
  });

  it("skips the project lookup when the stream pre-check names a catalog model or none", async () => {
    vi.stubEnv("DOCSLURP_CHAT_EVAL_ORG_IDS", "org-eval");
    getProjectAccess.mockClear();
    expect(await chatModelRefused(session, "anthropic/claude-haiku-5.5", "ws-eval")).toBe(false);
    expect(await chatModelRefused(session, undefined, "ws-eval")).toBe(false);
    expect(getProjectAccess).not.toHaveBeenCalled();
  });
});


describe("explicit Speed boost admission", () => {
  it.each([undefined, false])("preserves baseline routing when %s", (flag) => {
    expect(resolveSpeedBoostChatModel("z-ai/glm-5.3-flash", flag)).toBe("z-ai/glm-5.3-flash");
    expect(() => resolveSpeedBoostChatModel("z-ai/glm-5.3-flash:nitro", flag)).toThrow(ChatModelNotAllowedError);
  });
  it.each(["deepseek/deepseek-v4.1-flash-1017", "openai/gpt-6-luna"])("routes explicit opt-in for %s", (model) => {
    expect(resolveSpeedBoostChatModel(model, true)).toBe(`${model}:nitro`);
    expect(resolveSpeedBoostChatModel(`${model}:nitro`, true)).toBe(`${model}:nitro`);
  });
  it("answers boosted GLM 5.3 Flash with DeepSeek V4.1 Flash on Nitro, keeping an explicit GLM Nitro id", () => {
    expect(resolveSpeedBoostChatModel("z-ai/glm-5.3-flash", true)).toBe("deepseek/deepseek-v4.1-flash-1017:nitro");
    expect(resolveSpeedBoostChatModel("z-ai/glm-5.3-flash:nitro", true)).toBe("z-ai/glm-5.3-flash:nitro");
  });
  it.each(["openai/gpt-6-luna-pro", "arbitrary/model", "openai/gpt-6.1-sol"])("refuses unsupported boost %s before spending", (model) => {
    expect(() => resolveSpeedBoostChatModel(model, true)).toThrow(ChatModelNotAllowedError);
  });
});
