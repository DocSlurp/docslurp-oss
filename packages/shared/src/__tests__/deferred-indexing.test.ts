import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY,
  DEFAULT_SERVER_MATERIALIZATION_POLICY,
  classifyTemperature,
  compilePipelinePlan,
  defaultIndexingModeForPlan,
  estimatePageEmbedCredits,
  isBillingEnforced,
  workspaceTemplates,
  deferredProfilesEnabled,
  narrowMaterializationPolicy,
  normalizePipelineFeatures,
  pipelineStageOrder,
  defaultPipelineFeatures,
  pipelineVersionFeatures,
} from "../index.js";

describe("narrowMaterializationPolicy", () => {
  it("takes min of numbers, AND of booleans and the lower router", () => {
    const out = narrowMaterializationPolicy(
      DEFAULT_SERVER_MATERIALIZATION_POLICY,
      { maxPagesPerQuery: 100, mapRouter: "auto" },
      { maxPagesPerQuery: 10, allowFullIndexRequest: true },
    );
    expect(out.maxPagesPerQuery).toBe(10);
    expect(out.mapRouter).toBe("auto");
    expect(out.allowFullIndexRequest).toBe(true);
    const client = narrowMaterializationPolicy(DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY, {
      allowFullIndexRequest: true,
    });
    expect(client.allowFullIndexRequest).toBe(false);
  });

  it("never widens", () => {
    expect(
      narrowMaterializationPolicy(DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY, { maxCreditsPerQuery: 9999 })
        .maxCreditsPerQuery,
    ).toBe(25);
    expect(
      narrowMaterializationPolicy({ ...DEFAULT_SERVER_MATERIALIZATION_POLICY, mapRouter: "off" }, { mapRouter: "always" })
        .mapRouter,
    ).toBe("off");
  });

  it("has the documented client defaults", () => {
    expect(DEFAULT_CLIENT_KEY_MATERIALIZATION_POLICY).toMatchObject({
      maxPagesPerQuery: 40,
      maxCreditsPerQuery: 25,
      deadlineMs: 20000,
      allowFullIndexRequest: false,
      allowAgentDiscovery: true,
      mapRouter: "always",
    });
  });
});

describe("defaults and helpers", () => {
  it("picks indexing mode from plan", () => {
    expect(defaultIndexingModeForPlan({ planId: "free", hasPurchasedCredits: false })).toBe("map");
    expect(defaultIndexingModeForPlan({ planId: "free", hasPurchasedCredits: true })).toBe("full");
    expect(defaultIndexingModeForPlan({ planId: "gold", hasPurchasedCredits: false })).toBe("full");
    expect(defaultIndexingModeForPlan({ planId: null, hasPurchasedCredits: false })).toBe("map");
  });
  it("never defaults to visual for any plan, with or without credits", () => {
    for (const planId of [null, undefined, "free", "starter", "gold", "enterprise", "unknown"]) {
      for (const hasPurchasedCredits of [false, true]) {
        expect(defaultIndexingModeForPlan({ planId, hasPurchasedCredits })).not.toBe("visual");
      }
    }
  });
  it("no workspace template opts into page-image embedding", () => {
    expect(workspaceTemplates.length).toBeGreaterThan(0);
    for (const template of workspaceTemplates) {
      expect(template.pipeline.indexingMode, template.key).not.toBe("visual");
      expect(template.pipeline.visualPages.coarseFallback, template.key).toBe(false);
    }
  });
  it("coarseFallback defaults off and is estimated as a non-zero embedding cost", () => {
    expect(defaultPipelineFeatures.visualPages.coarseFallback).toBe(false);
    expect(normalizePipelineFeatures({}).visualPages.coarseFallback).toBe(false);
    expect(estimatePageEmbedCredits(1000)).toBeGreaterThan(0);
  });
  it("bills only when Stripe is configured or a DOCSLURP_BILL_* flag is on", () => {
    expect(isBillingEnforced({})).toBe(false);
    expect(isBillingEnforced({ DOCSLURP_BILL_COMPUTE: "false", DOCSLURP_BILL_STORAGE: "" })).toBe(false);
    expect(isBillingEnforced({ STRIPE_SECRET_KEY: "sk_live_x" })).toBe(true);
    expect(isBillingEnforced({ DOCSLURP_BILL_STORAGE: "true" })).toBe(true);
  });
  it("classifies temperature", () => {
    expect(classifyTemperature(10, 0)).toBe("cold");
    expect(classifyTemperature(10, 4)).toBe("warm");
    expect(classifyTemperature(10, 10)).toBe("hot");
    expect(classifyTemperature(0, 0)).toBe("hot");
  });
  it("reads the feature flag", () => {
    expect(deferredProfilesEnabled({ DOCSLURP_DEFERRED_PROFILES: "1" })).toBe(true);
    expect(deferredProfilesEnabled({})).toBe(false);
  });
});

const TODAY_ORDER = [
  "quarantine", "format-detect", "to-canonical", "format-tooling", "normalize", "pdf-tooling", "split-pages",
  "extract-markdown", "classify-route", "render-images", "vision-extract", "embed", "index",
];

describe("pipeline stage plan", () => {
  it("full mode keeps today's order without locator stages", () => {
    const order = compilePipelinePlan({ indexingMode: "full" }).stageOrder;
    expect(order).toEqual(compilePipelinePlan().stageOrder);
    expect(order).toEqual(TODAY_ORDER);
  });
  it("map mode runs document-map only", () => {
    const order = compilePipelinePlan({ indexingMode: "map" }).stageOrder;
    expect(order).toContain("document-map");
    for (const s of ["extract-markdown", "embed", "index", "page-embed"] as const) expect(order).not.toContain(s);
  });
  it("visual mode runs page-embed only", () => {
    const order = compilePipelinePlan({ indexingMode: "visual" }).stageOrder;
    expect(order).toContain("page-embed");
    for (const s of ["extract-markdown", "embed", "index", "document-map"] as const) expect(order).not.toContain(s);
  });
  it("full mode never enables page-embed, even with the coarse fallback opted in", () => {
    const plan = compilePipelinePlan({ indexingMode: "full", visualPages: { route: "auto", coarseFallback: true } } as never);
    expect(plan.stageOrder).not.toContain("page-embed");
    expect(compilePipelinePlan({ indexingMode: "map", visualPages: { route: "auto", coarseFallback: true } } as never).stageOrder).not.toContain("page-embed");
  });
  it("hash features ignore visualPages so a stored pipeline without it is not stale (M7)", () => {
    const hash = (f: object) => JSON.stringify(pipelineVersionFeatures(f));
    const stored = { ...defaultPipelineFeatures } as Record<string, unknown>;
    delete stored.visualPages;
    expect(hash(stored)).toBe(hash({ ...defaultPipelineFeatures, visualPages: { route: "auto" } }));
    expect(hash(stored)).toBe(hash({ ...defaultPipelineFeatures, visualPages: { route: "local" } }));
    expect(hash(stored)).toBe(hash({ ...defaultPipelineFeatures, visualPages: { route: "auto", coarseFallback: true } }));
  });
  it("hash features ignore indexingMode and materialization", () => {
    const hash = (f: object) => JSON.stringify(pipelineVersionFeatures(normalizePipelineFeatures(f)));
    expect(hash({ indexingMode: "map" })).toBe(
      hash({ indexingMode: "full", materialization: { maxPagesPerQuery: 3 } }),
    );
  });
});
