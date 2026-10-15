import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildWorkerAiUsageEvent,
  hasWorkerAiUsage,
} from "../lib/ai-usage.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import type { UsageEvent } from "../models.js";

describe("worker AI usage Module", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("builds token usage events with token amount defaults", () => {
    expect(
      buildWorkerAiUsageEvent({
        provider: "anthropic",
        model: "model-1",
        metric: "structured-extract",
        inputTokens: 12,
        outputTokens: 4,
        costCents: 2,
      }),
    ).toMatchObject({
      amount: 16,
      unit: "token",
      costCents: 2.4,
      inputTokens: 12,
      outputTokens: 4,
      metadata: { providerCostCents: 2 },
    });
  });

  it("records AI usage through the ledger: priced, logged, id-stamped", () => {
    const ledger = new PipelineUsageEventLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const event = ledger.record({
      provider: "openrouter",
      model: "model-1",
      metric: "summary-generation",
      amount: 1,
      unit: "document",
      inputTokens: 20,
      outputTokens: 5,
      metadata: { documentId: "doc-1" },
    });

    expect(ledger.snapshot()).toEqual([event]);
    expect(event).toMatchObject({
      id: expect.any(String),
      amount: 1,
      unit: "document",
      inputTokens: 20,
      outputTokens: 5,
      metadata: { documentId: "doc-1" },
    });
    expect(log).toHaveBeenCalledWith(
      "[ai-usage] summary-generation model=model-1 input_tokens=20 output_tokens=5",
    );
  });

  it("charges bonus plans the plan-neutral AI credit factor and never compounds it", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const input = { provider: "anthropic", model: "model-1", metric: "structured-extract", inputTokens: 12, outputTokens: 4, costCents: 10 };
    const silver = new PipelineUsageEventLedger();
    silver.planId = "silver";
    const platinum = new PipelineUsageEventLedger();
    platinum.planId = "platinum";

    expect(silver.record(input)?.costCents).toBeCloseTo(12);
    const priced = platinum.record(input);
    expect(priced?.costCents).toBeCloseTo(14.4);
    expect(priced?.metadata).toMatchObject({ providerCostCents: 10, aiPlanCreditFactor: 1.2 });
    expect(platinum.totals().costCents).toBeCloseTo(14.4);
  });

  it("bills a private-endpoint call at half the hosted-equivalent list, whatever the GPU cost", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    const event = ledger.record({
      provider: "private",
      model: "gpu1/ocr-model",
      metric: "vision-page",
      inputTokens: 1_500,
      outputTokens: 800,
      costCents: 0.002,
      metadata: { capability: "vision", costSource: "private-endpoint-hourly" },
    });
    expect(event?.costCents).toBeCloseTo(0.0455, 3);
    expect(event?.metadata).toMatchObject({ providerCostCents: 0.002, selfHosted: { discountPercent: 50 } });
  });

  it("does not record empty AI usage", () => {
    const ledger = new PipelineUsageEventLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(
      ledger.record({ provider: "openrouter", model: "model-1", metric: "noop" }),
    ).toBeNull();
    expect(ledger.snapshot()).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(
      hasWorkerAiUsage(
        buildWorkerAiUsageEvent({
          provider: "openrouter",
          model: "model-1",
          metric: "noop",
        }),
      ),
    ).toBe(false);
  });

  it("keeps cost-only events (local compute, fees, failed attempts) and drops empty ones", () => {
    const ledger = new PipelineUsageEventLedger();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const localCompute: UsageEvent = {
      provider: "local-compute",
      model: "lean:test:local",
      metric: "parser-process",
      amount: 0.001,
      unit: "cent",
      costCents: 0,
      metadata: { costRollup: "included", billable: false },
    };
    const fee: UsageEvent = {
      provider: "docslurp",
      model: "page-base-fee",
      metric: "page-base-fee",
      amount: 3,
      unit: "page",
      costCents: 1.5,
    };
    const failedAttempt: UsageEvent = {
      provider: "openai",
      model: "vision-model",
      metric: "page-analysis-attempt",
      amount: 1,
      unit: "attempt",
      costCents: 0,
      inputTokens: 0,
      outputTokens: 0,
      metadata: { billable: false },
    };

    expect(ledger.enqueue(localCompute)).toMatchObject({ id: expect.any(String), amount: 0.001 });
    expect(ledger.enqueue(fee)).toMatchObject({ costCents: 1.5 });
    expect(ledger.enqueue(failedAttempt, { logAiUsage: true })).toMatchObject({ metric: "page-analysis-attempt" });
    expect(
      ledger.enqueue({ ...localCompute, metric: "empty", amount: 0 }),
    ).toBeNull();

    expect(ledger.snapshot().map((event) => event.metric)).toEqual([
      "parser-process",
      "page-base-fee",
      "page-analysis-attempt",
    ]);
    // Only the AI attempt writes an [ai-usage] line; compute and fees do not.
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain("page-analysis-attempt");
  });

  it("keeps a checkpoint batch buffered until commit, with stable ids for retries", () => {
    const ledger = new PipelineUsageEventLedger();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    ledger.record({ provider: "openrouter", model: "m", metric: "a", inputTokens: 1 });

    const failed = ledger.checkpoint();
    // Write failed: no commit. The retry sees the same events and ids.
    const retry = ledger.checkpoint();
    expect(retry.events.map((event) => event.id)).toEqual(
      failed.events.map((event) => event.id),
    );

    // An event recorded while the checkpoint is in flight survives commit.
    ledger.record({ provider: "openrouter", model: "m", metric: "b", inputTokens: 2 });
    retry.commit();
    retry.commit();
    expect(ledger.snapshot().map((event) => event.metric)).toEqual(["b"]);

    const next = ledger.checkpoint();
    expect(next.events.map((event) => event.metric)).toEqual(["b"]);
    next.commit();
    expect(ledger.snapshot()).toEqual([]);
    // Totals stay cumulative across flushes for heartbeats and page results.
    expect(ledger.totals()).toEqual({ inputTokens: 3, outputTokens: 0, costCents: expect.any(Number) });
  });

  it("summarizes recorded and enqueued usage through one ledger", () => {
    const ledger = new PipelineUsageEventLedger();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    ledger.record({
      provider: "openrouter",
      model: "model-1",
      metric: "summary-generation",
      inputTokens: 20,
      outputTokens: 5,
      costCents: 2,
    });
    ledger.enqueue({
      provider: "openai",
      model: "text-embedding-3-small",
      metric: "embedding-tokens",
      amount: 10,
      unit: "token",
      costCents: 1,
      inputTokens: 10,
      metadata: {},
    });

    expect(ledger.totals()).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      costCents: expect.closeTo(3.6, 12),
    });
    expect(ledger.snapshot()).toHaveLength(2);
  });

  it("keeps a running billable total of buffered usage for the run cost cap", () => {
    const ledger = new PipelineUsageEventLedger();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    ledger.record({
        provider: "anthropic",
        model: "model-1",
        metric: "page-analysis",
        inputTokens: 100,
        outputTokens: 12,
        costCents: 3,
      },
    );

    ledger.record({
        provider: "anthropic",
        model: "model-1",
        metric: "provider-charge-without-tokens",
        costCents: 99,
      },
    );

    expect(ledger.snapshot()).toHaveLength(2);
    expect(ledger.pendingBillableCents).toBeCloseTo(3.6 + 118.8);
    const batch = ledger.checkpoint();
    ledger.record({ provider: "anthropic", model: "model-1", metric: "late", costCents: 1 });
    batch.commit();
    expect(ledger.pendingBillableCents).toBeCloseTo(1.2);
  });
});
