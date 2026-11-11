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

it("preserves transport and body errors without repeating requests", async () => {
  const error = new Error("transport failure");
  const http = vi.fn(async () => { throw error; });
  await expect(instrumentFetch("test", "failed", http)("https://example.test")).rejects.toBe(error);
  expect(http).toHaveBeenCalledTimes(1);
  const brokenBody = new Response(new ReadableStream({ pull(controller) { controller.error(error); } }));
  const response = await instrumentFetch("test", "body-failed", async () => brokenBody)("https://example.test");
  await expect(response.text()).rejects.toBe(error);
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

  await (await instrumentFetch("openrouter", "embed", async () => Response.json({ provider: "X" }))("https://openrouter.ai/api/v1/embeddings", { method: "POST", body })).json();
  expect(exporter.getFinishedSpans().find((item) => item.name === "openrouter.embed")!.attributes["docslurp.llm.upstream_provider"]).toBeUndefined();
});
