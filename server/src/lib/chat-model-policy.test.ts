import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./request-actor.js", () => ({ isPlatformAdminActor: vi.fn(async (actor?: { admin?: boolean }) => actor?.admin === true) }));

const {
  ChatModelNotAllowedError, chatModelRefused, configuredChatEvalModels, parseChatEvalModels,
  resolveChatAgentLimits, resolveChatModelRequest,
} = await import("./chat-model-policy.js");
const { chatAgentProviderOptions } = await import("../services/chat-mcp-agent.js");

const evalModels = new Set(["inception/mercury-3", "minimax/minimax-m3.1-flash:free"]);

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("DOCSLURP_CHAT_EVAL_MODELS", () => {
  it("admits priced OpenRouter ids (including :free) and rejects prohibited, unpriced and malformed ids", () => {
    const { models, rejected } = parseChatEvalModels(
      " inception/mercury-3, minimax/minimax-m3.1-flash:free,inception/mercury-3, openai/gpt-6-sol-pro, acme/ultra-1, acme/unpriced-model, not a model, openai/gpt-6-astra",
    );
    expect(models).toEqual(["inception/mercury-3", "minimax/minimax-m3.1-flash:free"]);
    expect(rejected).toEqual([
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
    expect(resolveChatModelRequest({ requested: undefined, isAdmin: false, evalModels })).toEqual({ model: "z-ai/glm-5.3-flash", source: "default" });
    expect(resolveChatModelRequest({ requested: "  ", isAdmin: false, evalModels }).source).toBe("default");
    expect(resolveChatModelRequest({ requested: "anthropic/claude-haiku-5.5", isAdmin: false, evalModels })).toEqual({ model: "anthropic/claude-haiku-5.5", source: "catalog" });
  });

  it("refuses unknown models instead of silently falling back", () => {
    expect(() => resolveChatModelRequest({ requested: "deepseek/deepseek-v4-flash", isAdmin: true, evalModels })).toThrow(ChatModelNotAllowedError);
    const error = (() => { try { resolveChatModelRequest({ requested: "missing/model", isAdmin: false, evalModels }); } catch (caught) { return caught; } })();
    expect(error).toMatchObject({ status: 400, code: "model_not_allowed" });
  });

  it("allows eval models to admins only", () => {
    expect(resolveChatModelRequest({ requested: "inception/mercury-3", isAdmin: true, evalModels })).toEqual({ model: "inception/mercury-3", source: "eval" });
    expect(() => resolveChatModelRequest({ requested: "inception/mercury-3", isAdmin: false, evalModels })).toThrow(ChatModelNotAllowedError);
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

  it("applies DeepSeek V4 reasoning options to aliases and dated builds", () => {
    for (const model of ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-1017"]) {
      expect(chatAgentProviderOptions(model)).toEqual({ openai: { reasoningEffort: "low", forceReasoning: true } });
    }
    expect(chatAgentProviderOptions("z-ai/glm-5.3-flash")).toBeUndefined();
  });
});

describe("agent limits", () => {
  it("defaults to 6 steps, 12 tool calls and search concurrency 4", () => {
    expect(resolveChatAgentLimits(undefined, false)).toEqual({ maxSteps: 6, maxToolCalls: 12, searchConcurrency: 4, clamped: [] });
  });

  it("lets non-admins lower limits but clamps raised ones to the defaults", () => {
    expect(resolveChatAgentLimits({ maxSteps: 2, maxToolCalls: 3, searchConcurrency: 1 }, false)).toEqual({ maxSteps: 2, maxToolCalls: 3, searchConcurrency: 1, clamped: [] });
    expect(resolveChatAgentLimits({ maxSteps: 12, maxToolCalls: 24, searchConcurrency: 8 }, false))
      .toEqual({ maxSteps: 6, maxToolCalls: 12, searchConcurrency: 4, clamped: ["maxSteps", "maxToolCalls", "searchConcurrency"] });
  });

  it("gives admins the full range, bounded by the schema maximums", () => {
    expect(resolveChatAgentLimits({ maxSteps: 12, maxToolCalls: 24, searchConcurrency: 8 }, true)).toEqual({ maxSteps: 12, maxToolCalls: 24, searchConcurrency: 8, clamped: [] });
    expect(resolveChatAgentLimits({ maxSteps: 99 }, true).maxSteps).toBe(12);
  });
});
