import { afterAll, expect, it, vi } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { initializeObservability, shutdownObservability, startDependencySpan, withBackgroundSpan } from "../observability.js";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const spans: ReadableSpan[] = [];
initializeObservability({ spanProcessors: [{ onStart() {}, onEnd(span) { spans.push(span); }, async shutdown() {}, async forceFlush() {} }] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it("roots each pass in a named trace that owns its dependency spans, detached from the caller", async () => {
  spans.length = 0;
  const caller = startDependencySpan("postgres.SELECT", {});
  const result = await caller.run(() => withBackgroundSpan("worker.credit-debit-flush", async () => {
    const query = startDependencySpan("postgres.UPDATE", {});
    query.end();
    return 42;
  }));
  caller.end();
  expect(result).toBe(42);
  const root = spans.find(span => span.name === "worker.credit-debit-flush")!;
  const child = spans.find(span => span.name === "postgres.UPDATE")!;
  const outer = spans.find(span => span.name === "postgres.SELECT")!;
  expect(root.parentSpanContext).toBeUndefined();
  expect(root.attributes["docslurp.background.task"]).toBe("worker.credit-debit-flush");
  expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
  expect(root.spanContext().traceId).not.toBe(outer.spanContext().traceId);
});

it("marks a failed pass and rethrows its error", async () => {
  spans.length = 0;
  await expect(withBackgroundSpan("api.alert-evaluation", async () => { throw new TypeError("boom"); })).rejects.toThrow("boom");
  const root = spans.find(span => span.name === "api.alert-evaluation")!;
  expect(root.status.code).toBe(2);
  expect(root.attributes["error.type"]).toBe("TypeError");
});
