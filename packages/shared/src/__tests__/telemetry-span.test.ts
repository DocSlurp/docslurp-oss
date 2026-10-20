import { afterAll, expect, it, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initializeObservability, shutdownObservability, startTelemetrySpan, withObservation } from "../observability.js";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const exporter = new InMemorySpanExporter();
initializeObservability({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it("nests explicit-parent spans on a docslurp tracer and records failures by type only", async () => {
  const agent = startTelemetrySpan("docslurp.chat", "invoke_agent workspace-chat", { "gen_ai.operation.name": "invoke_agent", "x.api_key": "secret" });
  const step = startTelemetrySpan("docslurp.chat", "chat test-model", { "gen_ai.operation.name": "chat" }, { parent: agent, kind: "client" });
  step.set({ "gen_ai.usage.input_tokens": 10 });
  step.end();
  const tool = agent.run(() => startTelemetrySpan("docslurp.chat", "execute_tool search", { "gen_ai.tool.name": "search" }));
  tool.end(new TypeError("document text must not leak"));
  tool.end();
  agent.end();
  const spans = exporter.getFinishedSpans();
  const root = spans.find(span => span.name === "invoke_agent workspace-chat")!;
  const child = spans.find(span => span.name === "chat test-model")!;
  const failed = spans.find(span => span.name === "execute_tool search")!;
  expect(root.instrumentationScope.name).toBe("docslurp.chat");
  expect(root.attributes["x.api_key"]).toBeUndefined();
  expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(child.kind).toBe(2);
  expect(child.attributes["gen_ai.usage.input_tokens"]).toBe(10);
  expect(failed.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(failed.status.code).toBe(2);
  expect(failed.attributes["error.type"]).toBe("TypeError");
  expect(JSON.stringify({ attributes: failed.attributes, events: failed.events, status: failed.status })).not.toContain("must not leak");
});

it("links a retrieval observation run by the chat agent to its chat session", async () => {
  await withObservation({ name: "api.search.linked", type: "retriever", metadata: { workspaceId: "ws", chatSessionId: "chat-1" } }, async () => undefined);
  const span = exporter.getFinishedSpans().find(item => item.name === "api.search.linked")!;
  expect(span.attributes).toMatchObject({ "docslurp.chat.session_id": "chat-1", "docslurp.workspaceId": "ws" });
});
