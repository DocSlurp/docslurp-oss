import { pageCredits, speedBoostMultiplier } from "@docslurp/shared";
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
      costCents: 0,
      inputTokens: 12,
      outputTokens: 4,
      metadata: { providerCostCents: 2, billable: false },
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

  it("records AI provider cost without billing it", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    const event = ledger.record({ provider: "anthropic", model: "model-1", metric: "structured-extract", inputTokens: 12, outputTokens: 4, costCents: 10 });
    expect(event).toMatchObject({ costCents: 0, metadata: { providerCostCents: 10, billable: false, costRole: "provider" } });
    expect(ledger.totals().costCents).toBe(0);
    expect(ledger.pendingBillableCents).toBe(0);
  });

  it("charges a page read by a vision/OCR model as one Rich page, once per run, plus token blocks", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    const read = (pageNumber: number, outputTokens: number) => ledger.record({
      provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis",
      inputTokens: 1_149, outputTokens, costCents: 0.12, metadata: { documentId: "doc-1", pageNumber },
    });
    read(1, 700);
    read(1, 750); // a retry of the same page in the same run: not charged again
    read(2, 2_035); // dense page: 3 Rich pages under the test provider's output rule
    const charges = ledger.snapshot().filter((event) => event.metric === "ingest-page-rich");
    // Page 2 is three Rich units, each its own event so a retried read can never charge one twice.
    expect(charges.map((event) => [event.id, event.amount, event.costCents])).toEqual([
      ["rich:run-1:doc-1:1", 1, 0.25],
      ["rich:run-1:doc-1:2", 1, 0.25],
      ["rich:run-1:doc-1:2:unit:2", 1, 0.25],
      ["rich:run-1:doc-1:2:unit:3", 1, 0.25],
    ]);
    expect(charges[0]!.metadata).toMatchObject({ billable: true, unitCharge: true, readBy: "page-analysis" });
    expect(ledger.pendingBillableCents).toBeCloseTo(1);
    expect([...ledger.richPagesOf("doc-1")].sort()).toEqual([1, 2]);
    // A local OCR read with no tokens or cost still bills the page.
    ledger.record({ provider: "vision-runtime", model: "local", metric: "ocr-native-pdf", amount: 1, unit: "image", costCents: 0, inputTokens: 0, outputTokens: 0, metadata: { documentId: "doc-1", pageNumber: 3 } });
    expect(ledger.richPagesOf("doc-1").has(3)).toBe(true);
  });

  it("keeps the output-token surcharge when a vision read follows an OCR read of the same page", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    const vision = (outputTokens: number) => ledger.record({
      provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis",
      inputTokens: 1_149, outputTokens, costCents: 0.12, metadata: { documentId: "img", pageNumber: 1 },
    });
    // An uploaded image: OCR reads it (no output tokens) and charges the page as one Rich page; vision then reads it for
    // 2,000 output tokens, which the page's first charge did not cover (3 Rich pages in all under the test provider).
    ledger.chargeRichPage({ documentId: "img", pageNumber: 1, readBy: "page-ocr" });
    expect(ledger.pendingBillableCents).toBeCloseTo(0.25);
    vision(2_000);
    const charges = () => ledger.snapshot().filter((event) => event.metric === "ingest-page-rich");
    expect(charges().map((event) => event.id)).toEqual(["rich:run-1:img:1", "rich:run-1:img:1:unit:2", "rich:run-1:img:1:unit:3"]);
    expect(ledger.pendingBillableCents).toBeCloseTo(0.75);
    expect(ledger.richPagesCharged("img", 1)).toBe(3);
    // The same vision read recorded again (a retry in the same run) adds nothing; a bigger one adds only the difference.
    vision(1_900);
    expect(charges()).toHaveLength(3);
    vision(2_500);
    expect(charges().map((event) => event.id).at(-1)).toBe("rich:run-1:img:1:unit:4");
    expect(ledger.pendingBillableCents).toBeCloseTo(1);
    // A retry in a new ledger (a restarted activity) reading the same page emits the same ids, which insert nothing twice.
    const retry = new PipelineUsageEventLedger();
    retry.runId = "run-1";
    retry.chargeRichPage({ documentId: "img", pageNumber: 1, readBy: "page-ocr" });
    retry.record({ provider: "openrouter", model: "google/gemini-3.1-flash-lite", metric: "page-analysis", inputTokens: 1, outputTokens: 2_500, costCents: 0, metadata: { documentId: "img", pageNumber: 1 } });
    expect(retry.snapshot().filter((event) => event.metric === "ingest-page-rich").map((event) => event.id)).toEqual(charges().map((event) => event.id));
  });

  it("bills every OCR reader as a Rich read of its page", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    for (const metric of ["page-ocr", "ocr-escalation", "hosted-ocr", "pdf-ocr", "ocr-native-pdf"]) {
      ledger.record({ provider: "local", model: "ppocr-v6-small", metric, amount: 1, unit: "image", costCents: 0, metadata: { documentId: metric, pageNumber: 1 } });
      expect(ledger.hasRichCharge(metric, 1)).toBe(true);
    }
  });

  it("bills an OCR escalation read one Rich page at most, and nothing when it returned no text", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    const escalation = (pageNumber: number, outputTokens: number, outcome: string) => ledger.record({
      provider: "deepinfra", model: "Qwen/Qwen3-VL-30B-A3B-Instruct", metric: "ocr-escalation", amount: 1, unit: "page",
      costCents: 0.3, inputTokens: 1_500, outputTokens, metadata: { documentId: "doc", pageNumber, outcome },
    });
    const charges = (pageNumber: number) => ledger.snapshot().filter((event) => event.metric === "ingest-page-rich" && event.metadata?.pageNumber === pageNumber);
    // 9,000 output tokens would owe 9 Rich units on a vision read; an escalation read owes one.
    escalation(1, 9_000, "completed");
    expect(charges(1).map((event) => event.id)).toEqual(["rich:run-1:doc:1"]);
    // Empty output: provider cost recorded (the event is kept), no Rich charge.
    expect(escalation(2, 40, "empty-output")).not.toBeNull();
    expect(charges(2)).toEqual([]);
    expect(ledger.hasRichCharge("doc", 2)).toBe(false);
    // A page the recogniser already charged stays one Rich page after its escalation.
    ledger.chargeRichPage({ documentId: "doc", pageNumber: 3, readBy: "page-ocr" });
    escalation(3, 4_000, "completed");
    expect(charges(3)).toHaveLength(1);
    expect(ledger.pendingBillableCents).toBeCloseTo(0.5);
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
      model: "price-card",
      metric: "ingest-page-fast",
      amount: 3,
      unit: "page",
      costCents: 0.015,
      metadata: { billable: true, unitCharge: true },
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
    expect(ledger.enqueue(fee)).toMatchObject({ costCents: 0.015 });
    expect(ledger.enqueue(failedAttempt, { logAiUsage: true })).toMatchObject({ metric: "page-analysis-attempt" });
    expect(
      ledger.enqueue({ ...localCompute, metric: "empty", amount: 0 }),
    ).toBeNull();

    expect(ledger.snapshot().map((event) => event.metric)).toEqual([
      "parser-process",
      "ingest-page-fast",
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

    // Provider cost is recorded, not billed.
    expect(ledger.totals()).toEqual({ inputTokens: 30, outputTokens: 5, costCents: 0 });
    expect(ledger.snapshot()).toHaveLength(2);
  });

  it("keeps a running billable total of buffered unit charges for the run cost cap", () => {
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    ledger.record({ provider: "anthropic", model: "model-1", metric: "page-analysis", inputTokens: 100, outputTokens: 12, costCents: 3, metadata: { documentId: "d", pageNumber: 1 } });
    ledger.record({ provider: "anthropic", model: "model-1", metric: "provider-charge-without-tokens", costCents: 99 });
    // The AI events bill nothing; the Rich page read bills 0.25.
    expect(ledger.snapshot()).toHaveLength(3);
    expect(ledger.pendingBillableCents).toBeCloseTo(0.25);
    const batch = ledger.checkpoint();
    ledger.record({ provider: "anthropic", model: "model-1", metric: "page-analysis", inputTokens: 1, costCents: 1, metadata: { documentId: "d", pageNumber: 2 } });
    batch.commit();
    expect(ledger.pendingBillableCents).toBeCloseTo(0.25);
  });
});


describe("Speed boost worker accounting", () => {
  it("multiplies the billable page once, preserves provider cost, and keeps retries idempotent", () => {
    const ledger = new PipelineUsageEventLedger(true);
    ledger.runId = "boost-run";
    const input = { provider: "openrouter", model: "z-ai/glm-5.3-flash:nitro", metric: "page-analysis",
      inputTokens: 100, outputTokens: 50, costCents: 0.37, metadata: { documentId: "boost-doc", pageNumber: 1 } };
    ledger.record(input);
    ledger.record(input);
    const charges = ledger.snapshot().filter(event => event.metric === "ingest-page-rich");
    expect(charges).toHaveLength(1);
    const boosted = pageCredits("rich", 1) * speedBoostMultiplier(true);
    expect(charges[0]).toMatchObject({ costCents: boosted, metadata: { speedBoost: true } });
    expect(ledger.pendingBillableCents).toBe(boosted);
    expect(ledger.snapshot().filter(event => event.metric === "page-analysis").every(event => event.metadata?.providerCostCents === 0.37)).toBe(true);
    expect(Reflect.set(ledger, "speedBoost", false)).toBe(false);
    const first = ledger.checkpoint();
    expect(ledger.checkpoint().events).toEqual(first.events);
    first.commit();
    first.commit();
    expect(ledger.pendingBillableCents).toBe(0);
  });
});
