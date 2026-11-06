import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOpenRouterRoutingFetch, DEFAULT_RESTRICTED_FALLBACK_MODEL, isTextOnlyRequest, resetRegionBlockedModels,
  restrictedFallbackModel, setOpenRouterProviderPolicyResolver,
} from "../openrouter-routing.js";
import { createOpenRouterUsageCapture, servedTextModel } from "../openrouter-usage.js";
import { CHINA_PROVIDER_SLUGS, providerRegion } from "../provider-regions.js";

const CHAT = "https://openrouter.ai/api/v1/chat/completions";
const BLOCKED = "qwen/qwen3.5-flash-02-23";
const OPEN = "z-ai/glm-5.3-flash";
const noAllowedProviders = (model = BLOCKED) => new Response(JSON.stringify({ error: { code: 404,
  message: `No allowed providers are available for the selected model. Providers serving ${model}: alibaba` } }), { status: 404 });
const ok = (model: string) => new Response(JSON.stringify({ id: "gen-1", model, choices: [] }), { status: 200, headers: { "content-type": "application/json" } });
const RESTRICTED = () => ({ allowChinaProviders: false });

/**
 * A routing fetch over an upstream that answers 404 "No allowed providers" for
 * restricted requests to the blocked model (and to any model in `alsoBlocked`),
 * and 200 otherwise, recording every body sent.
 */
function harness(options: { restrictedFallback?: boolean; alsoBlocked?: string[] } = { restrictedFallback: true }) {
  const sent: Array<Record<string, any>> = [];
  const blocked = new Set([BLOCKED, ...(options.alsoBlocked ?? [])]);
  const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.clone().text() : "")));
    sent.push(body);
    const restricted = Array.isArray(body.provider?.ignore) && body.provider.ignore.includes("alibaba");
    const model = String(body.model).replace(/:nitro$/, "");
    return restricted && (blocked.has(model) || String(body.model).endsWith(":nitro")) ? noAllowedProviders(model) : ok(body.model);
  });
  return { sent, upstream, fetch: createOpenRouterRoutingFetch(upstream as unknown as typeof fetch, options) };
}
const textRequest = (extra: Record<string, unknown> = {}) => ({ method: "POST", body: JSON.stringify({
  model: BLOCKED, reasoning: { enabled: false, exclude: true }, messages: [{ role: "user", content: "Extract a graph." }], ...extra }) });
const models = (sent: Array<Record<string, any>>) => sent.map((body) => body.model);

beforeEach(() => { resetRegionBlockedModels(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { setOpenRouterProviderPolicyResolver(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("restricted-provider fallback", () => {
  it("re-sends an opted-in restricted text request to the fallback, still restricted, at its reasoning floor", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness();
    expect((await fetch(CHAT, textRequest())).status).toBe(200);
    expect(models(sent)).toEqual([BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
    const retry = sent[1]!;
    // The fallback cannot disable reasoning: it gets its verified floor, keeping `exclude`.
    expect(retry.reasoning).toEqual({ effort: "minimal", exclude: true });
    for (const slug of CHINA_PROVIDER_SLUGS) expect(retry.provider.ignore).toContain(slug);
    for (const slug of retry.provider.only) expect(providerRegion(slug), slug).toBe("other");
  });

  it("applies the floor when reasoning was unset, and keeps an explicit effort", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness();
    await fetch(CHAT, { method: "POST", body: JSON.stringify({ model: BLOCKED, messages: [{ role: "user", content: "x" }] }) });
    expect(sent[1]!.reasoning).toEqual({ effort: "minimal" });
    resetRegionBlockedModels();
    await fetch(CHAT, textRequest({ reasoning: { effort: "high" } }));
    expect(sent[3]!.reasoning).toEqual({ effort: "high" });
  });

  it("is off unless the call site opts in: chat with a chosen model and classifiers never fall back", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness({});
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(models(sent)).toEqual([BLOCKED]);
  });

  it("never re-targets a request that pins its own route, such as the Llama Guard moderator", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness({ restrictedFallback: true, alsoBlocked: ["meta-llama/llama-guard-4-12b"] });
    const moderation = { method: "POST", body: JSON.stringify({ model: "meta-llama/llama-guard-4-12b",
      messages: [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }], max_tokens: 16, temperature: 0,
      provider: { only: ["deepinfra"], allow_fallbacks: false, data_collection: "deny" }, usage: { include: true } }) };
    expect((await fetch(CHAT, moderation)).status).toBe(404);
    for (const extra of [{ provider: { max_price: { prompt: 1 } } }, { provider: { zdr: true } }, { models: [BLOCKED, OPEN] }, { model: `${BLOCKED}:free` }]) {
      await fetch(CHAT, textRequest(extra));
    }
    expect(models(sent).filter((model) => model === DEFAULT_RESTRICTED_FALLBACK_MODEL)).toEqual([]);
  });

  it("remembers an unconstrained block only, and only for restricted requests", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness();
    // A constrained request's 404 says nothing about other tenants' requests: not remembered.
    await fetch(CHAT, textRequest({ provider: { only: ["together"] } }));
    await fetch(CHAT, textRequest());
    expect(models(sent)).toEqual([BLOCKED, BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
    // Now remembered: the next restricted request skips the doomed call.
    await fetch(CHAT, textRequest());
    expect(models(sent).slice(3)).toEqual([DEFAULT_RESTRICTED_FALLBACK_MODEL]);
    // A tenant that allows China-based hosts is never re-targeted by another tenant's block.
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: true }));
    await fetch(CHAT, textRequest());
    expect(models(sent).slice(4)).toEqual([BLOCKED]);
  });

  it("forgets a remembered block after its TTL", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { sent, fetch } = harness();
    await fetch(CHAT, textRequest());
    now.mockReturnValue(1_000_000 + 31 * 60_000);
    await fetch(CHAT, textRequest());
    expect(models(sent)).toEqual([BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL, BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
  });

  it("treats an unresolvable scope as restricted, and works for Request objects", async () => {
    setOpenRouterProviderPolicyResolver(() => undefined);
    const { sent, fetch } = harness();
    const { body } = textRequest();
    expect((await fetch(new Request(CHAT, { method: "POST", body }))).status).toBe(200);
    expect(models(sent)).toEqual([BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
    expect(sent[1]!.provider.ignore).toContain("alibaba");
  });

  it("tries a speed-boost request's base model before the fallback", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false, speedBoost: true }));
    const { sent, fetch } = harness();
    await fetch(CHAT, textRequest({ model: `${OPEN}:nitro` }));
    // The base model has non-China hosts: Nitro falls back to it and no region fallback happens.
    expect(models(sent)).toEqual([`${OPEN}:nitro`, OPEN]);
  });

  it("never re-targets image, file or audio requests, which the text-only fallback cannot read", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness();
    const image = textRequest({ messages: [{ role: "user", content: [{ type: "text", text: "Transcribe" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] });
    expect((await fetch(CHAT, image)).status).toBe(404);
    expect(models(sent)).toEqual([BLOCKED]);
    // An allowlist: unknown part types, media keys without a type, non-text modalities and deep nesting are not text.
    expect(isTextOnlyRequest({ messages: [{ role: "user", content: [{ type: "input_video", video: {} }] }] })).toBe(false);
    expect(isTextOnlyRequest({ messages: [{ role: "user", content: [{ image_url: { url: "https://example.com/a.png" } }] }] })).toBe(false);
    expect(isTextOnlyRequest({ input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] })).toBe(false);
    expect(isTextOnlyRequest({ modalities: ["text", "image"], messages: [{ role: "user", content: "draw" }] })).toBe(false);
    let deep: Record<string, unknown> = { text: "x" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(isTextOnlyRequest({ messages: [deep] })).toBe(false);
    expect(isTextOnlyRequest({ messages: [{ role: "user", content: [{ type: "text", text: "type: image_url" }] }] })).toBe(true);
  });

  it("never re-targets embeddings, or a 404 that is not a provider restriction", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { code: 404, message: "No endpoints found that support tool use" } }), { status: 404 }));
    const fetch = createOpenRouterRoutingFetch(upstream as unknown as typeof globalThis.fetch, { restrictedFallback: true });
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
    const { sent, fetch: blocked } = harness();
    await blocked("https://openrouter.ai/api/v1/embeddings", { method: "POST", body: JSON.stringify({ model: BLOCKED, input: ["text"] }) });
    expect(models(sent)).toEqual([BLOCKED]);
  });

  it("can be turned off or pointed at another model, but never at a variant or prohibited model", async () => {
    vi.stubEnv("OPENROUTER_RESTRICTED_FALLBACK_MODEL", "none");
    expect(restrictedFallbackModel()).toBeUndefined();
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness();
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(sent).toHaveLength(1);
    vi.stubEnv("OPENROUTER_RESTRICTED_FALLBACK_MODEL", "google/gemma-4-26b-a4b-it");
    expect(restrictedFallbackModel()).toBe("google/gemma-4-26b-a4b-it");
    for (const model of ["openai/gpt-oss-120b:nitro", "openai/gpt-6.1-pro", "openai/gpt-6-ultra"]) {
      vi.stubEnv("OPENROUTER_RESTRICTED_FALLBACK_MODEL", model);
      expect(restrictedFallbackModel(), model).toBeUndefined();
    }
  });

  it("does not loop when the fallback model is itself unservable", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { sent, fetch } = harness({ restrictedFallback: true, alsoBlocked: [DEFAULT_RESTRICTED_FALLBACK_MODEL] });
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(models(sent)).toEqual([BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
  });
});

describe("usage for a re-targeted call", () => {
  it("lets accounting inside the routing fetch see the model actually sent", async () => {
    setOpenRouterProviderPolicyResolver(RESTRICTED);
    const { upstream } = harness();
    const accounting = createOpenRouterUsageCapture(upstream as unknown as typeof fetch);
    await (await createOpenRouterRoutingFetch(accounting.fetch, { restrictedFallback: true })(CHAT, textRequest())).text();
    expect(servedTextModel(BLOCKED, accounting.sentModel())).toEqual({ model: DEFAULT_RESTRICTED_FALLBACK_MODEL, regionFallback: true });
  });

  it("keeps pricing a speed-boost call as its requested model", () => {
    expect(servedTextModel(OPEN, `${OPEN}:nitro`)).toEqual({ model: OPEN, regionFallback: false });
    expect(servedTextModel(OPEN, undefined)).toEqual({ model: OPEN, regionFallback: false });
  });
});
