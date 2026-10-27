import { describe, expect, it } from "vitest";
import {
  buildDecisionModelCatalog,
  buildRoutingTargetCatalog,
  findDecisionModel,
} from "./routing-targets.js";
import type { RoutingTarget } from "./page-routing.js";
import { ROUTING_TARGET_SCHEMA_VERSION } from "./page-routing.js";

const prices = {
  asOf: "2026-10-12",
  models: {
    "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
    "google/gemini-3.1-flash-lite": { input: 0.1, output: 0.4 },
    "google/gemini-3.5-flash-lite": { input: 0.1, output: 0.4 },
    "z-ai/glm-5.3-flash": { input: 0.1, output: 0.4 },
    "google/gemini-3.5-flash": { input: 0.3, output: 2.5 },
    "openai/gpt-6-luna": { input: 0.2, output: 1.5 },
  },
};

function hosted(model: string): RoutingTarget {
  return {
    schemaVersion: ROUTING_TARGET_SCHEMA_VERSION,
    id: `vlm:openrouter/${model}`,
    kind: "hosted-vlm",
    ref: { modelUri: `llm://openrouter/${model}` },
    roles: ["extract-text"],
    capabilities: {
      imageInput: true,
      multiImagePerRequest: true,
      maxImagesPerRequest: 4,
      maxImageLongEdgePx: null,
      emitsLatex: false,
      emitsHtmlTables: false,
      usesNativeTextLayer: false,
    },
    pricing: { source: "model-prices.json", checkedAt: "x" },
    latency: { p50Ms: 0, p95Ms: 0, source: "unmeasured", n: 0 },
    availability: { requiresEnv: [], privacyClass: "hosted" },
  };
}

describe("buildRoutingTargetCatalog", () => {
  it("admits seeds, gating private targets on env", () => {
    const off = buildRoutingTargetCatalog({ prices });
    const ids = off.targets.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "native:kreuzberg",
        "native:pdf-markdown",
        "ocr:tesseract",
        "vlm:openrouter/google/gemini-3.5-flash",
        "vlm:openrouter/openai/gpt-6-luna",
      ]),
    );
    expect(ids.some((i) => i.startsWith("vlm:private/"))).toBe(false);
    // 3 seed private endpoints + 4 open transcription models (routing-targets-transcription.ts).
    expect(off.rejected.filter((r) => r.reason === "unavailable")).toHaveLength(7);
    const on = buildRoutingTargetCatalog({
      prices,
      env: { LIGHTONOCR_3_ENDPOINT_URL: true },
    });
    expect(on.targets.map((t) => t.id)).toContain("vlm:private/lightonocr-3");
  });

  it("declares roles per target, including accept-text-layer, labeler and skip", () => {
    const { targets } = buildRoutingTargetCatalog({ prices });
    const roles = (id: string) => targets.find((t) => t.id === id)?.roles;
    expect(roles("native:accept-text-layer")).toEqual(["accept-text"]);
    expect(roles("local:florence-2-small")).toEqual(["image-label"]);
    expect(roles("skip")).toEqual(["skip"]);
    expect(roles("ocr:tesseract")).toContain("ocr");
    expect(roles("vlm:openrouter/google/gemini-3.5-flash")).toEqual(
      expect.arrayContaining(["chart-data", "math", "diagram"]),
    );
    expect(roles("vlm:openrouter/z-ai/glm-5.3-flash")).toEqual(
      expect.arrayContaining(["extract-text", "ocr", "table", "image-label"]),
    );
    expect(roles("vlm:openrouter/google/gemini-3.1-flash-lite")).not.toContain(
      "chart-data",
    );
  });

  it("rejects hosted targets without a price", () => {
    const r = buildRoutingTargetCatalog({});
    expect(r.targets.some((t) => t.kind === "hosted-vlm")).toBe(false);
    expect(r.rejected.some((x) => x.reason === "missing-price")).toBe(true);
  });

  it("rejects Pro/Ultra ids", () => {
    for (const m of ["openai/gpt-6-pro", "x/model-ultra", "x/ultra"]) {
      const r = buildRoutingTargetCatalog({
        prices: { models: { [m]: { input: 1, output: 2 } } },
        extraTargets: [hosted(m)],
      });
      expect(r.rejected.find((x) => x.targetId.endsWith(m))?.reason).toBe(
        "prohibited-model",
      );
    }
  });

  it("rejects output price >= $50/M and VLMs without image input", () => {
    const r = buildRoutingTargetCatalog({
      prices: {
        models: {
          "a/costly": { input: 1, output: 50 },
          "a/blind": { input: 1, output: 2, vision: false },
        },
      },
      extraTargets: [hosted("a/costly"), hosted("a/blind")],
    });
    expect(r.rejected.find((x) => x.targetId.endsWith("a/costly"))?.reason).toBe(
      "output-price-too-high",
    );
    expect(r.rejected.find((x) => x.targetId.endsWith("a/blind"))?.reason).toBe(
      "no-image-input",
    );
  });
});

describe("buildDecisionModelCatalog", () => {
  it("admits only models whose env key is present", () => {
    const none = buildDecisionModelCatalog({});
    expect(none.models.map((m) => m.id)).toEqual([
      "local/LiquidAI/d1-omni-600M",
    ]);
    const all = buildDecisionModelCatalog({
      env: {
        PERPLEXITYAI_API_KEY: true,
        OPENROUTER_API_KEY: true,
        LIQUID_API_KEY: true,
      },
    });
    expect(all.models.map((m) => m.id)).toEqual([
      "perplexity/pplx-decider-v1.1-27b",
      "typesafe/jev-1.13",
      "liquid/d1",
      "liquid/d1:direct",
      "local/LiquidAI/d1-omni-600M",
      "cloudflare/clef-flash",
      "cloudflare/clef-omni",
      "openai/gpt-6-luna-decisions",
    ]);
    for (const id of ["liquid/d1", "liquid/d1:direct"]) {
      expect(all.models.find((model) => model.id === id)!.pricing).toMatchObject({
        inputUsdPerMTok: 0.02, outputUsdPerMTok: 0, checkedAt: "2026-10-25",
      });
    }
    const jev = all.models.find((m) => m.id === "typesafe/jev-1.13")!;
    expect(jev.modalities.image).toBe(false);
    expect(jev.pricing.inputUsdPerMTok).toBe(0.042);
    expect(
      all.models.find((m) => m.id === "liquid/d1:direct")!.modalities
        .maxImagesPerRequest,
    ).toBe(8);
  });

  it("records Clef limits and per-call billing next to per-question pplx/d1 billing", () => {
    const all = buildDecisionModelCatalog({ env: { PERPLEXITYAI_API_KEY: true, OPENROUTER_API_KEY: true } }).models;
    const byId = (id: string) => all.find((m) => m.id === id)!;
    for (const id of ["cloudflare/clef-flash", "cloudflare/clef-omni"]) {
      const clef = byId(id);
      expect(clef.endpoint).toBe("openrouter-systemone");
      expect(clef.modalities).toMatchObject({ image: true, maxImagesPerRequest: 4 });
      expect(clef.maxQuestionsPerRequest).toBe(64);
      expect(clef.billingMode).toBe("per-call");
    }
    expect(byId("cloudflare/clef-flash").pricing.inputUsdPerMTok).toBe(0.038);
    expect(byId("cloudflare/clef-omni").pricing.inputUsdPerMTok).toBe(0.15);
    expect(byId("openai/gpt-6-luna-decisions").modalities.image).toBe(true);
    expect(byId("perplexity/pplx-decider-v1.1-27b").billingMode).toBe("per-question");
    expect(findDecisionModel("cloudflare/clef-flash")?.id).toBe("cloudflare/clef-flash");
    expect(findDecisionModel("nope")).toBeUndefined();
  });

  it("rejects output-billed, unpriced and Pro/Ultra models", () => {
    const seed = buildDecisionModelCatalog({}).models[0]!;
    const r = buildDecisionModelCatalog({
      extraModels: [
        {
          ...seed,
          id: "x/billed",
          pricing: { ...seed.pricing, outputUsdPerMTok: 2 as unknown as 0 },
        },
        {
          ...seed,
          id: "x/unpriced",
          pricing: { checkedAt: "x" } as unknown as typeof seed.pricing,
        },
        { ...seed, id: "x/decider-pro" },
      ],
    });
    const reason = (id: string) =>
      r.rejected.find((x) => x.modelId === id)?.reason;
    expect(reason("x/billed")).toBe("output-billed");
    expect(reason("x/unpriced")).toBe("missing-price");
    expect(reason("x/decider-pro")).toBe("prohibited-model");
  });
});
