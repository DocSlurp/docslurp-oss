import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { TenantModelEndpointRefusedError, visionConfigSchema, type VisionConfig } from "@docslurp/shared";

import type { Config } from "../config.js";
import { guardedVisionCall } from "../lib/guarded-vision-call.js";
import { PlatformModelBaseUrlError } from "../lib/platform-model-keys.js";
import { fetchWithProviderRetry, ProviderRequestError, ProviderRetryableError } from "../lib/provider-retry.js";
import { MemoryVisionAttemptBackend } from "../lib/vision-attempt-guard.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import type { EmbeddingProfile } from "../models.js";
import { embedTextChunks } from "../stages/embedding-runtime.js";
import { buildFailedVisionAttemptUsage } from "../stages/vision-extract.js";
import { CommandRunner } from "../tools/runner.js";
import { executeVisionRuntime, resolveVisionApiKey, runVisionRequest, type VisionExecutionResult } from "../tools/vision-runtime.js";
import { resetStreamingSupportForTest } from "../tools/vision-stream.js";

/**
 * DocSlurp/app issue 101: a model endpoint named by tenant settings never receives a platform key, refused
 * destinations are never contacted, requests never follow redirects, and a model server's response text never
 * reaches a stored or tenant-visible error. Real loopback HTTP servers stand in for providers and tenant endpoints,
 * so the headers each request carried are asserted where they were received.
 *
 * Test names marked "(regression guard)" also pass on `main`: they pin behaviour this change must keep.
 */
const PLATFORM_KEYS = ["platform-openrouter-key", "platform-openai-key", "platform-deepinfra-key", "platform-perplexity-key"];
const baseCfg = {
  openRouterApiKey: PLATFORM_KEYS[0], openAiApiKey: PLATFORM_KEYS[1], deepInfraApiKey: PLATFORM_KEYS[2], perplexityApiKey: PLATFORM_KEYS[3],
  openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03, visionStreaming: false,
} as Config;
let cfg: Config = baseCfg;
const MARKER = "INTERNAL-ONLY-BODY service-token=abc123";
const DIRECT = "llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct";
const COMPLETION = { id: "gen-1", model: "m", choices: [{ message: { content: "Page text" }, finish_reason: "stop" }], usage: { prompt_tokens: 1_000, completion_tokens: 100 } };
const EMBEDDING = { object: "list", model: "nomic-embed-text-v1.5", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }], usage: { prompt_tokens: 3, total_tokens: 3 } };

type Received = { path: string; headers: IncomingHttpHeaders; forwardedFrom: string | null };
type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function startServer(onRequest: (path: string, headers: IncomingHttpHeaders) => Reply): Promise<{ server: Server; origin: string; port: number }> {
  const server = createServer((request, response) => {
    request.on("data", () => undefined);
    request.on("end", () => {
      const reply = onRequest(request.url ?? "", request.headers);
      response.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
      response.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as AddressInfo).port;
    resolve({ server, origin: `http://127.0.0.1:${port}`, port });
  }));
}

let main: { server: Server; origin: string; port: number };
let sink: { server: Server; origin: string; port: number };
let received: Received[];
let sinkHits: string[];
let respond: (path: string) => Reply;
let nextForwardedFrom: string | null = null;

beforeAll(async () => {
  main = await startServer((path, headers) => {
    received.push({ path, headers, forwardedFrom: nextForwardedFrom });
    nextForwardedFrom = null;
    // Any redirect points at the sink: a request that followed it would show up there.
    if (path.startsWith("/redir")) return { status: 307, body: "", headers: { location: `${sink.origin}/steal` } };
    return respond(path);
  });
  sink = await startServer((path) => {
    sinkHits.push(path);
    return { status: 200, body: COMPLETION };
  });
});
afterAll(async () => {
  for (const { server } of [main, sink]) await new Promise<void>((resolve) => server.close(() => resolve()));
});

const realFetch = globalThis.fetch;
beforeEach(() => {
  received = [];
  sinkHits = [];
  cfg = baseCfg;
  respond = () => ({ status: 500, body: MARKER });
  resetStreamingSupportForTest();
  vi.stubEnv("AI_PROVIDER_MAX_RETRIES", "0");
  // The mock servers listen on random ports; the operator allow-list names them (and nothing else).
  vi.stubEnv("DOCSLURP_TENANT_LOCAL_MODEL_PORTS", `${main.port},${sink.port}`);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  // Loopback requests reach the real servers. A hosted provider URL is forwarded to the main server with the exact
  // init (headers included) the worker built, so its headers are asserted where received; no real provider is called.
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(main.origin) || url.startsWith(sink.origin)) return realFetch(input, init);
    const parsed = new URL(url);
    nextForwardedFrom = url;
    return realFetch(`${main.origin}/forwarded${parsed.pathname}`, init);
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const headerText = (headers: IncomingHttpHeaders) => JSON.stringify(headers);
function expectNoPlatformKey(requests: Received[]) {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) for (const key of PLATFORM_KEYS) expect(headerText(request.headers)).not.toContain(key);
}
const local = (path = "/v1") => `llm://vllm/acme/plain-vl?baseUrl=${encodeURIComponent(`${main.origin}${path}`)}`;

async function withImage<T>(run: (imagePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "key-egress-"));
  try {
    const imagePath = join(dir, "page.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return await run(imagePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function visionRead(vision: VisionConfig, recorded: WorkerAiUsageInput[] = []) {
  return withImage(async (imagePath) => {
    const host = { run: { id: "run-1", orgId: "org-1" }, visionAttempts: new MemoryVisionAttemptBackend() };
    return await guardedVisionCall({
      host, vision, cfg, target: { documentId: "doc", pageNumber: 1, purpose: "region" },
      record: (input) => { recorded.push(input); return null; },
      call: (gate) => executeVisionRuntime({ imagePath, outputPath: `${imagePath}.json`, vision, cfg, runner: new CommandRunner(), privacyMode: "standard", gate }),
    }).catch((error: unknown) => error);
  });
}

/** One vision request to `baseUrl` with the key the production call site picks for it (`sendRouteVisionRequest`). */
async function visionSend(billing: Parameters<typeof resolveVisionApiKey>[0], baseUrl: string) {
  return withImage((imagePath) => runVisionRequest({
    imagePath, mimeType: "image/png", outputPath: `${imagePath}.json`, runner: new CommandRunner(), runtime: "openai-compatible",
    model: "acme/plain-vl", prompt: "Transcribe.", baseUrl, apiKey: resolveVisionApiKey(billing, baseUrl, cfg), gate: null, streaming: false,
  }).catch((error: unknown) => error));
}

describe("platform keys at the receiving server", () => {
  it("DeepInfra's own endpoint receives the DeepInfra key and no other (regression guard)", async () => {
    respond = () => ({ status: 200, body: COMPLETION });
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: DIRECT }));
    expect((outcome as { result?: VisionExecutionResult }).result?.text).toBe("Page text");
    expect(received).toHaveLength(1);
    expect(received[0]!.forwardedFrom).toBe("https://api.deepinfra.com/v1/openai/chat/completions");
    expect(received[0]!.headers.authorization).toBe(`Bearer ${PLATFORM_KEYS[2]}`);
    for (const key of PLATFORM_KEYS.filter((key) => key !== PLATFORM_KEYS[2])) expect(headerText(received[0]!.headers)).not.toContain(key);
  });

  it("the operator's OPENAI_BASE_URL receives the OpenAI key on embeddings (regression guard)", async () => {
    cfg = { ...baseCfg, openAiBaseUrl: `${main.origin}/v1` };
    respond = () => ({ status: 200, body: { ...EMBEDDING, data: [{ object: "embedding", index: 0, embedding: [0.5, 0.5, 0.5, 0.5] }] } });
    const profile: EmbeddingProfile = { profile: "cheapest-hosted", target: "hosted", modelUri: "llm://openai/text-embedding-3-small", runtime: "remote", provider: "openai",
      model: "text-embedding-3-small", baseUrl: null, dimensions: 4, task: "document", normalize: true, batchSize: 1, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: true };
    await embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile, config: cfg });
    expect(received).toHaveLength(1);
    expect(received[0]!.forwardedFrom).toBeNull();
    expect(received[0]!.path).toBe("/v1/embeddings");
    expect(received[0]!.headers.authorization).toBe(`Bearer ${PLATFORM_KEYS[1]}`);
  });

  it.each([
    ["openrouter", "https://openrouter.ai.evil.example/api/v1"],
    ["openrouter", "https://openrouter.ai@evil.example/api/v1"],
    ["openrouter", "https://openrouter.ai:444/api/v1"],
    ["openrouter", "https://openrouter.ai/other/v1"],
    ["deepinfra", "https://api.deepinfra.com.evil.example/v1/openai"],
    ["deepinfra", "https://user:pw@api.deepinfra.com/v1/openai"],
    ["deepinfra", "https://api.deepinfra.com:8443/v1/openai"],
    ["openai", "https://api.openai.com.evil.example/v1"],
    ["openai", "https://api.openai.com@evil.example/v1"],
    ["openai", "https://api.openai.com:8443/v1"],
    ["openai", "http://api.openai.com/v1"],
  ] as const)("a %s look-alike %s receives no platform key (regression guard)", async (billing, destination) => {
    respond = () => ({ status: 200, body: COMPLETION });
    await visionSend(billing, destination);
    expect(received).toHaveLength(1);
    expect(received[0]!.forwardedFrom).not.toBeNull();
    expectNoPlatformKey(received);
    expect(received[0]!.headers.authorization).toBeUndefined();
  });

  it("an operator OpenAI base URL on loopback keys only its own host and port, not localhost or another port (regression guard)", async () => {
    cfg = { ...baseCfg, openAiBaseUrl: `${main.origin}/v1` };
    respond = () => ({ status: 200, body: COMPLETION });
    await visionSend("openai", `${main.origin}/v1`);
    expect(received[0]!.headers.authorization).toBe(`Bearer ${PLATFORM_KEYS[1]}`);
    received = [];
    await visionSend("openai", `http://localhost:${main.port}/v1`);
    expectNoPlatformKey(received);
    await visionSend("openai", `${sink.origin}/v1`);
    expect(sinkHits).toHaveLength(1);
  });

  it("a tenant loopback endpoint (flag on) receives no platform key: vision sends no authorization, embeddings the placeholder only (regression guard)", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = (path) => ({ status: 200, body: path.endsWith("/embeddings") ? EMBEDDING : COMPLETION });
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }));
    expect((outcome as { result?: VisionExecutionResult }).result?.text).toBe("Page text");
    expect(received[0]!.path).toBe("/v1/chat/completions");
    expect(received[0]!.headers.authorization).toBeUndefined();
    expectNoPlatformKey(received);
    received = [];
    await embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}/v1`), config: cfg });
    expect(received[0]!.path).toBe("/v1/embeddings");
    expect(received[0]!.headers.authorization).toBe("Bearer local");
    expectNoPlatformKey(received);
  });

  it("an OPENAI_BASE_URL with a query or user info gets a distinct configuration error, not a missing-key error", () => {
    for (const openAiBaseUrl of ["https://gateway.example/v1?api-version=2", "https://user:pw@gateway.example/v1"]) {
      const withBase = { ...baseCfg, openAiBaseUrl };
      expect(() => resolveVisionApiKey("openai", openAiBaseUrl, withBase)).toThrow(PlatformModelBaseUrlError);
      expect(() => resolveVisionApiKey("openai", openAiBaseUrl, withBase)).toThrow(/OPENAI_BASE_URL must be a plain http\(s\) URL/);
    }
  });
});

function embeddingProfile(baseUrl: string): EmbeddingProfile {
  return {
    profile: "good-fast-local", target: "local", modelUri: `llm://vllm/nomic-embed-text-v1.5?baseUrl=${encodeURIComponent(baseUrl)}`,
    runtime: "remote", provider: "vllm", model: "nomic-embed-text-v1.5", baseUrl, dimensions: 4, task: "document",
    normalize: true, batchSize: 8, lateChunking: false, lateChunkingWindow: 2, supportsCustomDimensions: true,
  };
}

describe("remote error text stays out of errors, attempts and usage (no fallback configured)", () => {
  it.each([404, 500, 503])("vision: a %i whose body holds a marker leaves no trace of it", async (status) => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    // A billed-looking body (id and usage) so the failure is recorded as a billed attempt with usage metadata.
    respond = () => ({ status, body: { id: "gen-err", usage: { prompt_tokens: 10, completion_tokens: 0 }, error: { message: MARKER } } });
    const recorded: WorkerAiUsageInput[] = [];
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }), recorded);
    expect(outcome).toBeInstanceOf(Error);
    const error = outcome as Error;
    expect(received.length).toBeGreaterThan(0);
    // The thrown message (what the stage stores as stats.error, the manifest reason and the DocumentStageError) and
    // everything the error carries.
    expect(error.message).not.toContain("INTERNAL-ONLY");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("INTERNAL-ONLY");
    if (status !== 404) expect(error.message).toMatch(new RegExp(`\\(${status}\\)|: ${status}$`));
    // The zero-cost failed attempt the stage records from that message, and any billed attempt's usage metadata.
    const attempt = buildFailedVisionAttemptUsage({ documentId: "doc", pageNumber: 1, rasterArtifactUri: "s3://bucket/page.png", runtime: "openai-compatible", model: "acme/plain-vl", reason: error.message });
    expect(JSON.stringify(attempt)).not.toContain("INTERNAL-ONLY");
    expect(JSON.stringify(recorded)).not.toContain("INTERNAL-ONLY");
    expect(JSON.stringify(recorded)).not.toContain("service-token");
  });

  it("vision: a retryable failure carries its code and status as fields", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = () => ({ status: 503, body: MARKER });
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }));
    expect(outcome).toBeInstanceOf(ProviderRetryableError);
    expect(outcome).toMatchObject({ code: "overloaded", status: 503 });
    expect((outcome as Error).message).toBe("vision request failed after 1 attempt(s): overloaded (503)");
  });

  it("vision: a routing-exclusion body is reduced to a code", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = () => ({ status: 404, body: { error: { message: `No endpoints found matching your data policy ${MARKER}` } } });
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }));
    expect((outcome as Error).message).toBe("no provider meets the request's routing constraints: routing-excluded (404)");
  });

  it("vision: a 200 body that is not JSON fails with a fixed message, not the parser's quote of the body", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = () => ({ status: 200, body: MARKER });
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }));
    expect((outcome as Error).message).not.toContain("INTERNAL-ONLY");
  });

  it.each([404, 500, 503])("embeddings: a %i whose body holds a marker leaves no trace of it", async (status) => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = () => ({ status, body: { error: { message: MARKER, type: "internal" } } });
    const outcome = await embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}/v1`), config: cfg })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(received.length).toBeGreaterThan(0);
    const error = outcome as Error;
    expect(error.message).not.toContain("INTERNAL-ONLY");
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain("INTERNAL-ONLY");
    expect(error.message).toContain(`(${status})`);
    if (status === 404) expect(error).toBeInstanceOf(ProviderRequestError);
    else expect(error).toBeInstanceOf(ProviderRetryableError);
  });
});

describe("tenant loopback base URLs (flag on)", () => {
  beforeEach(() => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    respond = (path) => ({ status: 200, body: path.endsWith("/embeddings") ? EMBEDDING : COMPLETION });
  });

  it.each(["/v1?q=", "/v1?", "/admin?x=/v1", "/v1#", "/v1#frag"])("a base URL ending %s is refused and never contacted", async (suffix) => {
    const vision: VisionConfig = { ...visionConfigSchema.parse({ modelUri: local() }), modelUri: local(suffix) };
    const outcome = await visionRead(vision);
    // Vision reports the catalog's refusal first (visionModelUriProblem shares the loopback shape rule); either way
    // nothing is sent.
    expect(["TenantModelEndpointRefusedError", "UnpricedVisionRouteError"]).toContain((outcome as Error).name);
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}${suffix}`), config: cfg }))
      .rejects.toMatchObject({ code: "tenant-base-url-invalid" });
    expect(received).toEqual([]);
  });

  it("encoded ? and # stay in the path; dot segments (also encoded) are resolved before the endpoint is appended", async () => {
    for (const [path, expected] of [
      ["/v1%3Fq%3D", "/v1%3Fq%3D/chat/completions"],
      ["/v1%23frag", "/v1%23frag/chat/completions"],
      ["/v1/../../admin", "/admin/chat/completions"],
      ["/v1/%2e%2e/%2E%2E/admin", "/admin/chat/completions"],
    ] as const) {
      received = [];
      await visionRead(visionConfigSchema.parse({ modelUri: local(path) }));
      expect(received.map((request) => request.path), path).toEqual([expected]);
      received = [];
      await embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}${path}`), config: cfg });
      expect(received.map((request) => request.path), path).toEqual([expected.replace("/chat/completions", "/embeddings")]);
    }
  });

  it("a port the operator does not allow is refused before any request", async () => {
    vi.stubEnv("DOCSLURP_TENANT_LOCAL_MODEL_PORTS", "11434,8000,1234");
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }));
    expect((outcome as TenantModelEndpointRefusedError).code).toBe("tenant-base-url-port-not-allowed");
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}/v1`), config: cfg }))
      .rejects.toMatchObject({ code: "tenant-base-url-port-not-allowed" });
    expect(received).toEqual([]);
  });

  it("a refused fallback is refused before the primary request is sent", async () => {
    const vision: VisionConfig = { ...visionConfigSchema.parse({ modelUri: local() }), remoteFallbackModelUri: "llm://vllm/acme/plain-vl?baseUrl=http%3A%2F%2F127.0.0.1%3A6379%2Fv1" };
    const outcome = await visionRead(vision);
    expect((outcome as TenantModelEndpointRefusedError).code).toBe("tenant-base-url-port-not-allowed");
    expect(received).toEqual([]);
  });

  it.each([
    "http://169.254.169.254/v1",
    "http://10.0.0.5:8000/v1",
    "http://192.168.1.10:8000/v1",
    "http://[fd12:3456:789a::3]:8080/v1",
    "http://service.internal.example:8080/v1",
    "http://localhost.evil.example/v1",
  ])("a resolved embedding profile at %s is refused at call time (regression guard)", async (baseUrl) => {
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(baseUrl), config: cfg }))
      .rejects.toBeInstanceOf(TenantModelEndpointRefusedError);
    expect(received).toEqual([]);
  });

  it("with the flag off, a tenant loopback endpoint is never contacted (regression guard)", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "false");
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local() }));
    expect((outcome as TenantModelEndpointRefusedError).code).toBe("tenant-local-endpoints-disabled");
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}/v1`), config: cfg }))
      .rejects.toThrow("Tenant-selected local model endpoints are disabled");
    expect(received).toEqual([]);
  });
});

describe("redirects are never followed", () => {
  it("vision: a loopback endpoint that redirects does not get the request resent elsewhere", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    const outcome = await visionRead(visionConfigSchema.parse({ modelUri: local("/redir/v1") }));
    expect(outcome).toBeInstanceOf(Error);
    expect(received.map((request) => request.path)).toEqual(["/redir/v1/chat/completions"]);
    expect(sinkHits).toEqual([]);
  });

  it("embeddings: a loopback endpoint that redirects does not get the request resent elsewhere", async () => {
    vi.stubEnv("DOCSLURP_ALLOW_TENANT_LOCAL_MODEL_ENDPOINTS", "true");
    await expect(embedTextChunks({ privacyMode: "standard", chunks: ["hello"], profile: embeddingProfile(`${main.origin}/redir/v1`), config: cfg })).rejects.toBeInstanceOf(Error);
    expect(received.map((request) => request.path)).toEqual(["/redir/v1/embeddings"]);
    expect(sinkHits).toEqual([]);
  });

  it("fetchWithProviderRetry (the page router's decision client) refuses a redirect while carrying a key", async () => {
    const outcome = await fetchWithProviderRetry(`${main.origin}/redir/decide`, { method: "POST", headers: { authorization: `Bearer ${PLATFORM_KEYS[0]}` }, body: "{}" },
      { provider: "decision-test", label: "decision request", maxRetries: 0 }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(ProviderRetryableError);
    expect(outcome).toMatchObject({ code: "network-error", status: null });
    expect(sinkHits).toEqual([]);
  });
});
