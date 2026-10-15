import { describe, expect, it, vi } from "vitest";
import type { PostHogSpanProcessor } from "@posthog/ai/otel";
import { LangfuseExcludingPostHogProcessor } from "./posthog-ai-observability.js";

vi.mock("@docslurp/shared/observability", () => ({
  initializeObservability: vi.fn(), installObservabilitySignalHandlers: vi.fn(), emitTelemetryLog: vi.fn(),
}));
vi.mock("ai", () => ({ registerTelemetry: vi.fn() }));

describe("PostHog content boundary", () => {
  it("excludes captured Langfuse content while preserving native AI spans and processor lifecycle", async () => {
    const inner = { onStart: vi.fn(), onEnd: vi.fn(), forceFlush: vi.fn().mockResolvedValue(undefined), shutdown: vi.fn().mockResolvedValue(undefined) };
    const processor = new LangfuseExcludingPostHogProcessor(inner as unknown as PostHogSpanProcessor);
    const span = (scope: string, attributes: Record<string, string>) => ({ name: "generate", instrumentationScope: { name: scope }, attributes }) as Parameters<PostHogSpanProcessor["onEnd"]>[0];
    for (const privateSpan of [
      span("langfuse-sdk", { "gen_ai.request.model": "example-model" }),
      span("different-scope", { "gen_ai.request.model": "example-model", "langfuse.observation.input": "private tenant prompt", "langfuse.observation.output": "private answer" }),
    ]) {
      processor.onStart(privateSpan as Parameters<PostHogSpanProcessor["onStart"]>[0], {} as Parameters<PostHogSpanProcessor["onStart"]>[1]);
      processor.onEnd(privateSpan);
    }
    expect(inner.onStart).not.toHaveBeenCalled();
    expect(inner.onEnd).not.toHaveBeenCalled();
    const native = span("ai-sdk", { "gen_ai.request.model": "example-model", "gen_ai.usage.input_tokens": "12" });
    processor.onStart(native as Parameters<PostHogSpanProcessor["onStart"]>[0], {} as Parameters<PostHogSpanProcessor["onStart"]>[1]);
    processor.onEnd(native);
    expect(inner.onStart).toHaveBeenCalledTimes(1);
    expect(inner.onEnd).toHaveBeenCalledWith(native);
    await processor.forceFlush();
    await processor.shutdown();
    expect(inner.forceFlush).toHaveBeenCalledTimes(1);
    expect(inner.shutdown).toHaveBeenCalledTimes(1);
  });
});
