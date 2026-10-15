import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { QuestionCalibration } from "@docslurp/shared";
import { applyCalibration, applyPassMapping, calibrateAnswers, createPolicyEstimator, indexCalibrations, loadPolicyPack, lowerBound, targetMappings } from "./policy.js";
import { TEST_PRIOR_PACK_PATH, makePage, testCatalog, testPack } from "./testing.js";

const platt: QuestionCalibration = { decisionModel: "m", questionId: "has_math", n: 10, brier: null, auroc: null, method: "platt", params: { a: 2, b: 0 } };
const iso: QuestionCalibration = { decisionModel: "m", questionId: "has_table", n: 10, brier: null, auroc: null, method: "isotonic", table: { xs: [0, 0.4, 0.8], ys: [0.05, 0.5, 0.95] } };

describe("policy pack", () => {
  it("the v0 prior test fixture loads, is marked prior and holds no fixture content", () => {
    const pack = testPack();
    expect(pack.metadata.policyVersion).toMatch(/prior/);
    expect(pack.metadata.splitPolicy).toMatch(/prior/i);
    const raw = readFileSync(TEST_PRIOR_PACK_PATH, "utf8");
    expect(raw).not.toMatch(/\.pdf|case-|filename/i);
    // every catalog target the router can pick has a mapping
    const ids = new Set(pack.targets.map((t) => t.targetId));
    for (const t of testCatalog()) expect(ids.has(t.id)).toBe(true);
  });
  it("rejects stale schema versions and inconsistent packs", () => {
    const pack = testPack();
    expect(() => loadPolicyPack({ ...pack, schemaVersion: "policy-pack@v0" })).toThrow();
    expect(() => loadPolicyPack({ ...pack, targets: [...pack.targets, pack.targets[0]!] })).toThrow(/duplicate/);
    expect(() => loadPolicyPack({ ...pack, calibrations: [{ ...platt, decisionModel: "nope" }] })).toThrow(/unlisted decision model/);
    expect(() => loadPolicyPack({ ...pack, calibrations: [{ ...iso, decisionModel: pack.decisionModels[0]!, table: { xs: [0.5, 0.1], ys: [0.2, 0.9] } }] })).toThrow(/not sorted/);
    const own = { ...pack.targets[0]!, decisionModel: pack.decisionModels[0]! };
    expect(loadPolicyPack({ ...pack, targets: [...pack.targets, own] }).targets).toHaveLength(pack.targets.length + 1);
    expect(() => loadPolicyPack({ ...pack, targets: [...pack.targets, own, own] })).toThrow(/duplicate target mapping .* for /);
    expect(() => loadPolicyPack({ ...pack, targets: [...pack.targets, { ...own, decisionModel: "nope/x" }] })).toThrow(/unlisted decision model nope\/x/);
    expect(() => loadPolicyPack({ ...pack, targets: [{ ...own, targetId: "vlm:orphan" }, ...pack.targets] })).toThrow(/no default mapping/);
  });
});

describe("calibration", () => {
  it("platt: identity at 0.5, sharpens away from it", () => {
    expect(applyCalibration(platt, 0.5)).toBeCloseTo(0.5, 6);
    expect(applyCalibration(platt, 0.9)).toBeGreaterThan(0.9);
    expect(applyCalibration(undefined, 0.3)).toBe(0.3);
  });
  it("isotonic: step table lookup is monotone", () => {
    expect(applyCalibration(iso, 0.1)).toBe(0.05);
    expect(applyCalibration(iso, 0.4)).toBe(0.5);
    expect(applyCalibration(iso, 0.99)).toBe(0.95);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) { const y = applyCalibration(iso, x); expect(y).toBeGreaterThanOrEqual(prev); prev = y; }
  });
  it("calibrateAnswers applies per (model, question)", () => {
    const pack = { ...testPack(), decisionModels: ["m"], calibrations: [{ ...platt }] };
    const out = calibrateAnswers(indexCalibrations(pack), { probabilities: { has_math: 0.9, has_table: 0.9 }, choices: {}, source: { decisionModel: "m", format: "grid", pagesPerCall: 4, tilePx: 256 } });
    expect(out.has_math).toBeGreaterThan(0.9);
    expect(out.has_table).toBe(0.9);
  });
});

describe("pass mapping and estimates", () => {
  it("uses the serving model's own mapping and falls back to the default for other models and targets", () => {
    const base = testPack();
    const model = base.decisionModels[0]!;
    const target = testCatalog().find((t) => t.id === "native:pdf-text")!;
    const other = testCatalog().find((t) => t.id === "vlm:openrouter/google/gemini-3.5-flash")!;
    const always = { intercept: 0, weights: {}, baseRate: 0.99 };
    const own = { ...base.targets.find((t) => t.targetId === target.id)!, decisionModel: model, pass: { text: always, math: always, tables: always, overall: always } };
    const pack = loadPolicyPack({ ...base, targets: [...base.targets, own] });
    const ctx = { page: makePage(), role: "extract-text" as const, scope: { kind: "page" as const }, probs: {} };
    expect(targetMappings(pack, model).get(target.id)).toBe(pack.targets.at(-1));
    expect(targetMappings(pack).get(target.id)?.decisionModel).toBeUndefined();
    expect(createPolicyEstimator(pack, { decisionModel: model })({ ...ctx, target })!.pPass.text).toBe(0.99);
    expect(createPolicyEstimator(pack, { decisionModel: "other/model" })({ ...ctx, target })!.pPass.text)
      .toBe(createPolicyEstimator(base)({ ...ctx, target })!.pPass.text);
    expect(createPolicyEstimator(pack, { decisionModel: model })({ ...ctx, target: other })!.pPass)
      .toEqual(createPolicyEstimator(base)({ ...ctx, target: other })!.pPass);
  });

  const m = { intercept: -1, weights: { has_math: 2 }, baseRate: 0.7 };
  it("returns baseRate with no answers, logistic otherwise", () => {
    expect(applyPassMapping(m, {})).toBe(0.7);
    expect(applyPassMapping(m, { has_math: 1 })).toBeCloseTo(1 / (1 + Math.exp(-1)), 6);
  });
  it("lower bound shrinks with small n and never exceeds p", () => {
    expect(lowerBound(0.9, 5)).toBeLessThan(lowerBound(0.9, 500));
    expect(lowerBound(0.9, 5)).toBeLessThanOrEqual(0.9);
  });
  it("estimator: strong VLM beats native text on math; costs come from catalog", () => {
    const est = createPolicyEstimator(testPack());
    const catalog = testCatalog();
    const page = makePage();
    const get = (id: string) => est({ page, role: "math", scope: { kind: "page" }, target: catalog.find((t) => t.id === id)!, probs: { needs_math_extraction: 0.95 } })!;
    expect(get("vlm:openrouter/google/gemini-3.5-flash").pPass.math).toBeGreaterThan(get("native:pdf-text").pPass.math);
    expect(get("vlm:openrouter/google/gemini-3.5-flash").expectedCostUsd).toBeGreaterThan(0);
    expect(get("native:pdf-text").pPassLowerBound!.math).toBeLessThanOrEqual(get("native:pdf-text").pPass.math);
    expect(est({ page, role: "math", scope: { kind: "page" }, target: { ...catalog[0]!, id: "unknown:x" }, probs: {} })).toBeNull();
  });
});
