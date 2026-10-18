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
  await withObservation({ name: "stream-root", metadata: { runId: "run-stream", workspaceId: "workspace-stream" } }, async () => {
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
    "docslurp.runId": "run-stream", "docslurp.workspaceId": "workspace-stream" });
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
