import { describe, expect, it } from "vitest";

import {
  compilePipelinePlan,
  defaultPipelineFeatures,
  pipelineFeaturesSchema,
  pageRouterDecisionModels,
  resolvePageRouterMode,
  withPlatformPageRouterMode,
} from "../pipeline.js";

describe("page router workspace settings", () => {
  it("defaults to no mode and no route-pages stage", () => {
    const features = pipelineFeaturesSchema.parse({});
    expect(features.pageRouter.mode).toBeUndefined();
    expect(features.pageRouter).toMatchObject({
      objective: "cost-quality",
      router: "baseline",
      triageFormat: "per-page",
      pagesPerCall: 1,
      tilePx: 384,
    });
    expect(compilePipelinePlan(defaultPipelineFeatures).stageOrder).not.toContain("route-pages");
  });

  it("accepts a single decision model string or an ordered fallback list", () => {
    const single = pipelineFeaturesSchema.parse({ pageRouter: { decisionModel: "typesafe/jev-1.13" } }).pageRouter;
    expect(pageRouterDecisionModels(single)).toEqual(["typesafe/jev-1.13"]);
    const list = pipelineFeaturesSchema.parse({ pageRouter: { decisionModel: ["a/x", "b/y", "a/x"] } }).pageRouter;
    expect(pageRouterDecisionModels(list)).toEqual(["a/x", "b/y"]);
    expect(pageRouterDecisionModels(defaultPipelineFeatures.pageRouter)).toEqual([
      "openai/gpt-6-luna-decisions",
      "cloudflare/clef-flash",
      "typesafe/jev-1.13",
      "perplexity/pplx-decider-v1.1-27b",
    ]);
    // Liquid d1 stays in the catalog (and the pack) as an opt-in chain entry.
    expect(pageRouterDecisionModels(pipelineFeaturesSchema.parse({ pageRouter: { decisionModel: ["liquid/d1"] } }).pageRouter)).toEqual(["liquid/d1"]);
    expect(pipelineFeaturesSchema.safeParse({ pageRouter: { decisionModel: [] } }).success).toBe(false);
  });

  it("adds route-pages between classify-route and render-images when the workspace opts in", () => {
    const order = compilePipelinePlan({
      ...defaultPipelineFeatures,
      pageRouter: { ...defaultPipelineFeatures.pageRouter, mode: "shadow" },
    }).stageOrder;
    expect(order.indexOf("route-pages")).toBe(order.indexOf("classify-route") + 1);
    expect(order.indexOf("render-images")).toBe(order.indexOf("route-pages") + 1);
    const off = compilePipelinePlan({
      ...defaultPipelineFeatures,
      pageRouter: { ...defaultPipelineFeatures.pageRouter, mode: "off" },
    }).stageOrder;
    expect(off).not.toContain("route-pages");
  });

  it("caps the workspace mode by the worker env ceiling", () => {
    expect(resolvePageRouterMode("active", "off")).toBe("off");
    expect(resolvePageRouterMode("active", undefined)).toBe("off");
    expect(resolvePageRouterMode("active", "shadow")).toBe("shadow");
    expect(resolvePageRouterMode("shadow", "active")).toBe("shadow");
    expect(resolvePageRouterMode(undefined, "active")).toBe("off");
    expect(resolvePageRouterMode("active", "active")).toBe("active");
  });
});

describe("platform page-router default", () => {
  it("plans a shadow route-pages stage for workspaces with no mode when the platform runs the router", () => {
    for (const platform of ["shadow", "active"] as const) {
      const stamped = withPlatformPageRouterMode(defaultPipelineFeatures, platform);
      expect(stamped.pageRouter.mode).toBe("shadow");
      expect(compilePipelinePlan(stamped).stageOrder).toContain("route-pages");
    }
  });

  it("leaves workspaces alone when the platform is off or the workspace chose a mode", () => {
    expect(withPlatformPageRouterMode(defaultPipelineFeatures, "off")).toBe(defaultPipelineFeatures);
    expect(withPlatformPageRouterMode(defaultPipelineFeatures, undefined)).toBe(defaultPipelineFeatures);
    const off = { ...defaultPipelineFeatures, pageRouter: { ...defaultPipelineFeatures.pageRouter, mode: "off" as const } };
    expect(withPlatformPageRouterMode(off, "shadow").pageRouter.mode).toBe("off");
    const active = { ...defaultPipelineFeatures, pageRouter: { ...defaultPipelineFeatures.pageRouter, mode: "active" as const } };
    expect(withPlatformPageRouterMode(active, "shadow").pageRouter.mode).toBe("active");
  });
});
