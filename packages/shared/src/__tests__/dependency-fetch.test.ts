import { afterAll, expect, it, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initializeObservability, shutdownObservability, withObservation, instrumentFetch } from "../observability.js";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const exporter = new InMemorySpanExporter();
initializeObservability({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it("keeps streaming lazy and spans open until consumed, with request-chain correlation", async () => {
  let reads = 0;
  const http = vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new TextEncoder().encode("answer")); controller.close(); },
  }, { highWaterMark: 0 }), { headers: { "x-request-id": "provider-id" } }));
  await withObservation({ name: "stream-root", metadata: { runId: "run-stream", projectId: "project-stream" } }, async () => {
    const response = await instrumentFetch("deepinfra", "embedding", http)("https://api.example.test/v1/inference?key=secret");
    expect(reads).toBe(0);
    expect(exporter.getFinishedSpans().some(span => span.name === "deepinfra.embedding")).toBe(false);
    expect(await response.text()).toBe("answer");
  });
  expect(http).toHaveBeenCalledTimes(1);
  const spans = exporter.getFinishedSpans();
  const child = spans.find(span => span.name === "deepinfra.embedding")!;
  const root = spans.find(span => span.name === "stream-root")!;
  expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(child.attributes).toMatchObject({ "server.address": "api.example.test", "http.response.body.size": 6,
    "docslurp.runId": "run-stream", "docslurp.projectId": "project-stream" });
  expect(JSON.stringify(child.attributes)).not.toContain("secret");
});

it("normalizes transport and body errors without repeating requests", async () => {
  const error = new Error("transport failure");
  const http = vi.fn(async () => { throw error; });
  await expect(instrumentFetch("test", "failed", http)("https://example.test")).rejects.toThrow("Provider request failed");
  expect(http).toHaveBeenCalledTimes(1);
  const brokenBody = new Response(new ReadableStream({ pull(controller) { controller.error(error); } }));
  const response = await instrumentFetch("test", "body-failed", async () => brokenBody)("https://example.test");
  await expect(response.text()).rejects.toThrow("Provider request failed");
  for (const name of ["test.failed", "test.body-failed"]) expect(exporter.getFinishedSpans().find(span => span.name === name)?.status.code).toBe(2);
});

it("propagates cancellation and handles bodyless responses", async () => {
  const cancel = vi.fn();
  const response = await instrumentFetch("test", "cancel", async () => new Response(new ReadableStream({ cancel }, { highWaterMark: 0 })))("https://example.test");
  await response.body!.cancel("finished");
  expect(cancel).toHaveBeenCalledWith("finished");
  expect(exporter.getFinishedSpans().find(span => span.name === "test.cancel")?.attributes["error.type"]).toBe("AbortError");
  const empty = new Response(null, { status: 204 });
  expect(await instrumentFetch("test", "empty", async () => empty)("https://example.test")).toBe(empty);
});

it("records the routed model, upstream host, timing and usage of OpenRouter generations", async () => {
  const frames = [
    `data: {"id":"gen-abc","provider":"GMICloud","model":"z-ai/glm-5.3-flash-20260826","choices":[{"delta":{"content":"hi"}}]}\n\n`,
    `data: {"id":"gen-abc","provider":"GMICloud","choices":[{"delta":{"content":" there"}}],"usage":{"prompt_tokens":120,"completion_tokens":7,"cost":0.00012}}\n\n`,
    "data: [DONE]\n\n",
  ];
  const http = vi.fn(async () => new Response(new ReadableStream({
    pull(controller) { const frame = frames.shift(); if (frame) controller.enqueue(new TextEncoder().encode(frame)); else controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } }));
  const body = JSON.stringify({ model: "z-ai/glm-5.3-flash", stream: true, messages: [{ role: "user", content: 'say "model":"evil"' }],
    provider: { sort: "price", quantizations: ["fp8", "bf16"] } });
  const response = await instrumentFetch("openrouter", "chat-agent", http)("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body });
  await response.text();
  const span = exporter.getFinishedSpans().find((item) => item.name === "openrouter.chat-agent")!;
  expect(span.attributes).toMatchObject({
    "gen_ai.request.model": "z-ai/glm-5.3-flash", "docslurp.llm.route.sort": "price", "docslurp.llm.route.quantizations": "fp8,bf16",
    "docslurp.llm.stream": true, "docslurp.llm.upstream_provider": "GMICloud", "gen_ai.response.model": "z-ai/glm-5.3-flash-20260826",
    "gen_ai.response.id": "gen-abc", "gen_ai.usage.input_tokens": 120, "gen_ai.usage.output_tokens": 7, "docslurp.llm.cost_usd": 0.00012,
  });
  expect(typeof span.attributes["docslurp.llm.time_to_first_chunk_ms"]).toBe("number");
  expect(typeof span.attributes["docslurp.llm.time_to_headers_ms"]).toBe("number");

  const json = await instrumentFetch("openrouter", "json", async () => Response.json({ id: "gen-j", provider: "Crusoe", model: "deepseek/deepseek-v4.1-flash",
    choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }))("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{not json" });
  await json.json();
  expect(exporter.getFinishedSpans().find((item) => item.name === "openrouter.json")!.attributes).toMatchObject({
    "docslurp.llm.upstream_provider": "Crusoe", "gen_ai.usage.output_tokens": 2 });

  const cached = await instrumentFetch("openrouter", "cached", async () => Response.json({ id: "gen-c", provider: "Anthropic", model: "anthropic/claude-haiku-5.5",
    choices: [], usage: { prompt_tokens: 3000, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 2048, cache_write_tokens: 900 } } }))("https://openrouter.ai/api/v1/chat/completions", { method: "POST", body: "{}" });
  await cached.json();
  expect(exporter.getFinishedSpans().find((item) => item.name === "openrouter.cached")!.attributes).toMatchObject({
    "gen_ai.usage.input_tokens": 3000, "gen_ai.usage.cache_read.input_tokens": 2048, "gen_ai.usage.cache_creation.input_tokens": 900 });

  await (await instrumentFetch("openrouter", "embed", async () => Response.json({ provider: "X" }))("https://openrouter.ai/api/v1/embeddings", { method: "POST", body })).json();
  expect(exporter.getFinishedSpans().find((item) => item.name === "openrouter.embed")!.attributes["docslurp.llm.upstream_provider"]).toBeUndefined();
});

 it("refuses redirect following even when callers request it", async () => {
  const http = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
  });
  const response = await instrumentFetch("openai", "embedding", http)("https://api.openai.com/v1/embeddings", {
    redirect: "follow", headers: { authorization: "Bearer sentinel-platform-key" },
  });
  expect(response.status).toBe(302);
  await response.body?.cancel();
  expect(http).toHaveBeenCalledTimes(1);
});

it("redacts provider response bodies before SDK errors can expose them", async () => {
  const response = await instrumentFetch("openai", "embedding", async () => new Response("sentinel-platform-secret", { status: 401 }))("https://api.openai.com/v1/embeddings");
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("sentinel-platform-secret");
});

it.each(["text/event-stream", "application/json"])("redacts HTTP 200 error envelopes (%s)", async (contentType) => {
  const payload = JSON.stringify({ error: { message: "sentinel-platform-secret", code: 401 }, debug: "sentinel-platform-secret" });
  const raw = contentType === "text/event-stream" ? `event: error\ndata: ${payload}\n\n` : payload;
  for (const width of [1, 7, raw.length]) {
    let offset = 0;
    const response = await instrumentFetch("test", "failed-success", async () => new Response(new ReadableStream({
      pull(controller) {
        if (offset === raw.length) { controller.close(); return; }
        controller.enqueue(new TextEncoder().encode(raw.slice(offset, offset += Math.min(width, raw.length - offset))));
      },
    }), { headers: { "content-type": contentType } }))("https://example.test");
    const publicBody = await response.text();
    expect(publicBody).not.toContain("sentinel-platform-secret");
    expect(publicBody).toContain("Provider request failed");
  }
});

it("preserves successful SSE content and refuses oversized or malformed events before exposure", async () => {
  const frame = 'data: {"choices":[{"delta":{"content":"error is ordinary prose ☃"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const response = await instrumentFetch("test", "ok", async () => new Response(frame, { headers: { "content-type": "text/event-stream" } }))("https://example.test");
  expect(await response.text()).toBe(frame.replace(/\r\n/g, "\n"));
  for (const frame of ['data: {broken sentinel-secret}\n\n', `data: ${"x".repeat(1024 * 1024 + 1)}`]) {
    const response = await instrumentFetch("test", "invalid", async () => new Response(frame, { headers: { "content-type": "text/event-stream" } }))("https://example.test");
    await expect(response.text()).rejects.toThrow(/Invalid provider response|exceeds limit/);
  }
});

const secret = "sentinel-private-diagnostic";
function chunked(raw: string, width: number, contentType = "text/event-stream") {
  const bytes = new TextEncoder().encode(raw);
  let offset = 0;
  return new Response(new ReadableStream({ pull(c) {
    if (offset >= bytes.length) { c.close(); return; }
    c.enqueue(bytes.slice(offset, offset += width));
  } }), {headers: {"content-type": contentType}});
}
it("normalizes JSON equivalents and strips SSE metadata diagnostics", async () => {
  for (const envelope of [{type: "response.failed", response: {error: secret}}, {type: "response.error", error: secret}, {error: secret}]) {
    const response = await instrumentFetch("test", "json", async () => chunked(JSON.stringify(envelope), 1, "application/json"))("https://example.test");
    expect(await response.text()).toContain("Provider request failed");
  }
  const response = await instrumentFetch("test", "metadata", async () => chunked(`: ${secret}\nid: ${secret}\n\ndata: [DONE]\n\n`, 1))("https://example.test");
  expect(await response.text()).not.toContain(secret);
});
it("refuses invalid UTF-8 without releasing diagnostic bytes", async () => {
  const response = await instrumentFetch("test", "utf8", async () => new Response(new Uint8Array([0xc3, 0x28]), {headers: {"content-type": "text/event-stream"}}))("https://example.test");
  await expect(response.text()).rejects.toThrow("Invalid provider response");
});

it("refuses oversized JSON envelopes and malformed trailing UTF-8", async () => {
  const response = await instrumentFetch("test", "large-json", async () => new Response('"' + 'x'.repeat(16 * 1024 * 1024) + '"', {headers: {"content-type": "application/json"}}))("https://example.test");
  await expect(response.text()).rejects.toThrow(/exceeds limit/);
  const invalid = await instrumentFetch("test", "truncated", async () => new Response(new Uint8Array([0xc3]), {headers: {"content-type": "application/json"}}))("https://example.test");
  await expect(invalid.text()).rejects.toThrow("Invalid provider response");
});
