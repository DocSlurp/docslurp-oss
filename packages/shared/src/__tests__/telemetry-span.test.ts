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

it("propagates safe scope to SDK and manual spans without crossing concurrent tenants", async () => {
  const { trace } = await import("@opentelemetry/api");
  const { addTraceMetadata } = await import("../observability.js");
  await Promise.all(["one", "two"].map(orgId => withObservation({
    name: `scope-${orgId}`, metadata: { orgId, guardrailMode: "cascade", guardrailPolicyVersion: "v1", password: "hidden" },
  }, async () => {
    addTraceMetadata({ workspaceId: `workspace-${orgId}` });
    await Promise.resolve();
    const sdk = trace.getTracer("third-party.sdk").startSpan(`sdk-${orgId}`);
    sdk.end();
    const manual = startTelemetrySpan("docslurp.test", `manual-${orgId}`, {});
    manual.end("private document error text");
  })));
  for (const orgId of ["one", "two"]) {
    for (const prefix of ["scope", "sdk", "manual"]) {
      const span = exporter.getFinishedSpans().find(s => s.name === `${prefix}-${orgId}`)!;
      expect(span.attributes).toMatchObject({ "docslurp.orgId": orgId, "docslurp.workspaceId": `workspace-${orgId}`, "docslurp.guardrail.mode": "cascade", "docslurp.guardrail.policy.version": "v1" });
      expect(span.attributes.password).toBeUndefined();
    }
    const manual = exporter.getFinishedSpans().find(s => s.name === `manual-${orgId}`)!;
    expect(manual.attributes["error.type"]).toBe("Error");
    expect(JSON.stringify(manual.attributes)).not.toContain("private document");
  }
});
