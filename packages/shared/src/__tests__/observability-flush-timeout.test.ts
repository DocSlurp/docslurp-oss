import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ flush: vi.fn<() => Promise<void>>() }));
vi.mock("@opentelemetry/sdk-metrics", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@opentelemetry/sdk-metrics")>();
  return {
    ...sdk,
    // Preserve the real MetricReader timeout behavior; only its exporter work stalls.
    PeriodicExportingMetricReader: class extends sdk.PeriodicExportingMetricReader {
      protected onForceFlush(): Promise<void> { return state.flush(); }
    },
  };
});

import { flushObservability, initializeObservability } from "../telemetry.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("returns from stage telemetry flush when a metric exporter never settles", async () => {
  vi.useFakeTimers();
  vi.stubEnv("OTEL_ENABLED", "true");
  vi.stubEnv("LANGFUSE_ENABLED", "false");
  vi.stubEnv("OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "http://127.0.0.1:1/v1/metrics");
  let release!: () => void;
  state.flush.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  initializeObservability();
  let finished = false;
  const pending = flushObservability().then(() => { finished = true; });
  try {
    await vi.advanceTimersByTimeAsync(4999);
    expect(state.flush).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(finished).toBe(true);
  } finally {
    release();
    await pending;
  }
  state.flush.mockResolvedValue(undefined);
  await expect(flushObservability()).resolves.toBeUndefined();
});
