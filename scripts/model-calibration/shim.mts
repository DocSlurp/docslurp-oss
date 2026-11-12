// Fetch shim for model calibration runs. Production helpers build their OpenRouter clients over
// `globalThis.fetch`, so wrapping it lets the harness run the real prompt, parsing and fallback code while
// (a) swapping the model a helper hard-codes, (b) overriding reasoning / provider routing for a
// calibration arm, and (c) capturing every generation call (latency, host, usage, raw text) per case.
import { AsyncLocalStorage } from "node:async_hooks";

export interface Arm {
  /** Arm id used in reports. */
  id: string;
  /** Model the arm runs. `undefined` keeps whatever the production helper sends. */
  model?: string;
  /** "keep" leaves the body's reasoning as production built it; "omit" removes it (provider default). */
  reasoning?: "keep" | "omit" | Record<string, unknown>;
  /** OpenRouter `provider` preferences; "keep" leaves production routing untouched, "omit" removes it (OpenRouter default). */
  provider?: "keep" | "omit" | Record<string, unknown>;
  /** Reasoning headroom added to the request's output-token cap (reasoning tokens count against it). */
  extraOutputTokens?: number;
}

export interface CallRecord {
  sentModel?: string;
  reasoning?: unknown;
  provider?: unknown;
  maxTokens?: number;
  status: number;
  latencyMs: number;
  ttftMs?: number;
  servedBy?: string;
  servedModel?: string;
  finishReason?: string;
  text?: string;
  reasoningText?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  costUsd?: number;
  error?: string;
}

interface Scope { arm: Arm; calls: CallRecord[] }
const scope = new AsyncLocalStorage<Scope>();
const realFetch = globalThis.fetch;

export function withArm<T>(arm: Arm, fn: () => Promise<T>): Promise<{ value?: T; error?: string; calls: CallRecord[] }> {
  const state: Scope = { arm, calls: [] };
  return scope.run(state, async () => {
    try {
      return { value: await fn(), calls: state.calls };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), calls: state.calls };
    }
  });
}

function isGeneration(url: string): boolean {
  return /openrouter\.ai\/api\/v1\/(chat\/completions|completions|responses)$/.test(url);
}

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const state = scope.getStore();
  if (!state || !isGeneration(url) || typeof init?.body !== "string") return realFetch(input, init);
  const body = JSON.parse(init.body) as Record<string, any>;
  const { arm } = state;
  if (arm.model) body.model = arm.model;
  if (arm.reasoning === "omit") { delete body.reasoning; delete body.reasoning_effort; }
  else if (arm.reasoning && arm.reasoning !== "keep") { delete body.reasoning_effort; body.reasoning = arm.reasoning; }
  if (arm.provider === "omit") delete body.provider;
  else if (arm.provider && arm.provider !== "keep") body.provider = arm.provider;
  if (arm.extraOutputTokens) {
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"]) {
      if (typeof body[key] === "number") body[key] += arm.extraOutputTokens;
    }
  }
  // Usage accounting in production asks OpenRouter for usage; keep it on so cost is the provider's number.
  body.usage = { include: true };
  const record: CallRecord = { sentModel: body.model, reasoning: body.reasoning, provider: body.provider,
    maxTokens: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens, status: 0, latencyMs: 0 };
  state.calls.push(record);
  const started = performance.now();
  const response = await realFetch(input, { ...init, body: JSON.stringify(body) });
  record.status = response.status;
  if (!response.ok) {
    record.latencyMs = Math.round(performance.now() - started);
    record.error = (await response.clone().text().catch(() => "")).slice(0, 300);
    return response;
  }
  if (!body.stream) {
    const json = await response.clone().json().catch(() => null) as any;
    record.latencyMs = Math.round(performance.now() - started);
    if (json?.object === "response" || Array.isArray(json?.output)) captureResponses(record, json);
    else capture(record, json, json?.choices?.[0]?.message?.content, json?.choices?.[0]?.message?.reasoning, json?.choices?.[0]?.finish_reason);
    return response;
  }
  // Streaming: tee the body so the caller still consumes it; parse our copy for TTFT and the final usage chunk.
  const [mine, theirs] = response.body!.tee();
  void (async () => {
    const decoder = new TextDecoder(); let buffer = ""; let text = ""; let reasoningText = ""; let last: any; let finish: string | undefined;
    for await (const chunk of mine as any) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        let event: any; try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (typeof event.type === "string" && event.type.startsWith("response.")) {
          // Responses API stream (what the AI SDK's OpenAI provider uses against OpenRouter).
          const isText = event.type === "response.output_text.delta";
          const isReasoning = /^response\.reasoning(_summary)?_text\.delta$/.test(event.type);
          if ((isText || isReasoning) && record.ttftMs === undefined) record.ttftMs = Math.round(performance.now() - started);
          if (isText) text += event.delta ?? "";
          if (isReasoning) reasoningText += event.delta ?? "";
          if (event.response) last = { responses: event.response };
          continue;
        }
        const delta = event.choices?.[0]?.delta;
        if ((delta?.content || delta?.reasoning) && record.ttftMs === undefined) record.ttftMs = Math.round(performance.now() - started);
        if (delta?.content) text += delta.content;
        if (delta?.reasoning) reasoningText += delta.reasoning;
        finish = event.choices?.[0]?.finish_reason ?? finish;
        last = { ...last, ...event };
      }
    }
    record.latencyMs = Math.round(performance.now() - started);
    if (last?.responses) { captureResponses(record, last.responses); record.text = text; if (reasoningText) record.reasoningText = reasoningText.slice(0, 2000); }
    else capture(record, last, text, reasoningText, finish);
  })();
  return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
};

function capture(record: CallRecord, json: any, text: unknown, reasoningText: unknown, finish: unknown) {
  record.servedBy = json?.provider;
  record.servedModel = json?.model;
  record.finishReason = typeof finish === "string" ? finish : undefined;
  record.text = typeof text === "string" ? text : undefined;
  record.reasoningText = typeof reasoningText === "string" && reasoningText ? reasoningText.slice(0, 2000) : undefined;
  const usage = json?.usage;
  record.inputTokens = usage?.prompt_tokens;
  record.outputTokens = usage?.completion_tokens;
  record.reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  record.cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  record.costUsd = usage?.cost;
}

function captureResponses(record: CallRecord, json: any) {
  const output = Array.isArray(json?.output) ? json.output : [];
  const text = output.filter((item: any) => item.type === "message").flatMap((item: any) => item.content ?? [])
    .filter((part: any) => part.type === "output_text").map((part: any) => part.text ?? "").join("");
  const reasoning = output.filter((item: any) => item.type === "reasoning")
    .flatMap((item: any) => [...(item.summary ?? []), ...(item.content ?? [])]).map((part: any) => part.text ?? "").join("");
  record.servedBy = json?.provider;
  record.servedModel = json?.model;
  record.finishReason = json?.status === "completed" ? "stop" : json?.incomplete_details?.reason === "max_output_tokens" ? "length" : json?.status;
  record.text = text;
  record.reasoningText = reasoning ? reasoning.slice(0, 2000) : undefined;
  const usage = json?.usage;
  record.inputTokens = usage?.input_tokens;
  record.outputTokens = usage?.output_tokens;
  record.reasoningTokens = usage?.output_tokens_details?.reasoning_tokens;
  record.cachedTokens = usage?.input_tokens_details?.cached_tokens;
  record.costUsd = usage?.cost;
}

/** Streams finish asynchronously: wait until every captured call has its latency. */
export async function settle(calls: CallRecord[], timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (calls.some((call) => call.status === 200 && call.latencyMs === 0) && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
