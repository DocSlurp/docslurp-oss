import { describe, expect, it, vi } from "vitest";
import { createOpenRouterPromptCacheFetch, needsExplicitPromptCache, withOpenRouterClaudeChatShape, withPromptCacheBreakpoints } from "../openrouter-prompt-cache.js";

const MARK = { type: "ephemeral" };

describe("prompt-cache breakpoints", () => {
  it("applies only to models that cache at explicit markers", () => {
    expect(needsExplicitPromptCache("anthropic/claude-haiku-5.5")).toBe(true);
    expect(needsExplicitPromptCache("openai/gpt-6-luna")).toBe(false);
    expect(needsExplicitPromptCache("z-ai/glm-5.3-flash")).toBe(false);
    const body = { model: "openai/gpt-6-luna", messages: [{ role: "system", content: "rules" }, { role: "user", content: "q" }] };
    expect(withPromptCacheBreakpoints(body)).toBe(body);
  });

  it("marks only the system prompt, never per-request content", () => {
    const body = { model: "anthropic/claude-haiku-5.5", messages: [
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "text", text: "evidence" }, { type: "text", text: "question" }] },
    ] };
    const marked = withPromptCacheBreakpoints(body) as any;
    expect(marked.messages[0].content).toEqual([{ type: "text", text: "rules", cache_control: MARK }]);
    expect(marked.messages[1].content[0]).toEqual({ type: "text", text: "evidence" });
    expect(marked.messages[1].content[1]).toEqual({ type: "text", text: "question" });
    // The input is not mutated.
    expect(body.messages[0].content).toBe("rules");
  });

  it("leaves a one-part question unmarked and respects markers the caller placed", () => {
    const single = withPromptCacheBreakpoints({ model: "anthropic/claude-haiku-5.5", messages: [{ role: "system", content: "rules" }, { role: "user", content: "q" }] }) as any;
    expect(single.messages[1].content).toBe("q");
    const own = { model: "anthropic/claude-haiku-5.5", messages: [{ role: "system", content: [{ type: "text", text: "r", cache_control: MARK }] }, { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] };
    expect(withPromptCacheBreakpoints(own)).toBe(own);
    const topLevel = { model: "anthropic/claude-haiku-5.5", cache_control: MARK, messages: [{ role: "system", content: "r" }] };
    expect(withPromptCacheBreakpoints(topLevel)).toBe(topLevel);
  });

  it("rewrites only Chat Completions bodies", async () => {
    const base = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(String(init?.body)));
    const cached = createOpenRouterPromptCacheFetch(base as unknown as typeof fetch);
    const body = JSON.stringify({ model: "anthropic/claude-haiku-5.5", messages: [{ role: "system", content: "rules" }] });
    const cc = await (await cached("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body })).json();
    expect(cc.messages[0].content[0].cache_control).toEqual(MARK);
    const responses = await (await cached("https://openrouter.ai/api/v1/responses", { method: "POST", body })).text();
    expect(responses).toBe(body);
  });

  it("marks a developer-role system prompt (reasoning requests) and maps Claude's reasoning and cap to OpenRouter's fields", () => {
    const body = { model: "anthropic/claude-haiku-5.5", reasoning_effort: "low", max_completion_tokens: 900,
      messages: [{ role: "developer", content: "rules" }, { role: "user", content: [{ type: "text", text: "evidence" }, { type: "text", text: "q" }] }] };
    const shaped = withPromptCacheBreakpoints(withOpenRouterClaudeChatShape(body)) as any;
    expect(shaped.reasoning).toEqual({ effort: "low" });
    expect(shaped.reasoning_effort).toBeUndefined();
    expect(shaped.max_tokens).toBe(900);
    expect(shaped.max_completion_tokens).toBeUndefined();
    expect(shaped.messages[0].content).toEqual([{ type: "text", text: "rules", cache_control: MARK }]);
    expect(shaped.messages[1].content[0].cache_control).toBeUndefined();
    // Other models keep the OpenAI fields untouched.
    const luna = { model: "openai/gpt-6-luna", reasoning_effort: "low", max_completion_tokens: 900, messages: [] };
    expect(withOpenRouterClaudeChatShape(luna)).toBe(luna);
  });
});
