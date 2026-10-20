import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { createOpenRouterUsageCapture, readProviderCharge } from "@docslurp/shared";
import { chatAgentProviderOptions, createChatAgentModel } from "./chat-agent-model.js";

// Live OpenRouter SSE responses recorded on 2026-10-20 (2-step lookup_bin loop).
function fixture(name: string): { model: string; responses: string[] } {
  return JSON.parse(readFileSync(new URL(`../services/__fixtures__/chat-agent-reasoning/${name}.json`, import.meta.url), "utf8"));
}

type ChatRequest = { model: string; reasoning?: unknown; usage?: unknown; messages: Array<Record<string, any>> };

async function replayToolLoop(name: string) {
  const { model, responses } = fixture(name);
  const requests: ChatRequest[] = [];
  const replay: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as ChatRequest;
    requests.push(body);
    return new Response(responses[requests.length - 1], { headers: { "content-type": "text/event-stream" } });
  };
  const accounting = createOpenRouterUsageCapture(replay);
  const receipts: Array<{ costCents?: number; provider?: string; responseModel?: string; generationId?: string; reasoning: string }> = [];
  const result = streamText({
    model: createChatAgentModel({ apiKey: "test", model, fetch: accounting.fetch }),
    system: "You answer questions about a fictional warehouse. Always call lookup_bin before answering; then answer in one short sentence.",
    messages: [{ role: "user", content: "Which aisle holds bin K-77, and what is 6 times its aisle number?" }],
    tools: { lookup_bin: tool({ description: "Look up the aisle for a warehouse bin id.", inputSchema: z.object({ bin: z.string() }),
      execute: async ({ bin }) => ({ bin, aisle: 14 }) }) },
    stopWhen: stepCountIs(2),
    prepareStep: ({ stepNumber }) => (stepNumber === 0 ? { toolChoice: "required" as const } : { toolChoice: "none" as const }),
    maxRetries: 0,
    providerOptions: chatAgentProviderOptions(model),
    onStepFinish: step => {
      receipts.push({ costCents: readProviderCharge(accounting.usage()).costCents, provider: accounting.providerName(),
        responseModel: accounting.responseModel(), generationId: step.response.id, reasoning: step.reasoningText ?? "" });
    },
  });
  let answer = "";
  for await (const part of result.fullStream) {
    if (part.type === "error") throw part.error;
    if (part.type === "text-delta") answer += part.text;
  }
  return { model, requests, receipts, answer };
}

describe("chat agent model reasoning round-trip (recorded OpenRouter fixtures)", () => {
  it("sends beam-1.0's step reasoning back on the assistant turn at messages[2]", async () => {
    const { requests, receipts, answer } = await replayToolLoop("beam-1.0");
    expect(requests).toHaveLength(2);
    expect(receipts[0]!.reasoning.length).toBeGreaterThan(0);
    // The turn production rejected: "The assistant turn at messages[2] is missing its reasoning."
    const assistant = requests[1]!.messages[2]!;
    expect(assistant).toMatchObject({ role: "assistant", tool_calls: [expect.objectContaining({ function: expect.objectContaining({ name: "lookup_bin" }) })] });
    expect(assistant.reasoning).toBe(receipts[0]!.reasoning);
    expect(assistant.reasoning_details).toEqual([expect.objectContaining({ type: "reasoning.text", text: receipts[0]!.reasoning })]);
    expect(requests[1]!.messages[3]).toMatchObject({ role: "tool", tool_call_id: assistant.tool_calls[0].id });
    expect(answer).toContain("84");
  });

  it("keeps OpenRouter usage receipts, the routed provider and the response model", async () => {
    const { model, requests, receipts } = await replayToolLoop("beam-1.0");
    for (const request of requests) expect(request).toMatchObject({ model, usage: { include: true } });
    expect(requests[0]).not.toHaveProperty("reasoning");
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({ provider: "Together", responseModel: model, generationId: expect.stringMatching(/^gen-/) });
      expect(receipt.costCents).toBeGreaterThan(0);
    }
  });

  it("round-trips DeepSeek V4 reasoning and keeps its low reasoning effort on every step", async () => {
    const { requests, receipts } = await replayToolLoop("deepseek-v4.1-flash");
    for (const request of requests) expect(request.reasoning).toEqual({ effort: "low" });
    const assistant = requests[1]!.messages.find(message => message.role === "assistant")!;
    expect(receipts[0]!.reasoning.length).toBeGreaterThan(0);
    expect(assistant.reasoning).toBe(receipts[0]!.reasoning);
    expect(assistant.reasoning_details).toEqual([expect.objectContaining({ type: "reasoning.text", text: receipts[0]!.reasoning })]);
    expect(receipts.every(receipt => receipt.provider === "BaseTen" && (receipt.costCents ?? 0) > 0)).toBe(true);
  });

  it("leaves non-reasoning turns unchanged and still applies the verified reasoning floor", async () => {
    const { requests, receipts, answer } = await replayToolLoop("claude-haiku-5.5");
    for (const request of requests) expect(request.reasoning).toEqual({ enabled: false });
    const assistant = requests[1]!.messages.find(message => message.role === "assistant")!;
    expect(assistant).not.toHaveProperty("reasoning");
    expect(assistant).not.toHaveProperty("reasoning_details");
    expect(receipts.every(receipt => (receipt.costCents ?? 0) > 0)).toBe(true);
    expect(answer).toContain("84");
  });
});

describe("chatAgentProviderOptions", () => {
  it("requests low reasoning for DeepSeek V4 aliases and dated builds only", () => {
    expect(chatAgentProviderOptions("deepseek/deepseek-v4.1-flash-1017")).toEqual({ openrouter: { reasoning: { effort: "low" } } });
    expect(chatAgentProviderOptions("reflection/beam-1.0-501b-a23b")).toBeUndefined();
  });
});
