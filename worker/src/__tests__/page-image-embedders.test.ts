import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrivateModelEndpointRegistryForTests } from "@docslurp/shared";

import {
  createGeminiPageEmbedder,
  createPrivateEndpointPageEmbedder,
  GEMINI_PAGE_EMBED_MODEL,
  JINA_NANO_MODEL_SUFFIX,
  resolvePageImageEmbedder,
} from "../deferred/page-image-embedders.js";

const jpeg = (n: number) => ({ jpeg: new Uint8Array([0xff, 0xd8, n]) });

describe("Gemini page embedder", () => {
  it("batches by 8, sends inline jpeg with no text, and prices promptTokenCount", async () => {
    const bodies: any[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      urls.push(String(url));
      const body = JSON.parse(init.body);
      bodies.push(body);
      return Response.json({
        embeddings: body.requests.map(() => ({ values: [0.5, -0.5, 1, 0] })),
        usageMetadata: { promptTokenCount: body.requests.length * 258 },
      });
    }) as unknown as typeof fetch;
    const embedder = createGeminiPageEmbedder({ apiKey: "k", fetchImpl });
    const out = await embedder.embedImages(Array.from({ length: 10 }, (_, i) => jpeg(i)));
    expect(bodies.map((b) => b.requests.length)).toEqual([8, 2]);
    expect(urls[0]).toContain("models/gemini-embedding-2:batchEmbedContents");
    const part = bodies[0].requests[0].content.parts[0];
    expect(part.inline_data.mime_type).toBe("image/jpeg");
    expect(part.text).toBeUndefined();
    expect(out.vectors).toHaveLength(10);
    expect(out.inputTokens).toBe(2580);
    expect(out.costCents).toBeCloseTo((2580 * 0.45) / 1e6 * 100, 10);
    expect(embedder.model).toBe(GEMINI_PAGE_EMBED_MODEL);
  });

  it("sends query text verbatim with no task prefix", async () => {
    let sent: any;
    const fetchImpl = (async (_url: any, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ embeddings: [{ values: [1, 2] }], usageMetadata: { promptTokenCount: 3 } });
    }) as unknown as typeof fetch;
    const embedder = createGeminiPageEmbedder({ apiKey: "k", fetchImpl });
    await embedder.embedQueryText!("quarterly revenue chart");
    expect(sent.requests[0].content.parts).toEqual([{ text: "quarterly revenue chart" }]);
  });

  it("fails loudly on HTTP errors", async () => {
    const fetchImpl = (async () => new Response("quota", { status: 429 })) as unknown as typeof fetch;
    await expect(createGeminiPageEmbedder({ apiKey: "k", fetchImpl }).embedImages([jpeg(1)])).rejects.toThrow(/429/);
  });
});

const registry = [{
  alias: "gpu1",
  baseUrl: "https://gpu1.example.com/v1",
  auth: { tokenEnv: "TEST_PAGE_EMBED_TOKEN" },
  models: [{ id: `jinaai/${JINA_NANO_MODEL_SUFFIX}`, capability: "embedding", dimensions: 768 }],
  attestation: { tenancy: "single-tenant", hostProvider: "runpod", region: "us-east" },
  pricing: { usdPerMTokInput: 0.1 },
}];
const MODEL_URI = `llm://private/gpu1/jinaai/${JINA_NANO_MODEL_SUFFIX}`;

describe("private endpoint page embedder", () => {
  beforeEach(() => {
    setPrivateModelEndpointRegistryForTests(registry);
    process.env.TEST_PAGE_EMBED_TOKEN = "secret";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setPrivateModelEndpointRegistryForTests(undefined);
    delete process.env.TEST_PAGE_EMBED_TOKEN;
  });

  it("posts image_url data URIs to /embeddings and prices from the endpoint", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), body });
      return Response.json({
        data: body.input.map((_: unknown, index: number) => ({ index, embedding: [0.1, -0.2, 0.3] })),
        usage: { prompt_tokens: 100 },
      });
    }));
    const embedder = createPrivateEndpointPageEmbedder({ modelUri: MODEL_URI });
    expect(embedder.dims).toBe(768);
    const out = await embedder.embedImages([jpeg(1), jpeg(2)]);
    expect(calls[0]!.url).toBe("https://gpu1.example.com/v1/embeddings");
    expect(calls[0]!.body.model).toBe(`jinaai/${JINA_NANO_MODEL_SUFFIX}`);
    const item = calls[0]!.body.input[0].content[0];
    const [prompt, image] = calls[0]!.body.input[0].content;
    expect(prompt).toEqual({ type: "text", text: "Document: " });
    expect(image.type).toBe("image_url");
    expect(image.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(item).toEqual(prompt);
    expect(out.vectors).toHaveLength(2);
    expect(out.inputTokens).toBe(100);
    expect(out.costCents).toBeCloseTo((100 * 0.1) / 1e6 * 100, 10);
  });

  it("prefixes queries with 'Query: '", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return Response.json({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 2 } });
    }));
    await createPrivateEndpointPageEmbedder({ modelUri: MODEL_URI }).embedQueryText!("bridge diagram");
    expect(sent.input).toEqual(["Query: bridge diagram"]);
  });

  it("resolve prefers the jina private endpoint over Gemini", () => {
    const env = { GOOGLE_GENERATIVE_AI_API_KEY: "g" } as NodeJS.ProcessEnv;
    expect(resolvePageImageEmbedder({ route: "auto", privacyMode: "standard", env })!.model).toContain(JINA_NANO_MODEL_SUFFIX);
    expect(resolvePageImageEmbedder({ route: "gemini", privacyMode: "standard", env })!.model).toBe(GEMINI_PAGE_EMBED_MODEL);
  });

  it("resolve falls back to Gemini, honours privacy, and returns null when nothing is configured", () => {
    setPrivateModelEndpointRegistryForTests([]);
    const env = { GOOGLE_GENERATIVE_AI_API_KEY: "g" } as NodeJS.ProcessEnv;
    expect(resolvePageImageEmbedder({ route: "auto", privacyMode: "standard", env })!.model).toBe(GEMINI_PAGE_EMBED_MODEL);
    expect(resolvePageImageEmbedder({ route: "auto", privacyMode: "strict-privacy", env })).toBeNull();
    expect(resolvePageImageEmbedder({ route: "jina-private", privacyMode: "standard", env })).toBeNull();
    expect(resolvePageImageEmbedder({ route: "auto", privacyMode: "standard", env: {} })).toBeNull();
  });
});
