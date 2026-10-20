import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenRouterReasoningFetch, lowestOpenRouterReasoning, openRouterReasoningParams, createOpenRouterUsageCapture, readProviderCharge, resolveOpenRouterUsage } from "../openrouter-usage.js";
afterEach(() => vi.unstubAllGlobals());
describe("OpenRouter thinking controls", () => {
  it("disables thinking without sending unsupported effort and preserves request and accounting options", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const body = { model: "vendor/model", messages: [{ role: "user", content: "source" }], max_tokens: 128, reasoning_effort: "none", reasoning: { effort: "low", exclude: true } };
    const headers = { Authorization: "Bearer test" };
    await createOpenRouterReasoningFetch(baseFetch, "none")("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
    const init = baseFetch.mock.calls[0][1]!;
    expect(init.headers).toBe(headers);
    expect(JSON.parse(init.body as string)).toEqual({ model: body.model, messages: body.messages, max_tokens: 128, reasoning: { exclude: true, enabled: false } });
    expect(body.reasoning_effort).toBe("none");
  });

  it("leaves enabled efforts and requests without a JSON body untouched", async () => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    expect(createOpenRouterReasoningFetch(baseFetch, "low")).toBe(baseFetch);
    const init = { method: "GET" };
    await createOpenRouterReasoningFetch(baseFetch, "none")("https://openrouter.ai/api/v1/models", init);
    expect(baseFetch.mock.calls[0][1]).toBe(init);
  });
});
describe("lowest accepted reasoning", () => {
  const sent = async (model: string) => {
    const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    await createOpenRouterReasoningFetch(baseFetch, "none")("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model, reasoning: { effort: "high" } }) });
    return JSON.parse(baseFetch.mock.calls[0][1]!.body as string).reasoning;
  };
  it("never sends enabled:false or effort none to models whose floor is minimal", async () => {
    expect(await sent("z-ai/glm-5.3-flash")).toEqual({ effort: "minimal" });
    expect(await sent("anthropic/claude-sonnet-5.5")).toEqual({ effort: "minimal" });
  });
  it("uses each model's verified lowest setting", async () => {
    expect(await sent("deepseek/deepseek-v4.1-flash")).toEqual({ effort: "none" });
    expect(await sent("anthropic/claude-haiku-5.5")).toEqual({ enabled: false });
    expect(await sent("vendor/unknown")).toEqual({ enabled: false });
  });
  it("with no effort set, applies the floor only to listed models without an explicit reasoning choice", async () => {
    const call = async (body: Record<string, unknown>) => {
      const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
      await createOpenRouterReasoningFetch(baseFetch)("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
      return JSON.parse(baseFetch.mock.calls[0][1]!.body as string);
    };
    expect((await call({ model: "z-ai/glm-5.3-flash" })).reasoning).toEqual({ effort: "minimal" });
    expect((await call({ model: "anthropic/claude-haiku-5.5" })).reasoning).toEqual({ enabled: false });
    expect((await call({ model: "google/gemini-3.5-flash" })).reasoning).toBeUndefined();
    expect((await call({ model: "z-ai/glm-5.3-flash", reasoning_effort: "high" })).reasoning).toBeUndefined();
    expect((await call({ model: "z-ai/glm-5.3-flash", reasoning: { effort: "high" } })).reasoning).toEqual({ effort: "high" });
  });
  it("adds a reasoning body fragment only for verified models", () => {
    expect(openRouterReasoningParams("z-ai/glm-5.3-flash")).toEqual({ reasoning: { effort: "minimal" } });
    expect(openRouterReasoningParams("google/gemini-3.5-flash")).toEqual({});
    expect(lowestOpenRouterReasoning(undefined)).toBeUndefined();
  });
});
describe("provider cost accounting", () => {
  it("includes separately billed BYOK inference and router fees without double counting normal routing", () => {
    const usage = { cost: 0.00001, is_byok: true, cost_details: { upstream_inference_cost: 0.0002 } };
    expect(readProviderCharge(usage).costCents).toBeCloseTo(0.021, 12);
    expect(readProviderCharge({ ...usage, cost: 0 }).costCents).toBeCloseTo(0.02, 12);
    expect(readProviderCharge({ ...usage, is_byok: false }).costCents).toBeCloseTo(0.001, 12);
    expect(readProviderCharge({ cost: 0, is_byok: true })).toEqual({});
  });
  it("recovers separately billed BYOK inference from generation accounting", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      total_cost: 0, upstream_inference_cost: 0.000189675, is_byok: true,
    } }))));
    const usage = await resolveOpenRouterUsage({ apiKey: "test", model: "openai/gpt-6-luna", generationId: "gen-byok", usage: { inputTokens: 1414, outputTokens: 26 } });
    expect(usage.costCents).toBeCloseTo(0.0189675, 12);
    expect(usage.metadata).toMatchObject({ costSource: "provider", routerCreditCostUsd: 0, upstreamInferenceCostUsd: 0.000189675, isByok: true });
  });
  it("captures usage across split SSE chunks without changing the response bytes", async () => {
    const body = 'data: {"provider":"Stream provider","choices":[]}\n\ndata: {"response":{"usage":{"cost":0.000125,"input_tokens":20}}}\n\ndata: [DONE]\n\n';
    const encoded = new TextEncoder().encode(body);
    const baseFetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoded.slice(0, 49)); controller.enqueue(encoded.slice(49)); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } }));
    const capture = createOpenRouterUsageCapture(baseFetch);
    const response = await capture.fetch('https://example.test');
    expect(await response.text()).toBe(body);
    expect(capture.usage()).toEqual({ cost: 0.000125, input_tokens: 20 });
    expect(capture.providerName()).toBe("Stream provider");
  });
  it("captures non-streaming router usage without losing cache metadata", async () => {
    const payload = { provider: "Routed provider", usage: { cost: 0, prompt_tokens_details: { cached_tokens: 10 } } };
    const capture = createOpenRouterUsageCapture(vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } })));
    expect(await (await capture.fetch('https://example.test')).json()).toEqual(payload);
    expect(capture.usage()).toEqual(payload.usage);
    expect(capture.providerName()).toBe("Routed provider");
    const usage = await resolveOpenRouterUsage({ apiKey: "test", model: "vendor/model", providerName: capture.providerName(), usage: { inputTokens: 20, outputTokens: 5, raw: capture.usage() } });
    expect(usage.metadata).toMatchObject({ providerName: "Routed provider", costSource: "provider" });
  });

  it("clears stale provider and charges when a later attempt fails", async () => {
    const baseFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ provider: "Prior provider", usage: { cost: 0.1 } })))
      .mockResolvedValueOnce(new Response("failed", { status: 503 }));
    const capture = createOpenRouterUsageCapture(baseFetch);
    await (await capture.fetch("https://example.test")).text();
    expect(capture.providerName()).toBe("Prior provider");
    await capture.fetch("https://example.test");
    expect(capture.providerName()).toBeUndefined();
    expect(capture.usage()).toBeUndefined();
  });

  it("preserves fractional cents, zero charges, cache details, and rejects invalid costs", () => {
    expect(readProviderCharge({ cost: 0.0000123, prompt_tokens_details: { cached_tokens: 50 } }).costCents).toBeCloseTo(0.00123, 12);
    expect(readProviderCharge({ cost: 0 }).costCents).toBe(0);
    expect(readProviderCharge({ cost: -1 })).toEqual({});
    expect(readProviderCharge({ cost: Infinity })).toEqual({});
  });
  it("recovers the actual router charge and native usage rather than recomputing cached token prices", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: {
      total_cost: 0.00025, native_tokens_prompt: 120, native_tokens_completion: 35,
      native_tokens_cached: 100, native_tokens_reasoning: 15, provider_name: "Provider", is_byok: false,
    } }))));
    const usage = await resolveOpenRouterUsage({ apiKey: "test", model: "z-ai/glm-5.3-flash", generationId: "gen-test", usage: { inputTokens: 120, outputTokens: 35 } });
    expect(usage).toMatchObject({ costCents: 0.025, inputTokens: 120, outputTokens: 35,
      metadata: { costSource: "provider", generationId: "gen-test", cachedTokens: 100, reasoningTokens: 15 } });
  });
  it("labels catalog fallback as an estimate when generation accounting is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "test-model", pricing: { prompt: "0.00000015", completion: "0.0000005" } }] }))));
    const usage = await resolveOpenRouterUsage({ apiKey: "test", model: "test-model", generationId: "missing", usage: { inputTokens: 1000, outputTokens: 100 } });
    expect(usage.costCents).toBeCloseTo(0.02, 10);
    expect(usage.metadata).toMatchObject({ costSource: "estimate", pricingSource: "openrouter-models" });
  });
  it("estimates a receipt-less chat model call from the verified price table without the live listing", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const usage = await resolveOpenRouterUsage({ apiKey: "test", model: "deepseek/deepseek-v4.1-flash-1017", generationId: "missing", usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } });
    expect(usage.costCents).toBeCloseTo(75, 10);
    expect(usage.metadata).toMatchObject({ costSource: "estimate", pricingSource: "model-prices" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
