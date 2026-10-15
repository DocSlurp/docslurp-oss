import { describe, expect, it } from "vitest";
import { buildRoutingTargetCatalog, type RoutingTarget } from "@docslurp/shared";

import { needsFromFeatures, planPages } from "./planner.js";
import { createPolicyEstimator } from "./policy.js";
import { loadRuntimePolicyPack } from "./runtime.js";
import { makePage } from "./testing.js";

const SONNET = "vlm:openrouter/anthropic/claude-sonnet-5.5";
const prices = {
  asOf: "2026-10-12",
  models: {
    "google/gemini-3.5-flash": { input: 1.5, output: 9, vision: true },
    "google/gemini-3.5-flash-lite": { input: 0.2, output: 1.2, vision: true },
    "anthropic/claude-haiku-5.5": { input: 1, output: 5, vision: true },
    "anthropic/claude-sonnet-5.5": { input: 3, output: 15, vision: true },
  },
};
const catalog = buildRoutingTargetCatalog({ prices, env: { OPENROUTER_API_KEY: true }, checkedAt: "2026-10-12" }).targets;
const estimator = createPolicyEstimator(loadRuntimePolicyPack("decision-model"));
const scan = makePage({ pageNumber: 1, words: 0, fullPageImage: true, images: [{ coverage: 0.95 }] });
const plan = (targets: RoutingTarget[]) =>
  planPages({ needs: [needsFromFeatures(scan)], pages: [scan], catalog: targets, objective: "quality", estimator });

describe("escalation-only targets", () => {
  it("marks Sonnet 5.5 escalation-only in the catalog and nothing else in the transcription set", () => {
    expect(catalog.find((t) => t.id === SONNET)?.escalationOnly).toBe(true);
    expect(catalog.filter((t) => t.escalationOnly).map((t) => t.id)).toEqual([SONNET]);
  });

  it("never plans Sonnet as an assignment's primary target, even when quality is the objective", () => {
    const { planned } = plan(catalog);
    expect(planned.length).toBeGreaterThan(0);
    for (const p of planned) expect(p.assignment.targetId).not.toBe(SONNET);
  });

  it("may still use Sonnet as the cascade leg", () => {
    const { planned } = plan(catalog);
    const legs = planned.flatMap((p) => p.assignment.cascade.map((c) => c.targetId));
    for (const leg of legs) expect(catalog.some((t) => t.id === leg)).toBe(true);
  });

  it("rejects the role instead of using an escalation-only target as the only candidate", () => {
    const onlySonnet = catalog.filter((t) => t.id === SONNET);
    const { planned, rejected } = plan(onlySonnet);
    expect(planned).toEqual([]);
    expect(rejected.some((r) => r.reason === "capability")).toBe(true);
  });
});
