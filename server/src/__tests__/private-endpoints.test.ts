import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyModeViolationError, setPrivateModelEndpointRegistryForTests } from "@docslurp/shared";

const mocks = vi.hoisted(() => ({ record: vi.fn(), sql: vi.fn((..._args: unknown[]) => Promise.resolve([])) }));
vi.mock("../db.js", () => ({ sql: mocks.sql }));
vi.mock("../lib/ai-usage.js", () => ({ recordUsageEvent: mocks.record }));

const { embedConfiguredText, generateOpenRouterDocumentText, generateOpenRouterText } = await import("../lib/ai.js");
const { privateTextModelForWorkspace } = await import("../lib/privacy.js");
const { WorkspaceChatVoice, privateSttModelFor, wavDurationSeconds } = await import("../lib/chat-voice.js");

const BASE_URL = "https://gpu1.example.com/v1";
const TEXT = "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8";
const STT = "llm://private/gpu1/CohereLabs/cohere-transcribe-03-2026";
const registry = [{
  alias: "gpu1",
  baseUrl: BASE_URL,
  auth: { tokenEnv: "TEST_APP_GPU1_TOKEN" },
  models: [
    { id: "Qwen/Qwen3.6-35B-A3B-FP8", capability: "text" },
    { id: "Qwen/Qwen3-Embedding-0.6B", capability: "embedding", dimensions: 16 },
    { id: "CohereLabs/cohere-transcribe-03-2026", capability: "stt" },
  ],
  attestation: { tenancy: "single-tenant", hostProvider: "runpod", region: "us-east" },
  pricing: { usdPerMTokInput: 0.5, usdPerMTokOutput: 2 },
}];

const serverFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/chat/completions")) {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; model: string };
    if (body.stream) {
      const frames = [
        { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Private " } }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { content: "answer." }, finish_reason: "stop" }] },
        { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [], usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } },
      ];
      return new Response(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ id: "c1", object: "chat.completion", created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Private answer." } }],
      usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 } });
  }
  if (url.endsWith("/embeddings")) {
    return Response.json({ object: "list", model: "Qwen/Qwen3-Embedding-0.6B",
      data: [{ object: "embedding", index: 0, embedding: Array.from({ length: 16 }, (_, index) => index) }],
      usage: { prompt_tokens: 9, total_tokens: 9 } });
  }
  if (url.endsWith("/audio/transcriptions")) {
    return Response.json({ text: " Private question? ", usage: { type: "duration", seconds: 3 } });
  }
  return new Response("not found", { status: 404 });
});

function authOf(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit | undefined)?.headers).get("authorization");
}

function auditInserts() {
  return mocks.sql.mock.calls.filter((call) => Array.isArray(call[0]) && (call[0] as string[]).join("").includes("insert into privacy_audit_log"));
}

function auditRows() {
  // The rows helper call `sql(rows, ...columns)` precedes each insert template.
  return mocks.sql.mock.calls.filter((call) => Array.isArray(call[0]) && !("raw" in (call[0] as object)) && call[1] === "document_id")
    .flatMap((call) => call[0] as Array<Record<string, unknown>>);
}

beforeEach(() => {
  setPrivateModelEndpointRegistryForTests(registry);
  vi.stubEnv("TEST_APP_GPU1_TOKEN", "app-secret");
  vi.stubGlobal("fetch", serverFetch);
  serverFetch.mockClear();
  mocks.sql.mockClear();
  mocks.record.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setPrivateModelEndpointRegistryForTests(undefined);
});

describe("API private endpoint text", () => {
  it("calls the registered endpoint with operator auth, audits strict-privacy and reports usage", async () => {
    const result = await generateOpenRouterText({
      apiKey: "", operation: "api.search.hyde", model: TEXT, prompt: "Expand this query.", maxOutputTokens: 64,
      privacyMode: "strict-privacy", auditScope: { workspaceId: "ws-1" },
    });
    expect(serverFetch).toHaveBeenCalledOnce();
    expect(serverFetch.mock.calls[0]![0]).toBe(`${BASE_URL}/chat/completions`);
    expect(authOf(serverFetch.mock.calls[0]!)).toBe("Bearer app-secret");
    expect(result.text).toBe("Private answer.");
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, metadata: { costSource: "private-endpoint-token-rate", endpointAlias: "gpu1" } });
    expect(result.usage.costCents).toBeCloseTo((200 * 0.5 + 40 * 2) / 1_000_000 * 100);
    expect(auditInserts()).toHaveLength(1);
    expect(auditRows()).toEqual([expect.objectContaining({
      workspace_id: "ws-1", model_id: "private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8", endpoint: "private:gpu1:api.search.hyde", privacy_mode: "strict-privacy",
    })]);
  });

  it("streams grounded document answers from the private endpoint", async () => {
    const deltas: string[] = [];
    const result = await generateOpenRouterDocumentText({
      apiKey: "", model: TEXT, prompt: "Question?", documents: [{ title: "Doc", text: "Evidence." }], maxOutputTokens: 64,
      privacyMode: "local-only", onTextDelta: (delta) => { deltas.push(delta); },
    });
    expect(deltas.join("")).toBe("Private answer.");
    expect(result.usage).toMatchObject({ inputTokens: 200, outputTokens: 40 });
    expect(auditInserts()).toHaveLength(0);
  });

  it("blocks unregistered aliases without sending anything", async () => {
    await expect(generateOpenRouterText({
      apiKey: "", model: "llm://private/gpu9/Qwen/Qwen3.6-35B-A3B-FP8", prompt: "x", maxOutputTokens: 8,
      privacyMode: "strict-privacy", auditScope: { workspaceId: "ws-1" },
    })).rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(serverFetch).not.toHaveBeenCalled();
    expect(auditInserts()).toHaveLength(0);
  });

  it("selects a private text model only for non-standard workspaces", () => {
    expect(privateTextModelForWorkspace({ textGeneration: { model: TEXT } }, "standard")).toBeUndefined();
    expect(privateTextModelForWorkspace({ textGeneration: { model: TEXT } }, "strict-privacy")).toBe(TEXT);
    expect(privateTextModelForWorkspace({ textGeneration: { model: "qwen/qwen3.5-flash-02-23" } }, "strict-privacy")).toBeUndefined();
    vi.stubEnv("DOCSLURP_PRIVATE_TEXT_MODEL", TEXT);
    expect(privateTextModelForWorkspace({}, "local-only")).toBe(TEXT);
  });
});

describe("API private endpoint embeddings", () => {
  it("embeds queries through the private endpoint with cost", async () => {
    const result = await embedConfiguredText({
      value: "query", runtime: "remote", provider: "private", model: "gpu1/Qwen/Qwen3-Embedding-0.6B",
      modelUri: "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B", privacyMode: "strict-privacy", auditScope: { workspaceId: "ws-1" },
    });
    expect(serverFetch.mock.calls[0]![0]).toBe(`${BASE_URL}/embeddings`);
    expect(authOf(serverFetch.mock.calls[0]!)).toBe("Bearer app-secret");
    expect(result.embedding).toHaveLength(16);
    expect(result.usage.inputTokens).toBe(9);
    expect(result.usage.costCents).toBeCloseTo(9 * 0.5 / 1_000_000 * 100);
    expect(auditRows()).toEqual([expect.objectContaining({ endpoint: "private:gpu1:api.embedding" })]);
  });
});

describe("API private endpoint speech-to-text", () => {
  const context = { userId: "user", scope: { workspaceId: "ws-1", orgId: "org" } };

  it("transcribes through the private endpoint for strict-privacy workspaces and records usage", async () => {
    vi.stubEnv("DOCSLURP_PRIVATE_STT_MODEL", STT);
    expect(privateSttModelFor("standard")).toBeUndefined();
    const voice = new WorkspaceChatVoice(context, "strict-privacy");
    expect(await voice.getListener()).toEqual({ enabled: true });
    expect(await voice.listen(new Blob(["RIFF"], { type: "audio/wav" }))).toBe("Private question?");
    const [url, init] = serverFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/audio/transcriptions`);
    expect(authOf([url, init])).toBe("Bearer app-secret");
    expect((init.body as FormData).get("model")).toBe("CohereLabs/cohere-transcribe-03-2026");
    expect(mocks.record).toHaveBeenCalledWith({ ...context, usage: expect.objectContaining({
      provider: "private", model: "gpu1/CohereLabs/cohere-transcribe-03-2026", metric: "chat.transcription", amount: 3, unit: "second",
      metadata: expect.objectContaining({ endpointAlias: "gpu1", secondsSource: "provider" }),
    }) });
    expect(auditRows()).toEqual([expect.objectContaining({ workspace_id: "ws-1", endpoint: "private:gpu1:api.chat.transcription" })]);
  });

  it("keeps hosted STT disabled when no private route is configured", async () => {
    const voice = new WorkspaceChatVoice(context, "strict-privacy");
    expect(await voice.getListener()).toEqual({ enabled: false });
  });

  it("reads WAV duration from the header", () => {
    const header = new Uint8Array(44 + 32000);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x52494646, false); view.setUint32(8, 0x57415645, false);
    view.setUint32(12, 0x666d7420, false); view.setUint32(16, 16, true); view.setUint32(28, 16000, true);
    view.setUint32(36, 0x64617461, false); view.setUint32(40, 32000, true);
    expect(wavDurationSeconds(header)).toBe(2);
  });
});
