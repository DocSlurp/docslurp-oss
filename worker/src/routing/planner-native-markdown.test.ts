import { describe, expect, it } from "vitest";
import { NATIVE_PDF_MARKDOWN_TARGET_ID } from "@docslurp/shared";

import { needsFromFeatures, planPages, preferNativeMarkdownFromEnv } from "./planner.js";
import { buildScoredEstimate, createPolicyEstimator, type TargetEstimator } from "./policy.js";
import { estimateTargetCost } from "./estimate.js";
import { makePage, testCatalog, testPack } from "./testing.js";

const catalog = testCatalog();
const base = createPolicyEstimator(testPack());

/** Pack-backed estimator, with a fitted-looking mapping for native-pdf Markdown. */
function estimator(p: number, n = 400): TargetEstimator {
  return (ctx) => {
    if (ctx.target.id !== NATIVE_PDF_MARKDOWN_TARGET_ID) return base(ctx);
    const pass = { text: p, math: 0.3, tables: 0.6, overall: p };
    return buildScoredEstimate({
      targetId: ctx.target.id,
      pPass: pass,
      n,
      dim: "text",
      cost: estimateTargetCost(ctx.target, ctx.role, ctx.scope, ctx.page),
    });
  };
}

const page = makePage({ pageNumber: 1 });
const needs = [{ ...needsFromFeatures(page), pTrustTextLayer: 0.97, pNeedsMath: 0, pNeedsTables: 0 }];
const plan = (config: Record<string, unknown>, est: TargetEstimator) =>
  planPages({ needs, pages: [page], catalog, objective: "cost-quality", estimator: est, config }).planned;

describe("flag-gated native-pdf Markdown preference for accept-text pages", () => {
  it("is off by default: the text layer is accepted as before", () => {
    const [a] = plan({}, estimator(0.97));
    expect(a!.assignment).toMatchObject({ role: "accept-text", targetId: "native:accept-text-layer" });
  });

  it("prefers native:pdf-markdown (as extract-text, so the stage replaces the slice) when it clears the floor", () => {
    const planned = plan({ preferNativeMarkdown: true }, estimator(0.97));
    expect(planned).toHaveLength(1);
    expect(planned[0]!.assignment).toMatchObject({ role: "extract-text", targetId: NATIVE_PDF_MARKDOWN_TARGET_ID, cascade: [] });
    expect(planned[0]!.assignment.reason).toContain("native-pdf markdown preferred");
  });

  it("keeps accept-text when the target's lower bound misses the floor", () => {
    const [a] = plan({ preferNativeMarkdown: true }, estimator(0.5));
    expect(a!.assignment).toMatchObject({ role: "accept-text", targetId: "native:accept-text-layer" });
  });

  it("keeps accept-text when the pack has no mapping for the target", () => {
    const [a] = plan({ preferNativeMarkdown: true }, (ctx) => (ctx.target.id === NATIVE_PDF_MARKDOWN_TARGET_ID ? null : base(ctx)));
    expect(a!.assignment).toMatchObject({ role: "accept-text", targetId: "native:accept-text-layer" });
  });

  it("never selects native:pdf-markdown for accept-text without the flag, even when it is the best target", () => {
    const [a] = plan({}, estimator(0.999, 100000));
    expect(a!.assignment.targetId).not.toBe(NATIVE_PDF_MARKDOWN_TARGET_ID);
  });

  it("reads the env flag", () => {
    expect(preferNativeMarkdownFromEnv({})).toBe(false);
    expect(preferNativeMarkdownFromEnv({ PAGE_ROUTER_PREFER_NATIVE_MARKDOWN: "1" })).toBe(true);
    expect(preferNativeMarkdownFromEnv({ PAGE_ROUTER_PREFER_NATIVE_MARKDOWN: "true" })).toBe(true);
    expect(preferNativeMarkdownFromEnv({ PAGE_ROUTER_PREFER_NATIVE_MARKDOWN: "0" })).toBe(false);
  });
});
