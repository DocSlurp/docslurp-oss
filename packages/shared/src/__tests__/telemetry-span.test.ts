import { afterAll, expect, it, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initializeObservability, shutdownObservability, startTelemetrySpan, withObservation } from "../observability.js";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const exporter = new InMemorySpanExporter();
initializeObservability({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it("nests explicit-parent spans on a docslurp tracer and records failures with their message and stack", async () => {
  const agent = startTelemetrySpan("docslurp.chat", "invoke_agent workspace-chat", { "gen_ai.operation.name": "invoke_agent", "x.api_key": "secret" });
  const step = startTelemetrySpan("docslurp.chat", "chat test-model", { "gen_ai.operation.name": "chat" }, { parent: agent, kind: "client" });
  step.set({ "gen_ai.usage.input_tokens": 10 });
  step.end();
  const tool = agent.run(() => startTelemetrySpan("docslurp.chat", "execute_tool search", { "gen_ai.tool.name": "search" }));
  tool.end(new TypeError("search failed for workspace ws-1 with Bearer sk-live-123 and dslp_priv_abcdef"));
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
  // Support needs the message and stack; credentials are scrubbed on export.
  expect(failed.events.find(event => event.name === "exception")?.attributes).toMatchObject({
    "exception.type": "TypeError",
    "exception.message": "search failed for workspace ws-1 with Bearer [redacted] and dslp_priv_[redacted]",
  });
  expect(String(failed.events[0]?.attributes?.["exception.stacktrace"])).toContain("telemetry-span.test");
  expect(failed.status.message).toContain("search failed for workspace ws-1");
  expect(JSON.stringify({ events: failed.events, status: failed.status })).not.toMatch(/sk-live-123|abcdef/);
});

it("links a retrieval observation run by the chat agent to its chat session", async () => {
  await withObservation({ name: "api.search.linked", type: "retriever", metadata: { workspaceId: "ws", chatSessionId: "chat-1" } }, async () => undefined);
  const span = exporter.getFinishedSpans().find(item => item.name === "api.search.linked")!;
  expect(span.attributes).toMatchObject({ "docslurp.chat.session_id": "chat-1", "docslurp.workspaceId": "ws" });
});

it("copies only allowlisted eval.* baggage, capped at 128 characters, and exposes the active traceparent", async () => {
  const { evalBaggageAttributes, activeTraceparent, withHttpSpan } = await import("../observability.js");
  expect(activeTraceparent()).toBeNull();
  const seen = await withHttpSpan({ method: "POST", route: "/v1/chat", status: () => 200, headers: {
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", tracestate: "",
    baggage: `eval.run_id=run-1,eval.case_id=${"x".repeat(200)},eval.secret=nope,user.email=someone`,
  } }, async () => ({ baggage: evalBaggageAttributes(), traceparent: activeTraceparent() }));
  expect(seen.baggage).toEqual({ "eval.run_id": "run-1", "eval.case_id": "x".repeat(128) });
  expect(seen.traceparent).toMatch(/^00-0af7651916cd43dd8448eb211c80319c-[0-9a-f]{16}-01$/);
});

it("puts the request's identity and route ids on the HTTP span, and the failure's message", async () => {
  const { withHttpSpan } = await import("../observability.js");
  await expect(withHttpSpan({ method: "GET", route: "/v1/workspaces/:workspaceId", status: () => 200, headers: { traceparent: "", tracestate: "", baggage: "" },
    attributes: () => ({ "enduser.id": "user-1", "docslurp.workspaceId": "ws-9", "x.api_key": "nope" }) },
  async () => { throw new Error("database timeout while loading workspace"); })).rejects.toThrow("database timeout");
  const span = exporter.getFinishedSpans().find(item => item.name === "GET /v1/workspaces/:workspaceId")!;
  expect(span.attributes).toMatchObject({ "enduser.id": "user-1", "docslurp.workspaceId": "ws-9", "http.response.status_code": 500, "error.type": "Error" });
  expect(span.attributes["x.api_key"]).toBeUndefined();
  expect(span.status.message).toBe("database timeout while loading workspace");
  expect(span.events[0]?.attributes?.["exception.message"]).toBe("database timeout while loading workspace");
});
