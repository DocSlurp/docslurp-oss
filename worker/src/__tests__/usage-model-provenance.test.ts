import { describe, expect, it } from "vitest";

import { runModelClass } from "../pipeline/pipeline.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";

/**
 * Every model call the worker records names what ran: the model as one llm:// URI with the settings it ran with, and
 * the levels the run was configured with (a project holds a level, never a model, so the record is where the model is).
 */
describe("usage ledger: what ran", () => {
  it("stamps recorded and pre-built events with the model URI, its settings and the run's levels", () => {
    const ledger = new PipelineUsageEventLedger();
    ledger.modelClass = runModelClass({ quality: "auto", vision: { profile: "good-fast-hosted" }, embedding: { profile: "cheapest-hosted" }, pageRouter: { router: "legacy" } } as never);
    expect(ledger.modelClass).toEqual({ quality: "auto", visionProfile: "good-fast-hosted", embeddingProfile: "cheapest-hosted", pageRouter: "legacy" });

    ledger.record({
      provider: "openrouter", model: "qwen/qwen3.5-flash-02-23", metric: "summary-tokens", inputTokens: 1200, outputTokens: 300,
      metadata: { modelConfig: { operation: "summary", reasoningEffort: "low", maxOutputTokens: 2048 } },
    } as never);
    ledger.enqueue({
      provider: "page-reader:gpu-a", model: "reader-v2", metric: "vision-page-reader", amount: 1, unit: "page", costCents: 0,
      inputTokens: 900, outputTokens: 400, metadata: { modelClass: { role: "page-reader" } },
    } as never);
    // A page charge is not a model call: nothing is named on it.
    ledger.enqueue({ provider: "docslurp", model: "price-card", metric: "pages-fast", amount: 3, unit: "page", costCents: 3, inputTokens: 0, outputTokens: 0, metadata: {} } as never);

    const events = ledger.snapshot();
    const text = events.find((event) => event.metric === "summary-tokens")!;
    expect(text.metadata).toMatchObject({
      modelUri: "llm://openrouter/qwen/qwen3.5-flash-02-23?maxOutputTokens=2048&operation=summary&reasoningEffort=low",
      modelClass: { quality: "auto", visionProfile: "good-fast-hosted", embeddingProfile: "cheapest-hosted" },
    });
    // The bare columns are unchanged: prices and reports still read them.
    expect(text).toMatchObject({ provider: "openrouter", model: "qwen/qwen3.5-flash-02-23" });
    const reader = events.find((event) => event.metric === "vision-page-reader")!;
    expect(reader.metadata).toMatchObject({ modelUri: "llm://page-reader-gpu-a/reader-v2", modelClass: { quality: "auto", role: "page-reader" } });
    const charge = events.find((event) => event.model === "price-card");
    expect(charge?.metadata).not.toHaveProperty("modelUri");
    expect(charge?.metadata).not.toHaveProperty("modelClass");
  });

  it("names no levels for a run without a pipeline", () => {
    expect(runModelClass(null)).toBeNull();
    expect(runModelClass({} as never)).toBeNull();
  });
});
