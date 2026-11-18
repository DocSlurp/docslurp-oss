import { describe, expect, it } from "vitest";

import { buildChartExportUsage } from "../chart-export/generator.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";

describe("chart export usage records", () => {
  it("carry the request settings and the tier that admitted the call", () => {
    const usage = buildChartExportUsage(
      { text: "{}", model: "vendor/vision-1", provider: "openrouter", inputTokens: 900, outputTokens: 120, costCents: 0.2, latencyMs: 800 },
      {
        documentId: "doc-1", candidate: { id: "v1", pageNumber: 3, imageIndex: 0 } as never, source: "vision", purpose: "spec" as never,
        format: "vega-lite" as never, ok: true, modelUri: "llm://openrouter/vendor/vision-1", maxOutputTokens: 2048, tier: "models",
      },
    );
    expect(usage.metadata).toMatchObject({
      modelConfig: { operation: "chart-export", purpose: "spec", format: "vega-lite", maxOutputTokens: 2048, input: "vision" },
      modelClass: { chartExportTier: "models" },
    });
    const ledger = new PipelineUsageEventLedger();
    ledger.runId = "run-1";
    const event = ledger.record(usage);
    expect(event?.metadata?.modelUri).toBe("llm://openrouter/vendor/vision-1?format=vega-lite&input=vision&maxOutputTokens=2048&operation=chart-export&purpose=spec");
  });
});
