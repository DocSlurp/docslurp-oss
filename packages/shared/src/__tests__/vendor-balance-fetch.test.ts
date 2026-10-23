import { afterEach, expect, it, vi } from "vitest";
vi.mock("../telemetry.js", () => ({ startDependencySpan: () => ({ run: (fn: () => unknown) => fn(), set: vi.fn(), end: vi.fn() }) }));
vi.mock("../vendor-balance-alerts.js", async original => ({ ...await original<typeof import("../vendor-balance-alerts.js")>(), vendorBalanceMonitor: { observe: vi.fn() } }));
import { instrumentFetch } from "../dependency-fetch.js";
import { vendorBalanceMonitor } from "../vendor-balance-alerts.js";
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("observes real upstream quota bodies without consuming or changing SDK response bytes", async () => {
  vi.stubEnv("OPENAI_API_KEY", "platform-test");
  const body = '{"error":{"code":"insufficient_quota","message":"never log my secret"}}';
  const transport = vi.fn(async () => new Response(body, { status: 429 }));
  const response = await instrumentFetch("openai", "embedding", transport)("https://api.openai.com/v1/embeddings", { headers: { authorization: "Bearer platform-test" } });
  expect(await response.text()).toBe(body);
  expect(vendorBalanceMonitor.observe).toHaveBeenLastCalledWith(expect.stringMatching(/^openai:/), "openai", "embedding", 429, body);
});

it("does not treat a customer BYOK quota or DocSlurp402 as platform vendor billing", async () => {
  vi.stubEnv("OPENAI_API_KEY", "platform-test");
  const transport = vi.fn(async () => new Response("insufficient_quota", { status: 402 }));
  for (const [url, key] of [["https://api.openai.com/v1/chat", "customer-key"], ["https://docslurp.io/v1/chat", "platform-test"]]) {
    const response = await instrumentFetch("openai", "chat", transport)(url!, { headers: { authorization: `Bearer ${key}` } });
    await response.text();
  }
  expect(vendorBalanceMonitor.observe).not.toHaveBeenCalled();
});

it("does not recover from headers alone or an error embedded late in a successful stream", async () => {
  vi.stubEnv("OPENAI_API_KEY", "platform-test");
  const transport = vi.fn(async () => new Response('data: ' + 'x'.repeat(20000) + '\n{"error":{"code":"insufficient_quota"}}'));
  const response = await instrumentFetch("openai", "chat", transport)("https://api.openai.com/v1/chat", { headers: { authorization: "Bearer platform-test" } });
  expect(vendorBalanceMonitor.observe).not.toHaveBeenCalled();
  await response.text();
  expect(vendorBalanceMonitor.observe).not.toHaveBeenCalled();
});

it("recovers only after successful response consumption", async () => {
  vi.stubEnv("OPENAI_API_KEY", "platform-test");
  const transport = vi.fn(async () => new Response('{"data":[]}'));
  const response = await instrumentFetch("openai", "embedding", transport)("https://api.openai.com/v1/embeddings", { headers: { authorization: "Bearer platform-test" } });
  expect(vendorBalanceMonitor.observe).not.toHaveBeenCalled();
  await response.text();
  expect(vendorBalanceMonitor.observe).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^openai:/), "openai", "embedding", 200);
});

it("detects SaaS billing error even if the application discards the error body", async () => {
  vi.stubEnv("RESEND_API_KEY", "resend-platform");
  const transport = vi.fn(async () => new Response('{"name":"monthly_quota_exceeded"}', { status: 429 }));
  const response = await instrumentFetch("resend", "email", transport)("https://api.resend.com/emails", { headers: { authorization: "Bearer resend-platform" } });
  expect(response.status).toBe(429);
  expect(vendorBalanceMonitor.observe).toHaveBeenLastCalledWith(expect.stringMatching(/^resend:/), "resend", "email", 429, '{"name":"monthly_quota_exceeded"}');
  await response.body?.cancel();
});

it("uses effective Fetch header replacement rather than inherited platform authorization", async () => {
  vi.stubEnv("OPENAI_API_KEY", "platform-test");
  const transport = vi.fn(async () => new Response("payment required", { status: 402 }));
  for (const headers of [new Headers(), new Headers({ "content-type": "application/json" })]) {
    const request = new Request("https://api.openai.com/v1/chat", { headers: { authorization: "Bearer platform-test" } });
    const response = await instrumentFetch("openai", "chat", transport)(request, { headers });
    await response.text();
  }
  expect(vendorBalanceMonitor.observe).not.toHaveBeenCalled();
});

it("alerts on HTTP200 SSE upstream billing errors, never assistant-generated billing text", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "router-platform");
  const body = 'data: {"choices":[{"delta":{"content":"{\\"error\\":{\\"code\\":402}} insufficient_quota"}}]}\n\ndata: {"error":{"code":402,"message":"Insufficient credits"}}\n\n';
  const transport = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const response = await instrumentFetch("openrouter", "chat", transport)("https://openrouter.ai/api/v1/chat/completions", { headers: { authorization: "Bearer router-platform" } });
  expect(await response.text()).toBe(body);
  expect(vendorBalanceMonitor.observe).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^openrouter:/), "openrouter", "chat", 200, '{"error":{"code":402,"message":"Insufficient credits"}}');
});
