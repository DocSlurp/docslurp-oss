import { readFileSync } from "node:fs";
import type { PageInput, PolicyPack, RoutePlan, Router, RoutingBudget, RoutingObjective, RoutingTarget } from "@docslurp/shared";
import { DEFAULT_PLANNER_CONFIG as DEFAULTS, assemblePlan, needsFromFeatures, planPages, type PageNeeds, type PlannerConfig } from "../planner.js";
import { routingAssetPath } from "../runtime.js";
import { createBaselineEstimator } from "./baseline.js";

// Zero-cost free-feature router (page-router-free-v1). Every signal is a field the in-process probe already puts on
// PageInput; no model call, no extra parsing. Pages without an ok text layer need pixels. Pages with an ok layer
// escalate only when ruled-table or math evidence says the layer loses structure; the document's other pages lower
// the math bar (a page with a few math glyphs in a math-dense document is a math page).
// Fit and replay: DocSlurp/app scripts/page-router/free_features.py (mirrors freeFeatureScores exactly).

export const FREE_FEATURE_PACK = "page-router-free-v1.json";

export interface FreeFeatureThresholds {
  tableRuleScoreMin: number;
  mathGlyphRatioMin: number;
  vectorPathsPerWordMin: number;
  scanMaxWords: number;
  docMathGlyphRatioMin: number;
  docMathPageGlyphRatioMin: number;
}

export interface FreeFeaturePack {
  schemaVersion: "free-feature-router@v1";
  policyVersion: string;
  thresholds: FreeFeatureThresholds;
}

export function parseFreeFeaturePack(raw: unknown): FreeFeaturePack {
  const p = raw as Partial<FreeFeaturePack> | null;
  if (p?.schemaVersion !== "free-feature-router@v1" || typeof p.policyVersion !== "string" || !p.thresholds) {
    throw new Error("invalid free-feature router pack");
  }
  for (const k of ["tableRuleScoreMin", "mathGlyphRatioMin", "vectorPathsPerWordMin", "scanMaxWords", "docMathGlyphRatioMin", "docMathPageGlyphRatioMin"] as const) {
    const v = p.thresholds[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`invalid free-feature threshold ${k}`);
  }
  return p as FreeFeaturePack;
}

let cached: FreeFeaturePack | null = null;
export function loadFreeFeaturePack(): FreeFeaturePack {
  if (cached) return cached;
  const file = routingAssetPath(FREE_FEATURE_PACK);
  if (!file) throw new Error(`page router policy pack not found (${FREE_FEATURE_PACK})`);
  cached = parseFreeFeaturePack(JSON.parse(readFileSync(file, "utf8")));
  return cached;
}

export interface FreeFeatureScores {
  /** >= 0.5: the page is an image of content (no usable text layer). */
  scanned: number;
  needsTables: number;
  needsMath: number;
  /** True when the ok text layer is accepted as the page's Markdown source. */
  accept: boolean;
}

export interface DocumentContext {
  maxMathGlyphRatio: number;
}

export function documentContext(pages: PageInput[]): DocumentContext {
  return { maxMathGlyphRatio: Math.max(0, ...pages.map((p) => p.features.native.mathGlyphRatio)) };
}

export function freeFeatureScores(page: PageInput, doc: DocumentContext, th: FreeFeatureThresholds): FreeFeatureScores {
  const f = page.features;
  const status = page.textFacts.textLayerStatus;
  const ok = status === "ok";
  const words = f.native.wordCount;
  const scanned = (!ok && status !== "ocr-layer" && status !== "suspect") || (f.raster.fullPageImage && words < th.scanMaxWords);
  const needsTables = Math.min(1, f.native.tableRuleScore / (2 * th.tableRuleScoreMin));
  let glyph = f.native.mathGlyphRatio / (2 * th.mathGlyphRatioMin);
  if (doc.maxMathGlyphRatio >= th.docMathGlyphRatioMin) glyph = Math.max(glyph, f.native.mathGlyphRatio / (2 * th.docMathPageGlyphRatioMin));
  // Formulas drawn as vector paths (no glyphs): many paths per word of text.
  const vector = words > 0 ? f.raster.vectorDrawingCount / words / (2 * th.vectorPathsPerWordMin) : 0;
  const needsMath = Math.min(1, Math.max(glyph, vector));
  return {
    scanned: scanned ? 0.9 : ok ? 0 : 0.6,
    needsTables,
    needsMath,
    accept: ok && !scanned && needsTables < 0.5 && needsMath < 0.5,
  };
}

/** PageNeeds from free features: the base needs (blank, images) with this router's four questions. */
export function freeFeatureNeeds(pages: PageInput[], pack: FreeFeaturePack, cfg: PlannerConfig = DEFAULTS): PageNeeds[] {
  const doc = documentContext(pages);
  return pages.map((page) => {
    const base = needsFromFeatures(page, cfg);
    const s = freeFeatureScores(page, doc, pack.thresholds);
    return {
      ...base,
      pTrustTextLayer: s.accept ? 0.95 : Math.min(base.pTrustTextLayer, 0.3),
      pNeedsMath: s.needsMath,
      pNeedsTables: s.needsTables,
      pScanned: s.scanned,
      source: "features",
    };
  });
}

export interface FreeFeatureRouterOptions {
  /** Target estimates (Beta cells / priors); the free router only decides what each page needs. */
  pack: PolicyPack;
  freePack?: FreeFeaturePack;
  documentId?: string;
  runId?: string;
  config?: Partial<PlannerConfig>;
}

export class FreeFeatureRouter implements Router {
  readonly kind = "baseline" as const;
  readonly id: string;
  private readonly freePack: FreeFeaturePack;
  constructor(private readonly opts: FreeFeatureRouterOptions) {
    this.freePack = opts.freePack ?? loadFreeFeaturePack();
    this.id = `baseline:free-features:${this.freePack.policyVersion}`;
  }

  async plan(pages: PageInput[], catalog: RoutingTarget[], budget: RoutingBudget, objective: RoutingObjective): Promise<RoutePlan> {
    const cfg = { ...DEFAULTS, ...this.opts.config } as PlannerConfig;
    const needs = freeFeatureNeeds(pages, this.freePack, cfg);
    const { planned, rejected, attention } = planPages({
      needs, pages, catalog, objective, estimator: createBaselineEstimator(this.opts.pack), config: this.opts.config,
    });
    return assemblePlan({
      documentId: this.opts.documentId ?? "unknown-document",
      runId: this.opts.runId ?? "unknown-run",
      routerId: this.id,
      routerKind: this.kind,
      objective,
      policyVersion: `${this.opts.pack.metadata.policyVersion}+${this.freePack.policyVersion}`,
      planned,
      rejected,
      attention,
      budget,
      catalog,
    }).plan;
  }
}
