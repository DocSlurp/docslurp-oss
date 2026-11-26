import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TenantModelEndpointRefusedError, visionConfigSchema, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { MemoryVisionAttemptBackend } from "../lib/vision-attempt-guard.js";
import type { EmbeddingProfile } from "../models.js";
import { embedTextChunks } from "../stages/embedding-runtime.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, resolveVisionApiKey, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";

/**
 * DocSlurp/app issue 101: a model endpoint named by tenant settings never receives a platform key, refused
 * destinations are never contacted, and the endpoint's response bodies never reach tenant-visible results.
 * A real loopback HTTP server stands in for the tenant's endpoint so the received headers are asserted directly.
 */
const PLATFORM_KEYS = ["platform-openrouter-key", "platform-openai-key", "platform-deepinfra-key", "platform-perplexity-key"];
const cfg = {
  openRouterApiKey: PLATFORM_KEYS[0], openAiApiKey: PLATFORM_KEYS[1], deepInfraApiKey: PLATFORM_KEYS[2], perplexityApiKey: PLATFORM_KEYS[3],
  openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;
const SECRET_BODY = "INTERNAL-ONLY-BODY service-token=abc123";
const DIRECT = "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct";

type Received = { path: string; headers: IncomingHttpHeaders };
let server: Server;
let origin: string;
let received: Received[];
let respond: (path: string) => { status: number; body: unknown };

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers });
      const reply = respond(request.url ?? "");
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const realFetch = globalThis.fetch;
let offHost: string[];
beforeEach(() => {
  received = [];
  offHost = [];
  respond = () => ({ status: 500, body: SECRET_BODY });
  resetStreamingSupportForTest();
  vi.stubEnv("AI_PROVIDER_MAX_RETRIES", "0");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  // Loopback requests reach the real mock server; anything else is answered here and recorded (no real provider call).
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(origin)) return realFetch(input, init);
    offHost.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "Fallback text" }, finish_reason: "stop" }], usage: { prompt_tokens: 1_000, completion_tokens: 100 } }),
      { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function headerText(headers: IncomingHttpHeaders): string {
  return JSON.stringify(headers);
}

function expectNoPlatformKey(requests: Received[]) {
  for (const request of requests) {
    for (const key of PLATFORM_KEYS) expect(headerText(request.headers)).not.toContain(key);
  }
}

async function visionRead(vision: VisionConfig) {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "key-egress-"));
  try {
    const imagePath = join(dir, "page.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const host = { run: { id: "run-1", orgId: "org-1" }, visionAttempts: new MemoryVisionAttemptBackend() };
    return await guardedVisionCall({
      host, vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "region" }, record: () => null,
      call: (gate) => executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate }),
    }).catch((error: unknown) => error);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("vision", () => {
  it("a tenant loopback endpoint gets no platform key, and its error body never reaches the fallback reason", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const vision = visionConfigSchema.parse({ modelUri: `llm://vllm/acme/plain-vl?baseUrl=${encodeURIComponent(`${origin}/v1`)}`, remoteFallbackModelUri: DIRECT });
    const outcome = await visionRead(vision);
    const result = (outcome as { result: VisionExecutionResult }).result;
    expect(received.length).toBeGreaterThan(0);
    expectNoPlatformKey(received);
    expect(result.fallbackUsed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("INTERNAL-ONLY-BODY");
    expect(JSON.stringify(result)).not.toContain("service-token");
    expect(result.fallbackReason).toBe("unavailable");
  });

  it("a refused routing body is reduced to a code too", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = () => ({ status: 404, body: { error: { message: `No endpoints found matching your data policy ${SECRET_BODY}` } } });
    const vision = visionConfigSchema.parse({ modelUri: `llm://vllm/acme/plain-vl?baseUrl=${encodeURIComponent(`${origin}/v1`)}`, remoteFallbackModelUri: DIRECT });
    const outcome = await visionRead(vision);
    const result = (outcome as { result?: VisionExecutionResult }).result;
    const visible = JSON.stringify(result ?? { message: (outcome as Error).message });
    expect(visible).not.toContain("INTERNAL-ONLY-BODY");
  });

  it("with the flag off, a tenant loopback endpoint is never contacted", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "false");
    const vision = visionConfigSchema.parse({ modelUri: `llm://vllm/acme/plain-vl?baseUrl=${encodeURIComponent(`${origin}/v1`)}` });
    const outcome = await visionRead(vision);
    expect(outcome).toBeInstanceOf(TenantModelEndpointRefusedError);
    expect((outcome as TenantModelEndpointRefusedError).code).toBe("tenant-local-endpoints-disabled");
    expect(received).toEqual([]);
    expect(offHost).toEqual([]);
  });

  it.each([
    ["openai", "https://api.openai.com.evil.example/v1"],
    ["openai", "https://api.openai.com@evil.example/v1"],
    ["openai", "https://api.openai.com:8443/v1"],
    ["openai", "http://api.openai.com/v1"],
    ["openrouter", "https://openrouter.ai.evil.example/api/v1"],
    ["openrouter", "https://openrouter.ai@evil.example/api/v1"],
    ["openrouter", "https://openrouter.ai:444/api/v1"],
    ["deepinfra", "https://api.deepinfra.com.evil.example/v1/openai"],
    ["deepinfra", "https://evil.example/v1/openai"],
  ] as const)("a %s look-alike destination %s gets no key", (billing, destination) => {
    expect(resolveVisionApiKey(billing, destination, cfg)).toBe("");
  });

  it("each provider's own endpoint gets its own key, and only that one", () => {
    expect(resolveVisionApiKey("openrouter", "https://openrouter.ai/api/v1", cfg)).toBe(PLATFORM_KEYS[0]);
    expect(resolveVisionApiKey("openai", "https://api.openai.com/v1", cfg)).toBe(PLATFORM_KEYS[1]);
    expect(resolveVisionApiKey("deepinfra", "https://api.deepinfra.com/v1/openai", cfg)).toBe(PLATFORM_KEYS[2]);
    // A key never crosses providers, even at another provider's real endpoint.
    expect(resolveVisionApiKey("openai", "https://openrouter.ai/api/v1", cfg)).toBe("");
    expect(resolveVisionApiKey("loopback", `${origin}/v1`, cfg)).toBe("");
    expect(resolveVisionApiKey("unknown-hosted", "https://api.openai.com/v1", cfg)).toBe("");
  });
});

describe("embeddings", () => {
  const profile = (baseUrl: string): EmbeddingProfile => ({
    profile: "good-fast-local", target: "local", modelUri: `llm://vllm/nomic-embed-text-v1.5?baseUrl=${encodeURIComponent(baseUrl)}`,
    runtime: "remote", provider: "vllm", model: "nomic-embed-text-v1.5", baseUrl, dimensions: 4, task: "document",
    normalize: true, batchSize: 8, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: true,
  });

  it("a tenant loopback embedding server gets no platform key", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = () => ({ status: 200, body: { object: "list", model: "nomic-embed-text-v1.5", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }], usage: { prompt_tokens: 3, total_tokens: 3 } } });
    const result = await embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: profile(`${origin}/v1`), config: cfg });
    expect(result.vectors).toHaveLength(1);
    expect(received).toHaveLength(1);
    expectNoPlatformKey(received);
  });

  it.each([
    "http://169.254.169.254/v1",
    "http://10.0.0.5:8000/v1",
    "http://[fdaa::3]:8080/v1",
    "http://worker.internal:8080/v1",
    "http://localhost.evil.example/v1",
  ])("a resolved profile at %s is refused at call time, even with the flag on", async (baseUrl) => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: profile(baseUrl), config: cfg }))
      .rejects.toBeInstanceOf(TenantModelEndpointRefusedError);
    expect(offHost).toEqual([]);
    expect(received).toEqual([]);
  });

  it("with the flag off, a loopback profile is refused before any request", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "false");
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: profile(`${origin}/v1`), config: cfg }))
      .rejects.toThrow("Tenant-selected local model endpoints are disabled");
    expect(received).toEqual([]);
  });
});
