import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configurePrivateCallAudit,
  embeddingConfigSchema,
  isProviderCallAllowed,
  PrivacyModeViolationError,
  resolveEmbeddingRoute,
  setPrivateModelEndpointRegistryForTests,
  visionConfigSchema,
  type PrivacyAuditEntry,
} from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { generateOpenRouterText } from "../lib/ai.js";
import { currentPrivacyAuditScope, openRouterTextCall, runWithPrivacyAuditScope } from "../lib/privacy-guard.js";
import { textUsageLabels } from "../lib/text-model-route.js";
import type { EmbeddingProfile } from "../models.js";
import { embedTextChunks, type RemoteEmbeddingUsage } from "../stages/embedding-runtime.js";
import { executeVisionRuntime } from "../tools/vision-runtime.js";
import { CommandRunner } from "../tools/runner.js";

const BASE_URL = "https://gpu1.example.com/v1";
const TOKEN = "pilot-secret";

const registry = [{
  alias: "gpu1",
  baseUrl: BASE_URL,
  auth: { tokenEnv: "TEST_WORKER_GPU1_TOKEN" },
  models: [
    { id: "Qwen/Qwen3.6-35B-A3B-FP8", capability: "text", chatTemplateKwargs: { enable_thinking: false } },
    { id: "lightonai/LightOnOCR-3-0.8B", capability: "vision" },
    { id: "Qwen/Qwen3-Embedding-0.6B", capability: "embedding", dimensions: 16 },
  ],
  attestation: { tenancy: "single-tenant", hostProvider: "runpod", region: "us-east" },
  pricing: { usdPerMTokInput: 0.5, usdPerMTokOutput: 2 },
}];

type Captured = { url: string; auth: string | null; body: Record<string, unknown> };

function mockPrivateServer() {
  const calls: Captured[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, auth: headers.get("authorization"), body });
    if (url.endsWith("/embeddings")) {
      const inputs = body.input as string[];
      return Response.json({
        object: "list",
        model: body.model,
        data: inputs.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: 16 }, (_, d) => index + d) })),
        usage: { prompt_tokens: inputs.length * 7, total_tokens: inputs.length * 7 },
      });
    }
    if (url.endsWith("/chat/completions")) {
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "A private summary." } }],
        usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const embeddingProfile = (): EmbeddingProfile => {
  const route = resolveEmbeddingRoute(embeddingConfigSchema.parse({ modelUri: "llm://private/gpu1/Qwen/Qwen3-Embedding-0.6B" }));
  return {
    profile: "good-fast-local",
    target: "private",
    modelUri: route.modelUri,
    runtime: route.runtime,
    provider: route.provider,
    model: route.model,
    baseUrl: route.baseUrl,
    dimensions: route.dimensions,
    task: "document",
    normalize: true,
    batchSize: 2,
    lateChunking: false,
    lateChunkingWindow: 2,
  };
};

let audit: PrivacyAuditEntry[];

beforeEach(() => {
  setPrivateModelEndpointRegistryForTests(registry);
  process.env.TEST_WORKER_GPU1_TOKEN = TOKEN;
  audit = [];
  configurePrivateCallAudit({ write: async (entries) => { audit.push(...entries); }, currentScope: currentPrivacyAuditScope });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPrivateModelEndpointRegistryForTests(undefined);
  configurePrivateCallAudit(undefined);
  delete process.env.TEST_WORKER_GPU1_TOKEN;
});

describe("worker private endpoint embeddings", () => {
  it("embeds through the registered endpoint with operator auth, audits and prices each batch", async () => {
    const calls = mockPrivateServer();
    const profile = embeddingProfile();
    expect(profile).toMatchObject({ provider: "private", runtime: "remote", baseUrl: BASE_URL, dimensions: 16 });
    const usage: RemoteEmbeddingUsage[] = [];

    const result = await runWithPrivacyAuditScope({ workspaceId: "ws-1", runId: "run-1" }, () => embedTextChunks({
      privacyMode: "strict-privacy",
      chunks: ["alpha", "beta", "gamma"],
      profile,
      config: fromEnv(),
      onRemoteUsage: async (event) => { usage.push(event); },
    }));

    expect(calls.map((call) => call.url)).toEqual([`${BASE_URL}/embeddings`, `${BASE_URL}/embeddings`]);
    expect(calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls[0]!.body.model).toBe("Qwen/Qwen3-Embedding-0.6B");
    expect(result.vectors).toHaveLength(3);
    expect(result.totalTokens).toBe(21);
    // Actual provider token counts, priced at the operator's $0.50 / 1M input tokens.
    expect(usage.map((event) => event.inputTokens)).toEqual([14, 7]);
    expect(usage[0]!.costCents).toBeCloseTo(14 * 0.5 / 1_000_000 * 100);
    expect(usage[0]!.costMetadata).toMatchObject({ costSource: "private-endpoint-token-rate", endpointAlias: "gpu1", tenancy: "single-tenant" });
    expect(result.costCents).toBeCloseTo(21 * 0.5 / 1_000_000 * 100);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toEqual({
      workspaceId: "ws-1", runId: "run-1", documentId: null,
      modelId: "private/gpu1/Qwen/Qwen3-Embedding-0.6B", endpoint: "private:gpu1:worker.embedding", privacyMode: "strict-privacy",
    });
  });

  it("refuses unregistered aliases before any request leaves", async () => {
    const calls = mockPrivateServer();
    setPrivateModelEndpointRegistryForTests([{ ...registry[0], alias: "other" }]);
    await expect(embedTextChunks({ privacyMode: "local-only", chunks: ["alpha"], profile: embeddingProfile(), config: fromEnv() }))
      .rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(calls).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });
});

describe("worker private endpoint text", () => {
  it("classifies stage gates and generates through chat/completions with usage and cost", async () => {
    const calls = mockPrivateServer();
    const model = "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8";
    expect(isProviderCallAllowed("strict-privacy", openRouterTextCall("document-summary", model))).toBe(true);
    expect(isProviderCallAllowed("strict-privacy", openRouterTextCall("document-summary", "llm://private/gpu2/Qwen/Qwen3.6-35B-A3B-FP8"))).toBe(false);

    const result = await runWithPrivacyAuditScope({ workspaceId: "ws-1", runId: "run-1" }, () => generateOpenRouterText({
      operation: "structured-extraction",
      apiKey: "private-endpoint",
      model,
      prompt: "Summarize.",
      maxOutputTokens: 64,
      privacyMode: "strict-privacy",
      responseJsonSchema: { name: "fields", schema: { type: "object", properties: { a: { type: "string" } } } },
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE_URL}/chat/completions`);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body.model).toBe("Qwen/Qwen3.6-35B-A3B-FP8");
    expect(calls[0]!.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "fields" } });
    // Operator-declared template kwargs (e.g. Qwen3 thinking off) reach the server.
    expect(calls[0]!.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(result.text).toBe("A private summary.");
    expect(result.usage).toMatchObject({ inputTokens: 120, outputTokens: 30, metadata: { costSource: "private-endpoint-token-rate" } });
    expect(result.usage.costCents).toBeCloseTo((120 * 0.5 + 30 * 2) / 1_000_000 * 100);
    expect(textUsageLabels(model)).toEqual({ provider: "private", model: "gpu1/Qwen/Qwen3.6-35B-A3B-FP8" });
    expect(audit.map((entry) => entry.endpoint)).toEqual(["private:gpu1:worker.text.structured-extraction"]);
  });

  it("refuses strict-privacy calls outside an audit scope", async () => {
    const calls = mockPrivateServer();
    await expect(generateOpenRouterText({
      operation: "document-summary", apiKey: "private-endpoint", model: "llm://private/gpu1/Qwen/Qwen3.6-35B-A3B-FP8",
      prompt: "x", maxOutputTokens: 8, privacyMode: "strict-privacy",
    })).rejects.toBeInstanceOf(PrivacyModeViolationError);
    expect(calls).toHaveLength(0);
  });
});

describe("worker private endpoint vision", () => {
  it("sends the page image to the registered endpoint and reports private cost", async () => {
    const calls = mockPrivateServer();
    const dir = await mkdtemp(join(tmpdir(), "private-vision-"));
    const imagePath = join(dir, "page.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await runWithPrivacyAuditScope({ workspaceId: "ws-1", runId: "run-1", documentId: "doc-1" }, () => executeVisionRuntime({
      imagePath,
      outputPath: `${imagePath}.json`,
      vision: visionConfigSchema.parse({ modelUri: "llm://private/gpu1/lightonai/LightOnOCR-3-0.8B", prompt: "markdown" }),
      cfg: fromEnv(),
      runner: new CommandRunner(),
      privacyMode: "strict-privacy",
    }));
    expect(calls[0]!.url).toBe(`${BASE_URL}/chat/completions`);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body.model).toBe("lightonai/LightOnOCR-3-0.8B");
    expect(calls[0]!.body.chat_template_kwargs).toBeUndefined();
    expect(result).toMatchObject({ provider: "private", model: "gpu1/lightonai/LightOnOCR-3-0.8B", inputTokens: 120, outputTokens: 30, usageSource: "provider" });
    expect(result.costCents).toBeCloseTo((120 * 0.5 + 30 * 2) / 1_000_000 * 100);
    expect(audit).toEqual([expect.objectContaining({ workspaceId: "ws-1", documentId: "doc-1", endpoint: "private:gpu1:worker.vision" })]);
  });
});
