import { describe, expect, it } from "vitest";
import { ROUTING_TARGET_SCHEMA_VERSION, type RoutingTarget } from "@docslurp/shared";

import { createDecisionClient, DecisionUnavailableError } from "./decision-client.js";
import { executorFor } from "./executors/registry.js";
import { buildRuntimeCatalog } from "./runtime.js";
import { catalogModel } from "./routing-test-fixtures.js";

const env = {
  OPENROUTER_API_KEY: "x",
  LIQUID_API_KEY: "x",
  PERPLEXITYAI_API_KEY: "x",
  DOTS_OCR_ENDPOINT_URL: "http://dots",
  OLMOCR_2_ENDPOINT_URL: "http://olm",
  LIGHTONOCR_3_ENDPOINT_URL: "http://lighton",
};

describe("DISABLE_NON_FREE_SOFTWARE in the runtime catalog", () => {
  // The private VLM seeds (dots-ocr is non-free) carry no registry alias, so the vision runtime would refuse them and
  // the catalog never admits them (runtime.ts vlmTargetProblem); the flag is observed on the decision models.
  const dmIds = (catalog: ReturnType<typeof buildRuntimeCatalog>) => catalog.decisionModels.map((m) => m.id);

  it("allows non-free decision models by default", () => {
    const catalog = buildRuntimeCatalog({ env });
    expect(dmIds(catalog)).toContain("liquid/d1:direct");
    expect(dmIds(catalog)).toContain("liquid/d1");
    expect(catalog.allTargets.map((t) => t.id)).not.toContain("vlm:private/dots-ocr");
  });

  it("drops them when the env flag is true (read through flags.ts)", () => {
    const catalog = buildRuntimeCatalog({ env: { ...env, DISABLE_NON_FREE_SOFTWARE: "true" } });
    expect(dmIds(catalog)).not.toContain("liquid/d1:direct");
    // liquid/d1 via OpenRouter is a hosted API (proprietary-hosted), so the flag keeps it.
    expect(dmIds(catalog)).toContain("liquid/d1");
    expect(dmIds(catalog)).toContain("cloudflare/clef-flash");
  });

  it("an explicit option overrides the environment", () => {
    expect(dmIds(buildRuntimeCatalog({ env, disableNonFree: true }))).not.toContain("liquid/d1:direct");
    const off = buildRuntimeCatalog({ env: { ...env, DISABLE_NON_FREE_SOFTWARE: "true" }, disableNonFree: false });
    expect(dmIds(off)).toContain("liquid/d1:direct");
  });
});

describe("DISABLE_NON_FREE_SOFTWARE in executors and the decision client", () => {
  const dots: RoutingTarget = {
    schemaVersion: ROUTING_TARGET_SCHEMA_VERSION,
    id: "vlm:private/dots-ocr",
    kind: "private-vlm",
    ref: { modelUri: "llm://private/dots-ocr" },
    roles: ["ocr"],
    capabilities: { imageInput: true, multiImagePerRequest: false, maxImagesPerRequest: 1, maxImageLongEdgePx: null, emitsLatex: false, emitsHtmlTables: true, usesNativeTextLayer: false },
    pricing: { source: "private-endpoint", checkedAt: "x" },
    latency: { p50Ms: 0, p95Ms: 0, source: "unmeasured", n: 0 },
    availability: { requiresEnv: [], privacyClass: "private" },
  };

  it("refuses to execute a non-free target only when the flag is on", () => {
    const prev = process.env.DISABLE_NON_FREE_SOFTWARE;
    try {
      delete process.env.DISABLE_NON_FREE_SOFTWARE;
      expect(executorFor(dots)).not.toBeNull();
      process.env.DISABLE_NON_FREE_SOFTWARE = "true";
      expect(executorFor(dots)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.DISABLE_NON_FREE_SOFTWARE;
      else process.env.DISABLE_NON_FREE_SOFTWARE = prev;
    }
  });

  it("refuses to call a non-free decision model when the flag is on", async () => {
    const model = catalogModel("liquid/d1:direct");
    const client = createDecisionClient({ privacyMode: "standard", env: { DISABLE_NON_FREE_SOFTWARE: "1", LIQUID_API_KEY: "x" } });
    await expect(client.ask(model, { text: "s" } as never, { q: "q" } as never)).rejects.toBeInstanceOf(DecisionUnavailableError);
  });
});
