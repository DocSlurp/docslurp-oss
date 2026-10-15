import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updates: [] as Array<{ name: string; data: Record<string, unknown> }>,
  flush: vi.fn(),
  failStart: false,
  processorOptions: [] as Array<Record<string, unknown>>,
  propagation: [] as Array<Record<string, unknown>>,
  types: [] as Array<string | undefined>,
  attributes: [] as Array<{ name: string; key: string; value: string }>,
}));
vi.mock("@langfuse/otel", () => ({ LangfuseSpanProcessor: class {
  constructor(options: Record<string, unknown>) { state.processorOptions.push(options); }
} }));
vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    forceFlush = state.flush;
    register() {}
    async shutdown() {}
  },
}));
vi.mock("@langfuse/tracing", () => ({
  LangfuseOtelSpanAttributes: { TRACE_USER_ID: "user.id", TRACE_SESSION_ID: "session.id" },
  setLangfuseTracerProvider: vi.fn(),
  propagateAttributes: (attributes: Record<string, unknown>, run: () => unknown) => {
    state.propagation.push(attributes);
    return run();
  },
  startActiveObservation: (name: string, fn: (span: unknown) => unknown, options?: { asType?: string }) => {
    state.types.push(options?.asType);
    if (state.failStart) throw new Error("exporter setup failure");
    return fn({
      update: (data: Record<string, unknown>) =>
        state.updates.push({ name, data }),
      otelSpan: {
        setAttribute: (key: string, value: string) =>
          state.attributes.push({ name, key, value }),
      },
    });
  },
}));

import {
  addTraceMetadata,
  aiResultDetails,
  flushObservability,
  sanitizeTraceValue,
  withObservation,
} from "../observability.js";

function enable() {
  vi.stubEnv("LANGFUSE_ENABLED", "true");
  vi.stubEnv("LANGFUSE_BASE_URL", "http://localhost:1");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "test-public");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "test-secret");
}
afterEach(() => {
  vi.unstubAllEnvs();
  state.updates.length = 0;
  state.failStart = false;
  state.propagation.length = 0;
  state.types.length = 0;
  state.attributes.length = 0;
  state.flush.mockReset();
});

describe("server observability", () => {
  it("sets late-bound user and session IDs on the already-open observation", async () => {
    enable();
    await withObservation({ name: "request" }, async () => {
      addTraceMetadata({ userId: "user-1", sessionId: "session-1", workspaceId: "w" });
      return withObservation({ name: "child" }, async () => 1);
    });
    expect(state.attributes).toEqual([
      { name: "request", key: "user.id", value: "user-1" },
      { name: "request", key: "session.id", value: "session-1" },
    ]);
    expect(state.propagation.at(-1)).toMatchObject({ userId: "user-1", sessionId: "session-1" });
  });

  it("does not trace by default in tests and returns the original result", async () => {
    const result = { unchanged: true };
    expect(await withObservation({ name: "off" }, async () => result)).toBe(
      result,
    );
    expect(state.updates).toEqual([]);
  });

  it("keeps concurrent request metadata isolated and inherits it in children", async () => {
    enable();
    await Promise.all(
      ["a", "b"].map((requestId) =>
        withObservation(
          { name: requestId, metadata: { requestId } },
          async () => {
            addTraceMetadata({ workspaceId: requestId });
            await Promise.resolve();
            return withObservation(
              { name: `${requestId}-child` },
              async () => 1,
            );
          },
        ),
      ),
    );
    for (const requestId of ["a", "b"]) {
      const updates = state.updates.filter(
        (u) => u.name === `${requestId}-child`,
      );
      expect(updates[0].data.metadata).toEqual({
        requestId,
        workspaceId: requestId,
      });
    }
    expect(state.processorOptions[0].additionalHeaders).toEqual({ "x-langfuse-ingestion-version": "4" });
    expect(state.propagation.filter(p => p.traceName).map(p => p.traceName)).toEqual(["a", "b"]);
  });

  it("propagates user/session correlation to child observations", async () => {
    enable();
    await withObservation({ name: "root", metadata: { userId: "user", sessionId: "session" } }, async () => {
      await withObservation({ name: "checkpoint", type: "span" }, async () => null);
    });
    expect(state.propagation).toEqual([
      { traceName: "root", userId: "user", sessionId: "session" },
      { traceName: undefined, userId: "user", sessionId: "session" },
    ]);
  });

  it("records actual usage while omitting content and rethrows the same error once", async () => {
    enable();
    await withObservation(
      {
        name: "generation",
        type: "generation",
        input: "private input",
        result: aiResultDetails,
      },
      async () => ({ text: "private output", usage: { inputTokens: 42 } }),
    );
    expect(state.updates.at(-1)?.data).toMatchObject({
      usageDetails: { input: 42 },
      output: undefined,
    });
    const error = new Error("private provider response");
    const run = vi.fn().mockRejectedValue(error);
    await expect(withObservation({ name: "failure" }, run)).rejects.toBe(error);
    expect(run).toHaveBeenCalledTimes(1);
    expect(state.updates.at(-1)?.data.statusMessage).toBe("Error");
    expect(JSON.stringify(state.updates)).not.toContain("private");
  });

  it("bounds and sanitizes opted-in content", async () => {
    enable();
    vi.stubEnv("LANGFUSE_CAPTURE_CONTENT", "true");
    await withObservation(
      {
        name: "capture",
        input: {
          apiKey: "secret",
          text: "Bearer private",
          image: "data:image/png;base64,YWJj",
          embeddings: [1, 2],
        },
      },
      async () => null,
    );
    expect(state.updates[0].data.input).toEqual({
      text: "Bearer [redacted]",
      image: "[media omitted]",
    });
    expect((sanitizeTraceValue("a".repeat(20000)) as string).length).toBe(
      16000,
    );
  });

  it("continues once if span creation fails and contains flush failures", async () => {
    enable();
    state.failStart = true;
    const run = vi.fn().mockResolvedValue(7);
    expect(await withObservation({ name: "fallback" }, run)).toBe(7);
    expect(run).toHaveBeenCalledTimes(1);
    state.flush.mockRejectedValue(new Error("offline"));
    await expect(flushObservability()).resolves.toBeUndefined();
  });
});
