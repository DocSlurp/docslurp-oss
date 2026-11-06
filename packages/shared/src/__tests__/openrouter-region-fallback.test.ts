import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createOpenRouterRoutingFetch, DEFAULT_RESTRICTED_FALLBACK_MODEL, isTextOnlyRequest, resetRegionBlockedModels,
  restrictedFallbackModel, setOpenRouterProviderPolicyResolver,
} from "../openrouter-routing.js";
import { createOpenRouterUsageCapture } from "../openrouter-usage.js";
import { CHINA_PROVIDER_SLUGS, providerRegion } from "../provider-regions.js";

const CHAT = "https://openrouter.ai/api/v1/chat/completions";
const BLOCKED = "qwen/qwen3.5-flash-02-23";
const noAllowedProviders = () => new Response(JSON.stringify({ error: { code: 404,
  message: `No allowed providers are available for the selected model. Providers serving ${BLOCKED}: alibaba` } }), { status: 404 });
const ok = () => new Response(JSON.stringify({ id: "gen-1", model: DEFAULT_RESTRICTED_FALLBACK_MODEL, choices: [] }), { status: 200, headers: { "content-type": "application/json" } });

/** A routing fetch whose upstream answers 404 for the blocked model and 200 otherwise, recording each body sent. */
function harness() {
  const sent: Array<Record<string, any>> = [];
  const upstream = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return body.model === BLOCKED ? noAllowedProviders() : ok();
  });
  return { sent, upstream, fetch: createOpenRouterRoutingFetch(upstream as unknown as typeof fetch) };
}
const textRequest = (extra: Record<string, unknown> = {}) => ({ method: "POST", body: JSON.stringify({
  model: BLOCKED, reasoning: { enabled: false }, messages: [{ role: "user", content: "Extract a graph." }], ...extra }) });

beforeEach(() => { resetRegionBlockedModels(); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { setOpenRouterProviderPolicyResolver(undefined); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("restricted-provider fallback", () => {
  it("re-sends a restricted text request whose model has no non-China host to the fallback, still restricted", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const { sent, fetch } = harness();
    const response = await fetch(CHAT, textRequest());
    expect(response.status).toBe(200);
    expect(sent.map((body) => body.model)).toEqual([BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
    const retry = sent[1]!;
    // The fallback model cannot disable reasoning; it gets its verified floor instead.
    expect(retry.reasoning).toEqual({ effort: "minimal" });
    for (const slug of CHINA_PROVIDER_SLUGS) expect(retry.provider.ignore).toContain(slug);
    for (const slug of retry.provider.only) expect(providerRegion(slug), slug).toBe("other");
  });

  it("remembers the block, so later requests go straight to the fallback", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const { sent, fetch } = harness();
    await fetch(CHAT, textRequest());
    await fetch(CHAT, textRequest());
    expect(sent.map((body) => body.model)).toEqual([BLOCKED, DEFAULT_RESTRICTED_FALLBACK_MODEL, DEFAULT_RESTRICTED_FALLBACK_MODEL]);
    expect(sent[2]!.provider.only.every((slug: string) => providerRegion(slug) === "other")).toBe(true);
  });

  it("never re-targets a request that allows China-based providers", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: true }));
    const { sent, fetch } = harness();
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(sent.map((body) => body.model)).toEqual([BLOCKED]);
  });

  it("never re-targets image, file or audio requests, which the text-only fallback cannot read", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const { sent, fetch } = harness();
    const image = textRequest({ messages: [{ role: "user", content: [{ type: "text", text: "Transcribe" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] });
    expect((await fetch(CHAT, image)).status).toBe(404);
    expect(sent.map((body) => body.model)).toEqual([BLOCKED]);
    expect(isTextOnlyRequest({ input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] })).toBe(false);
    expect(isTextOnlyRequest({ messages: [{ role: "user", content: [{ type: "input_audio", input_audio: {} }] }] })).toBe(false);
    expect(isTextOnlyRequest({ messages: [{ role: "user", content: [{ type: "text", text: "type: image_url" }] }] })).toBe(true);
  });

  it("never re-targets embeddings, or a 404 that is not a provider restriction", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { code: 404, message: "Model not found" } }), { status: 404 }));
    const fetch = createOpenRouterRoutingFetch(upstream as unknown as typeof globalThis.fetch);
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(1);
    const { sent, fetch: blocked } = harness();
    await blocked("https://openrouter.ai/api/v1/embeddings", { method: "POST", body: JSON.stringify({ model: BLOCKED, input: ["text"] }) });
    expect(sent.map((body) => body.model)).toEqual([BLOCKED]);
  });

  it("can be turned off or pointed at another model", async () => {
    vi.stubEnv("OPENROUTER_RESTRICTED_FALLBACK_MODEL", "none");
    expect(restrictedFallbackModel()).toBeUndefined();
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const { sent, fetch } = harness();
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(sent).toHaveLength(1);
    vi.stubEnv("OPENROUTER_RESTRICTED_FALLBACK_MODEL", "google/gemma-4-26b-a4b-it");
    expect(restrictedFallbackModel()).toBe("google/gemma-4-26b-a4b-it");
  });

  it("does not loop when the fallback model is itself unservable", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const upstream = vi.fn(async () => noAllowedProviders());
    const fetch = createOpenRouterRoutingFetch(upstream as unknown as typeof globalThis.fetch);
    expect((await fetch(CHAT, textRequest())).status).toBe(404);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("lets usage accounting see the model actually sent", async () => {
    setOpenRouterProviderPolicyResolver(() => ({ allowChinaProviders: false }));
    const { upstream } = harness();
    const accounting = createOpenRouterUsageCapture(upstream as unknown as typeof fetch);
    await (await createOpenRouterRoutingFetch(accounting.fetch)(CHAT, textRequest())).text();
    expect(accounting.sentModel()).toBe(DEFAULT_RESTRICTED_FALLBACK_MODEL);
  });
});
