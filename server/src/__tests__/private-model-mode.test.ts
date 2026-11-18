import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setPrivateModelEndpointRegistryForTests } from "@docslurp/shared";

const spend = vi.hoisted(() => vi.fn(async () => {}));
const mocks = vi.hoisted(() => ({ record: vi.fn(), sql: vi.fn((..._args: unknown[]) => Promise.resolve([])) }));
vi.mock("../services/billing/spend-guard.js", () => ({ assertCanSpend: spend }));
vi.mock("../db.js", () => ({ sql: Object.assign(mocks.sql, { begin: vi.fn(), array: vi.fn(), json: vi.fn() }) }));
vi.mock("../lib/ai-usage.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/ai-usage.js")>()), recordUsageEvent: mocks.record }));

const { rerankHosted, privateRerankModelFor, HOSTED_RERANK_MODEL } = await import("../search/hosted-rerank.js");
const { rerankBM25 } = await import("../search/rerank.js");
const { createSearchSessionJournal } = await import("../search/session.js");
const { privateTextModelForProject } = await import("../lib/privacy.js");
const { ProjectChatVoice, privateSttModelFor } = await import("../lib/chat-voice.js");

const BASE_URL = "https://gpu-mode.example.com/v1";
const RERANK = "llm://private/gpu/acme/rerank";
const TEXT = "llm://private/gpu/acme/text-llm";
const STT = "llm://private/gpu/acme/stt";
const registry = [{
  alias: "gpu",
  baseUrl: BASE_URL,
  auth: { tokenEnv: "TEST_MODE_APP_TOKEN" },
  models: [
    { id: "acme/text-llm", capability: "text" },
    { id: "acme/rerank", capability: "rerank" },
    { id: "acme/stt", capability: "stt" },
  ],
  attestation: { tenancy: "single-tenant", hostProvider: "self", region: "us-east" },
  pricing: { usdPerMTokInput: 0.02 },
}];

const chunks = [{ id: "a", text: "Quarterly revenue beat estimates.", score: 1 }, { id: "b", text: "The flight to London departs at nine.", score: 0.5 }];
const session = () => createSearchSessionJournal({ rootSessionId: "private-mode-ranking", scope: { orgId: "o", projectId: "w" } });
const rerankArgs = (privacyMode: "standard" | "local-only" | "strict-privacy" = "standard") => ({
  query: "flight to London", chunks, model: HOSTED_RERANK_MODEL, apiKey: "private-endpoint", privacyMode,
  scope: { orgId: "o", projectId: "w" }, session: session(),
});
const http = vi.fn();

beforeEach(() => {
  setPrivateModelEndpointRegistryForTests(registry);
  spend.mockReset().mockResolvedValue(undefined);
  http.mockReset();
  vi.stubGlobal("fetch", http);
  vi.stubEnv("TEST_MODE_APP_TOKEN", "app-secret");
});

afterEach(() => {
  setPrivateModelEndpointRegistryForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("private model mode: reranking", () => {
  it("private mode reranks a standard project on the mapped endpoint and records the private route", async () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    vi.stubEnv("DOCSLURP_PRIVATE_RERANK_MODEL", RERANK);
    http.mockResolvedValue(Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }], usage: { total_tokens: 40 } }));
    const input = rerankArgs();
    const ranked = await rerankHosted(input);
    expect(ranked.map((chunk) => chunk.id)).toEqual(["b", "a"]);
    const [url, init] = http.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/rerank`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer app-secret");
    expect(JSON.parse(init.body)).toEqual({ model: "acme/rerank", query: input.query, documents: chunks.map((chunk) => chunk.text) });
    const [usage] = input.session.usageEvents();
    expect(usage).toMatchObject({ provider: "private", model: "gpu/acme/rerank", inputTokens: 40 });
    expect(JSON.stringify(usage)).not.toContain("example.com");
    expect(JSON.stringify(usage)).not.toContain("app-secret");
  });

  it("hosted mode reranks a restricted project on the mapped endpoint; a standard one keeps the hosted reranker", async () => {
    vi.stubEnv("DOCSLURP_PRIVATE_RERANK_MODEL", RERANK);
    expect(privateRerankModelFor("standard")).toBeUndefined();
    expect(privateRerankModelFor("local-only")).toBe(RERANK);
    http.mockResolvedValue(Response.json({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }));
    await rerankHosted(rerankArgs("local-only"));
    expect(http.mock.calls[0]![0]).toBe(`${BASE_URL}/rerank`);
  });

  it("private mode with no rerank mapping refuses the hosted reranker without any call", async () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    const input = rerankArgs();
    expect(await rerankHosted(input)).toEqual(rerankBM25(input.query, chunks));
    expect(http).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
    expect(input.session.diagnostics().hostedRerank).toMatchObject({ provider: "deepinfra", reason: "privacy_blocked" });
  });

  it("a malformed private response falls back to keyword ranking", async () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    vi.stubEnv("DOCSLURP_PRIVATE_RERANK_MODEL", RERANK);
    http.mockResolvedValue(Response.json({ results: [{ index: 0, relevance_score: 0.9 }] }));
    const input = rerankArgs();
    expect(await rerankHosted(input)).toEqual(rerankBM25(input.query, chunks));
    expect(input.session.diagnostics().hostedRerank).toMatchObject({ provider: "private", reason: "invalid_scores" });
  });
});

describe("private model mode: text and speech-to-text", () => {
  it("chat text uses the mapped model for every project in private mode and none when unmapped", () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    expect(privateTextModelForProject("standard")).toBeUndefined();
    vi.stubEnv("DOCSLURP_PRIVATE_TEXT_MODEL", TEXT);
    expect(privateTextModelForProject("standard")).toBe(TEXT);
  });

  it("voice input uses the mapped STT model in private mode and is off without one, even with a hosted key", async () => {
    vi.stubEnv("DOCSLURP_MODEL_MODE", "private");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    const voice = new ProjectChatVoice({ userId: "u", scope: { orgId: "o", projectId: "w" } }, "standard");
    expect(await voice.getListener()).toEqual({ enabled: false });
    vi.stubEnv("DOCSLURP_PRIVATE_STT_MODEL", STT);
    expect(privateSttModelFor("standard")).toBe(STT);
    expect(await voice.getListener()).toEqual({ enabled: true });
  });

  it("hosted mode keeps hosted STT for standard projects", () => {
    vi.stubEnv("DOCSLURP_PRIVATE_STT_MODEL", STT);
    expect(privateSttModelFor("standard")).toBeUndefined();
    expect(privateSttModelFor("strict-privacy")).toBe(STT);
  });
});
