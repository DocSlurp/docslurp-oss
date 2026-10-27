import { describe, expect, it } from "vitest";

import {
  buildAiUsageLedgerEvent,
  buildPricedAiUsageLedgerEvent,
  calculateAiUsageCostCents,
  estimateAiUsageCostCents,
  formatAiUsageConsoleLog,
  hasAiUsageLedgerTokens,
  resolveAiUsagePricing,
} from "../index.js";

describe("AI usage ledger helpers", () => {
  it("builds token usage events with shared defaults", () => {
    expect(
      buildAiUsageLedgerEvent({
        provider: "openrouter",
        model: "model-1",
        metric: "query-rewrite",
        inputTokens: 12,
        outputTokens: 4,
        metadata: { sessionId: "session-1" },
      }),
    ).toEqual({
      provider: "openrouter",
      model: "model-1",
      metric: "query-rewrite",
      amount: 16,
      unit: "token",
      costCents: 0,
      inputTokens: 12,
      outputTokens: 4,
      metadata: { sessionId: "session-1" },
    });
  });

  it("prices small hosted embeddings at the verified model rate", () => {
    const event = buildPricedAiUsageLedgerEvent({ provider: "openai", model: "text-embedding-3-small", metric: "embedding-tokens", inputTokens: 1_000_000 });
    expect(event.costCents).toBe(2);
    expect(event.metadata.costSource).toBe("estimate");
  });

  it("preserves explicit amount, unit, cost, and default metadata", () => {
    expect(
      buildAiUsageLedgerEvent({
        provider: "openai",
        model: "text-embedding-3-small",
        metric: "embed-document",
        amount: 1,
        unit: "document",
        inputTokens: 20,
        costCents: 3,
      }),
    ).toMatchObject({
      amount: 1,
      unit: "document",
      costCents: 3,
      metadata: {},
    });
  });

  it("preserves fractional token cost from input and output rates", () => {
    expect(
      calculateAiUsageCostCents({
        inputTokens: 1200,
        outputTokens: 500,
        costPer1kInputTokens: 0.01,
        costPer1kOutputTokens: 0.03,
      }),
    ).toBeCloseTo(0.027, 10);
    expect(
      calculateAiUsageCostCents({
        inputTokens: 0,
        outputTokens: 0,
        costPer1kInputTokens: 0.01,
        costPer1kOutputTokens: 0.03,
      }),
    ).toBe(0);
  });

  it("resolves provider/model pricing and builds priced ledger events", () => {
    expect(
      resolveAiUsagePricing({
        provider: "openrouter",
        model: "qwen/qwen3.5-flash-02-23",
      }),
    ).toEqual({
      costPer1kInputTokens: 0.0065,
      costPer1kOutputTokens: 0.026,
    });

    expect(
      buildPricedAiUsageLedgerEvent({
        provider: "openrouter",
        model: "qwen/qwen3.5-flash-02-23",
        metric: "query-answer",
        inputTokens: 1200,
        outputTokens: 500,
      }).costCents,
    ).toBeCloseTo(0.0208, 10);

    expect(
      estimateAiUsageCostCents(
        {
          provider: "unknown",
          model: "unknown",
          inputTokens: 1000,
        },
        {
          fallback: {
            costPer1kInputTokens: 2,
            costPer1kOutputTokens: 4,
          },
        },
      ),
    ).toBe(2);
  });

  it("filters zero-token usage events", () => {
    expect(
      hasAiUsageLedgerTokens(
        buildAiUsageLedgerEvent({
          provider: "openrouter",
          model: "model-1",
          metric: "noop",
        }),
      ),
    ).toBe(false);

    expect(
      hasAiUsageLedgerTokens(
        buildAiUsageLedgerEvent({
          provider: "openrouter",
          model: "model-1",
          metric: "output-only",
          outputTokens: 1,
        }),
      ),
    ).toBe(true);
  });

  it("formats the required console log line", () => {
    const event = buildAiUsageLedgerEvent({
      provider: "openrouter",
      model: "model-1",
      metric: "summary-generation",
      inputTokens: 20,
      outputTokens: 5,
    });

    expect(formatAiUsageConsoleLog(event)).toBe(
      "[ai-usage] summary-generation model=model-1 input_tokens=20 output_tokens=5",
    );
    expect(formatAiUsageConsoleLog(event, { includeOutputTokens: false })).toBe(
      "[ai-usage] summary-generation model=model-1 input_tokens=20",
    );
  });
});
