import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_ROUTER_DECISION_MODELS, NATIVE_PDF_MARKDOWN_TARGET_ID } from "@docslurp/shared";

import { packHasCalibrations } from "./health/chain.js";
import { needsFromDecisions, planPages } from "./planner.js";
import { calibrateAnswers, createPolicyEstimator, indexCalibrations, loadPolicyPack } from "./policy.js";
import { RUNTIME_POLICY_PACKS, loadRuntimePolicyPack, resetRuntimeAssetCaches, routingAssetPath } from "./runtime.js";
import { makePage, testCatalog } from "./testing.js";

// The shipped packs (current fit only; superseded packs live in scripts/page-router/packs/).
const raw = readFileSync(routingAssetPath(RUNTIME_POLICY_PACKS["decision-model"])!, "utf8");
const pack = loadPolicyPack(JSON.parse(raw));

/** Every case id and routing page uid of the evaluation data, when it is on this machine. */
function evalCaseIds(): Set<string> {
  const runs = path.join(process.env.DOCSLURP_EVAL_DATA_DIR ?? "/path/to/eval-data", "runs/page-router-20261012");
  const ids = new Set<string>();
  const w11 = path.join(runs, "w11-table-tolerant/labels.jsonl");
  if (existsSync(w11)) for (const line of readFileSync(w11, "utf8").split("\n")) if (line.trim()) ids.add(JSON.parse(line).caseId);
  const routing = path.join(runs, "w4-deciders/labels_routing.json");
  if (existsSync(routing)) for (const uid of Object.keys(JSON.parse(readFileSync(routing, "utf8")))) ids.add(uid.split(":")[1]!);
  return ids;
}

describe("runtime policy packs", () => {
  it("loads exactly the shipped pack per router and caches it", () => {
    resetRuntimeAssetCaches();
    const dm = loadRuntimePolicyPack("decision-model");
    expect(dm.metadata.policyVersion).toBe(RUNTIME_POLICY_PACKS["decision-model"].replace(/\.json$/, ""));
    expect(loadRuntimePolicyPack("decision-model")).toBe(dm);
    expect(loadRuntimePolicyPack("baseline").baseline?.cells.length).toBeGreaterThan(0);
    resetRuntimeAssetCaches();
  });

  it("ships no superseded pack", () => {
    for (const v of [0, 1, 2, 3, 4]) expect(routingAssetPath(`page-router-dm-v${v}.json`)).toBeNull();
  });
});

describe("current decision-model pack", () => {
  it("carries fit metadata from development+calibration only", () => {
    expect(pack.metadata.passThreshold).toBe(0.85);
    expect(pack.metadata.trainingDataSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(pack.metadata.splitPolicy).toMatch(/development\+calibration/);
    expect(pack.questions).toEqual(["plain_ocr_sufficient", "needs_math_extraction", "needs_table_structure"]);
  });

  it("calibrates every default chain model except the quarantined decider on every question", () => {
    for (const id of DEFAULT_PAGE_ROUTER_DECISION_MODELS.filter((m) => !m.startsWith("perplexity/"))) {
      expect(packHasCalibrations(pack, id), id).toBe(true);
      const cals = pack.calibrations.filter((c) => c.decisionModel === id);
      expect(cals.map((c) => c.questionId).sort()).toEqual([...pack.questions].sort());
      for (const c of cals) expect(c.n).toBeGreaterThan(100);
    }
  });

  it("maps every target for every serving model of the default chain (own fit or the default)", () => {
    const defaults = pack.targets.filter((t) => !t.decisionModel).map((t) => t.targetId).sort();
    for (const id of DEFAULT_PAGE_ROUTER_DECISION_MODELS.filter((m) => packHasCalibrations(pack, m))) {
      const own = pack.targets.filter((t) => t.decisionModel === id).map((t) => t.targetId).sort();
      // The primary model is served by the default mappings; every other calibrated chain model has its own.
      if (own.length > 0) expect(own, id).toEqual(defaults);
    }
    expect(pack.targets.some((t) => t.decisionModel === "openai/gpt-6-luna-decisions")).toBe(true);
    expect(pack.targets.some((t) => t.decisionModel === "typesafe/jev-1.13")).toBe(true);
  });

  it("maps targets the catalog knows, with sane pass rates, costs and latencies", () => {
    const ids = new Set(testCatalog().map((t) => t.id));
    for (const t of pack.targets) {
      expect(t.n, t.targetId).toBeGreaterThan(0);
      for (const dim of ["text", "math", "tables", "overall"] as const) {
        expect(t.pass[dim].baseRate).toBeGreaterThan(0);
        expect(t.pass[dim].baseRate).toBeLessThan(1);
      }
      expect(t.latency.p50Ms).toBeGreaterThan(0);
      if (t.targetId.startsWith("native:") || t.targetId.startsWith("ocr:")) expect(t.cost.meanUsd).toBe(0);
    }
    for (const id of ["native:accept-text-layer", NATIVE_PDF_MARKDOWN_TARGET_ID]) expect(ids.has(id), id).toBe(true);
    for (const id of ["native:accept-text-layer", NATIVE_PDF_MARKDOWN_TARGET_ID, "vlm:openrouter/anthropic/claude-haiku-5.5"]) {
      expect(pack.targets.some((t) => t.targetId === id), id).toBe(true);
    }
  });

  it("contains no benchmark case ids, uids or fixture names", () => {
    const strings: string[] = [];
    JSON.parse(raw, (_key, value) => { if (typeof value === "string") strings.push(value); return value; });
    const allowed = [
      /^policy-pack@v1$/, /^page-router-dm-v\d+$/, /^[a-f0-9]{64}$/, /^\d{4}-\d{2}-\d{2}$/, /^platt$/,
      /^(plain_ocr_sufficient|needs_math_extraction|needs_table_structure)$/,
      /^(cloudflare|openai|typesafe|liquid)\/[a-z0-9.-]+$/,
      /^(native|ocr|vlm):[a-z0-9./:-]+$/,
    ];
    expect(strings.filter((s) => !allowed.some((re) => re.test(s)) && s !== pack.metadata.splitPolicy)).toEqual([]);
    for (const id of evalCaseIds()) expect(raw.includes(id), `pack mentions case id ${id}`).toBe(false);
  });

  it("with the preference flag, a clean prose page takes native-pdf Markdown; without it, the text layer", () => {
    const catalog = testCatalog();
    const estimator = createPolicyEstimator(pack);
    const page = makePage({ pageNumber: 1 });
    const answers = {
      probabilities: { plain_ocr_sufficient: 0.97, needs_math_extraction: 0.02, needs_table_structure: 0.03 },
      choices: {},
      source: { decisionModel: "cloudflare/clef-flash", format: "named-images" as const, pagesPerCall: 8, tilePx: 384 },
    };
    const probs = calibrateAnswers(indexCalibrations(pack), answers as never);
    const needs = [{ ...needsFromDecisions(page, answers as never, probs), pTrustTextLayer: 0.97 }];
    const plan = (preferNativeMarkdown: boolean) =>
      planPages({ needs, pages: [page], catalog, objective: "cost-quality", estimator, config: { preferNativeMarkdown } }).planned[0]!.assignment;
    expect(plan(false)).toMatchObject({ role: "accept-text", targetId: "native:accept-text-layer" });
    expect(plan(true)).toMatchObject({ role: "extract-text", targetId: NATIVE_PDF_MARKDOWN_TARGET_ID });
  });
});
