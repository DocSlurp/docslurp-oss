import { describe, expect, it } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";
import { createOpenRouterPromptCacheFetch } from "@docslurp/shared";

// The request body the real AI SDK OpenAI chat model sends for Claude through the prompt-cache fetch, at the default
// reasoning (`none`) and an explicit effort: both keep the system breakpoint and use OpenRouter's field names.
async function capturedBody(providerOptions: Record<string, any> | undefined): Promise<any> {
  let body: any;
  const fetchMock: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    const sse = [
      { id: "gen-1", object: "chat.completion.chunk", created: 0, model: "anthropic/claude-haiku-5.5", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { id: "gen-1", object: "chat.completion.chunk", created: 0, model: "anthropic/claude-haiku-5.5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = createOpenAI({ apiKey: "test", baseURL: "https://openrouter.ai/api/v1", fetch: createOpenRouterPromptCacheFetch(fetchMock) });
  const result = streamText({
    model: provider.chat("anthropic/claude-haiku-5.5"),
    system: "Shared rules.",
    messages: [{ role: "user", content: [{ type: "text", text: "Project evidence: ..." }, { type: "text", text: "Question" }] }],
    maxOutputTokens: 500,
    ...(providerOptions ? { providerOptions } : {}),
  });
  for await (const _ of result.textStream) { /* drain */ }
  return body;
}

describe("Claude chat answers on Chat Completions", () => {
  it.each([
    ["none", undefined],
    ["low", { openai: { reasoningEffort: "low", forceReasoning: true } }],
  ])("keeps the system cache breakpoint and OpenRouter's fields at reasoning %s", async (_level, options) => {
    const body = await capturedBody(options);
    const system = body.messages.find((message: any) => message.role === "system" || message.role === "developer");
    expect(system.content.at(-1).cache_control).toEqual({ type: "ephemeral" });
    const user = body.messages.at(-1);
    expect(user.content[0].cache_control).toBeUndefined();
    expect(user.content[1].cache_control).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBe(500);
    if (options) expect(body.reasoning).toEqual({ effort: "low" });
  });
});
