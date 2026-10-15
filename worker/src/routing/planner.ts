import {
  NATIVE_PDF_MARKDOWN_TARGET_ID,
  ROUTE_PLAN_SCHEMA_VERSION,
  isProhibitedRoutingModelId,
  type Assignment,
  type AssignmentRole,
  type AssignmentScope,
  type DecisionAnswers,
  type DecisionModelCall,
  type ImageKind,
  type PageAttention,
  type PageInput,
  type RoutePlan,
  type RouteRejectionReason,
  type RouterKind,
  type RoutingBudget,
  type RoutingMode,
  type RoutingObjective,
  type RoutingTarget,
  type VerifierTrigger,
} from "@docslurp/shared";
import { assessAttention } from "./attention.js";
import { readRoutingFlags } from "./flags.js";
import { freeTrustVerdict } from "./trust.js";
import {
  applyBudgetGuard,
  estimateChunk,
  type Alternative,
  type GuardResult,
  type PlannedAssignment,
} from "./estimate.js";
import {
  dimensionForRole,
  type CalibratedProbabilities,
  type ScoredEstimate,
  type TargetEstimator,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Planner: per-page needs (decisions) -> RoutePlan@v2.
// Pure and synchronous (no I/O) so it can be benchmarked and replayed.
// ---------------------------------------------------------------------------

export const NATIVE_ACCEPT_TARGET_ID = "native:accept-text-layer";
export const SKIP_TARGET_ID = "skip";

export interface ImageNeed {
  index: number;
  kind: ImageKind;
  confidence: number;
  coverage: number;
  bbox: PageInput["images"][number]["bbox"];
}

/** What a page needs, independent of how it was decided. */
export interface PageNeeds {
  pageNumber: number;
  /** P(native text layer is a faithful transcription) — first decision per page. */
  pTrustTextLayer: number;
  pNeedsMath: number;
  pNeedsTables: number;
  /** P(page is an image of text and needs OCR rather than a text layer). */
  pScanned: number;
  images: ImageNeed[];
  source: "decision-model" | "features" | "heuristic";
  /** Calibrated decision probabilities handed to the estimator. */
  probs: CalibratedProbabilities;
}

export interface PlannerConfig {
  /** Pass floor applied to the pessimistic lower bound. */
  passFloor: number;
  /** Lower floors for enrichment roles whose failure is cheap (captions). */
  floorByRole: Partial<Record<AssignmentRole, number>>;
  /** trust_text_layer >= this means "high": accept the native text layer. */
  trustThreshold: number;
  needThreshold: number;
  /** cost-speed: per-assignment cost cap (USD). */
  costCapPerAssignmentUsd: number;
  /** Add a cascade leg when the primary's pPass is below this. */
  cascadeBelow: number;
  verifierEnabled: boolean;
  /** Targets with these privacy classes are rejected (e.g. ["hosted"] for local-only). */
  disallowedPrivacy: ReadonlySet<string>;
  concurrency: number;
  /** Images covering less than this are treated as decorative/logo by the free fallback. */
  tinyImageCoverage: number;
  /**
   * Flag-gated: for accept-text pages, prefer real per-page Markdown from the native-pdf engine
   * (`native:pdf-markdown`) over the canonical document's page slice when the pack maps that target
   * and its lower bound clears the floor. The assignment is emitted as `extract-text` so the stage
   * runs the executor and replaces the slice. Off by default; env PAGE_ROUTER_PREFER_NATIVE_MARKDOWN.
   */
  preferNativeMarkdown: boolean;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  passFloor: 0.8,
  floorByRole: { "image-label": 0.6 },
  trustThreshold: 0.7,
  needThreshold: 0.5,
  costCapPerAssignmentUsd: 0.002,
  cascadeBelow: 0.95,
  verifierEnabled: false,
  disallowedPrivacy: new Set(),
  concurrency: 4,
  tinyImageCoverage: 0.02,
  preferNativeMarkdown: false,
};

/** True when PAGE_ROUTER_PREFER_NATIVE_MARKDOWN is 1/true (flags.ts). */
export function preferNativeMarkdownFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return readRoutingFlags(env).preferNativeMarkdown;
}

// ---- Needs derivation -----------------------------------------------------

/** Trust ceiling for a page whose text layer is withheld from accept-text-only (below DEFAULT trustThreshold). */
export const MATH_GATED_TRUST = 0.5;

const KIND_ORDER: ImageKind[] = [
  "none",
  "decorative-photo",
  "logo",
  "chart-graph",
  "diagram",
  "table-as-image",
  "equation-image",
  "scanned-text",
  "handwriting",
];

function argmaxKind(
  probs: Partial<Record<ImageKind, number>>,
): { kind: ImageKind; p: number } {
  let best: ImageKind = "none";
  let p = -1;
  for (const k of KIND_ORDER) {
    const v = probs[k];
    if (typeof v === "number" && v > p) {
      p = v;
      best = k;
    }
  }
  return { kind: best, p: Math.max(0, p) };
}

/** Free feature-only image kind guess (no model): conservative, cheap. */
export function guessImageKind(
  page: PageInput,
  image: PageInput["images"][number],
  tiny = DEFAULT_PLANNER_CONFIG.tinyImageCoverage,
): { kind: ImageKind; confidence: number } {
  const f = page.features;
  if (image.coverage >= 0.8 && f.native.wordCount < 30) return { kind: "scanned-text", confidence: 0.6 };
  if (image.coverage < tiny) return { kind: "logo", confidence: 0.5 };
  if (f.raster.vectorDrawingCount > 20 && image.coverage < 0.5) return { kind: "chart-graph", confidence: 0.35 };
  return { kind: "decorative-photo", confidence: 0.4 };
}

/**
 * Needs from free features only (used by the baseline router and as the fallback when
 * triage did not run). Probabilities are heuristic scores, not calibrated.
 */
export function needsFromFeatures(
  page: PageInput,
  cfg: PlannerConfig = DEFAULT_PLANNER_CONFIG,
): PageNeeds {
  const { features: f, textFacts: tf } = page;
  const status = tf.textLayerStatus;
  // Free trust cascade (TL1): status -> OCR-layer agreement -> math gate. The inset gate needs a model call
  // and is applied by the decision-model router.
  const verdict = freeTrustVerdict(page);
  let trust = 0;
  if (verdict.trusted) {
    const plausibility = status === "ocr-layer" ? Math.max(f.native.plausibility, 0.9) : f.native.plausibility;
    trust = Math.min(0.95, 0.5 + 0.45 * plausibility);
  } else if (verdict.mathGated) {
    trust = Math.min(MATH_GATED_TRUST, 0.5 + 0.45 * f.native.plausibility);
  } else if (status === "suspect") trust = 0.3 * f.native.plausibility;
  if (f.native.garbled || f.native.unmappedGlyphRatio > 0.1) trust = Math.min(trust, 0.2);
  if (f.raster.fullPageImage && f.native.wordCount < 30) trust = Math.min(trust, 0.1);
  const needsMath = Math.min(1, f.native.mathGlyphRatio * 12 + (f.heuristic.route === "formula-heavy" || f.heuristic.route === "chemical-notation-heavy" ? 0.7 : 0));
  const needsTables = Math.min(1, f.native.tableRuleScore / 4 + (f.heuristic.route === "table-heavy" ? 0.6 : 0));
  const scanned = f.raster.fullPageImage && f.native.wordCount < 30 ? 0.9 : status === "absent" ? 0.6 : 0;
  const images: ImageNeed[] = page.images.map((img) => {
    const g = guessImageKind(page, img, cfg.tinyImageCoverage);
    return { index: img.index, kind: g.kind, confidence: g.confidence, coverage: img.coverage, bbox: img.bbox };
  });
  return {
    pageNumber: f.pageNumber,
    pTrustTextLayer: trust,
    pNeedsMath: needsMath,
    pNeedsTables: needsTables,
    pScanned: scanned,
    images,
    source: "features",
    probs: {},
  };
}

/**
 * Needs from calibrated decision-model answers; any missing signal falls back to the
 * free-feature value. `trust_text_layer` is the model's direct first decision; when
 * absent it is derived from text_layer_ok/native_text_faithful.
 */
export function needsFromDecisions(
  page: PageInput,
  answers: DecisionAnswers | null | undefined,
  probs: CalibratedProbabilities,
  cfg: PlannerConfig = DEFAULT_PLANNER_CONFIG,
): PageNeeds {
  const base = needsFromFeatures(page, cfg);
  if (!answers) return base;
  const faithful = probs.native_text_faithful;
  const layerOk = probs.text_layer_ok;
  const trust =
    probs.trust_text_layer ??
    (faithful !== undefined && layerOk !== undefined
      ? Math.min(faithful, layerOk)
      : (faithful ?? layerOk ?? base.pTrustTextLayer));
  const math = probs.needs_math_extraction ?? probs.has_math ?? base.pNeedsMath;
  const tables = probs.needs_table_structure ?? probs.has_table ?? base.pNeedsTables;
  const scanned =
    probs.plain_ocr_sufficient !== undefined && trust < cfg.trustThreshold
      ? Math.max(base.pScanned, probs.plain_ocr_sufficient * (1 - trust))
      : base.pScanned;
  const choices = answers.choices?.image_kind ?? [];
  const pageLevel = choices.find((c) => c.imageIndex === null);
  const images: ImageNeed[] = page.images.map((img) => {
    const own = choices.find((c) => c.imageIndex === img.index) ?? pageLevel;
    if (!own) {
      return { ...base.images.find((b) => b.index === img.index)!, };
    }
    const { kind, p } = argmaxKind(own.probabilities);
    return { index: img.index, kind, confidence: p, coverage: img.coverage, bbox: img.bbox };
  });
  return {
    pageNumber: base.pageNumber,
    pTrustTextLayer: trust,
    pNeedsMath: math,
    pNeedsTables: tables,
    pScanned: scanned,
    images,
    source: "decision-model",
    probs,
  };
}

// ---- Role derivation ------------------------------------------------------

export interface RoleRequest {
  role: AssignmentRole;
  scope: AssignmentScope;
  reason: string;
  /** Raises the pass floor for hard inputs (handwriting). */
  floorBoost?: number;
}

const fmt = (p: number) => p.toFixed(2);

const IMAGE_ROLE: Partial<Record<ImageKind, AssignmentRole>> = {
  "decorative-photo": "image-label",
  logo: "skip",
  "chart-graph": "chart-data",
  diagram: "diagram",
  "table-as-image": "table",
  "equation-image": "math",
  "scanned-text": "ocr",
  handwriting: "ocr",
};

/**
 * Turns one page's needs into the role requests the planner must satisfy:
 * - trust high and no math/table need -> accept-text (page scope)
 * - math / table need replace the text assignment (capable targets also emit text)
 * - scanned page / full-page text image -> ocr (page scope)
 * - each image routes by kind (chart->chart-data, photo->image-label, ...)
 */
export function rolesForPage(needs: PageNeeds, cfg: PlannerConfig): RoleRequest[] {
  const out: RoleRequest[] = [];
  const page: AssignmentScope = { kind: "page" };
  const needMath = needs.pNeedsMath >= cfg.needThreshold;
  const needTables = needs.pNeedsTables >= cfg.needThreshold;
  const trusted = needs.pTrustTextLayer >= cfg.trustThreshold;

  // A near-full-page scanned/handwritten image is page-level OCR, not an image region.
  const pageImage = needs.images.find(
    (i) => i.coverage >= 0.6 && (i.kind === "scanned-text" || i.kind === "handwriting"),
  );
  const scanned = !trusted && (needs.pScanned >= cfg.needThreshold || !!pageImage);

  if (needMath) {
    out.push({ role: "math", scope: page, reason: `needs_math=${fmt(needs.pNeedsMath)}` });
  }
  if (needTables) {
    out.push({ role: "table", scope: page, reason: `needs_tables=${fmt(needs.pNeedsTables)}` });
  }
  if (!needMath && !needTables) {
    if (trusted) {
      out.push({ role: "accept-text", scope: page, reason: `trust_text_layer=${fmt(needs.pTrustTextLayer)}` });
    } else if (scanned) {
      out.push({
        role: "ocr",
        scope: page,
        reason: `scanned=${fmt(needs.pScanned)} trust=${fmt(needs.pTrustTextLayer)}`,
        floorBoost: pageImage?.kind === "handwriting" ? 0.05 : 0,
      });
    } else {
      out.push({ role: "extract-text", scope: page, reason: `trust_text_layer=${fmt(needs.pTrustTextLayer)} below ${cfg.trustThreshold}` });
    }
  }

  for (const img of needs.images) {
    if (pageImage && img.index === pageImage.index) continue;
    const role = IMAGE_ROLE[img.kind];
    if (!role) continue;
    // Equation/table images are already covered by a page-level math/table need.
    if ((role === "math" && needMath) || (role === "table" && needTables)) continue;
    out.push({
      role,
      scope: { kind: "image", imageIndex: img.index, bbox: img.bbox },
      reason: `image ${img.index} kind=${img.kind}@${fmt(img.confidence)}`,
      floorBoost: img.kind === "handwriting" ? 0.05 : 0,
    });
  }
  return out;
}

// ---- Target selection -----------------------------------------------------

interface Candidate {
  target: RoutingTarget;
  est: ScoredEstimate;
  lb: number;
  p: number;
}

function cmp(...diffs: number[]): number {
  for (const d of diffs) if (d !== 0 && Number.isFinite(d)) return d;
  return 0;
}

/** Picks the primary target for an objective. Exported for tests. */
export function chooseCandidate<T extends { p: number; lb: number; costUsd: number; latencyMs: number }>(
  cands: readonly T[],
  objective: RoutingObjective,
  floor: number,
  costCapUsd: number,
): { chosen: T; metFloor: boolean } | null {
  if (cands.length === 0) return null;
  const feasible = cands.filter((c) => c.lb >= floor);
  const costFirst = (a: T, b: T) => cmp(a.costUsd - b.costUsd, b.p - a.p, a.latencyMs - b.latencyMs);
  if (objective === "quality") {
    const best = [...cands].sort((a, b) => cmp(b.p - a.p, a.costUsd - b.costUsd, a.latencyMs - b.latencyMs))[0]!;
    return { chosen: best, metFloor: best.lb >= floor };
  }
  if (feasible.length === 0) {
    // Nothing clears the floor: best-effort = highest lower bound, cheaper on ties.
    const best = [...cands].sort((a, b) => cmp(b.lb - a.lb, a.costUsd - b.costUsd))[0]!;
    return { chosen: best, metFloor: false };
  }
  if (objective === "cost-speed") {
    const capped = feasible.filter((c) => c.costUsd <= costCapUsd);
    const pool = capped.length > 0 ? capped : feasible;
    const sorted = capped.length > 0
      ? [...pool].sort((a, b) => cmp(a.latencyMs - b.latencyMs, a.costUsd - b.costUsd, b.p - a.p))
      : [...pool].sort(costFirst);
    return { chosen: sorted[0]!, metFloor: true };
  }
  return { chosen: [...feasible].sort(costFirst)[0]!, metFloor: true };
}

const TRIGGER_BY_ROLE: Record<AssignmentRole, VerifierTrigger | null> = {
  "accept-text": "native-length-ratio",
  "extract-text": "empty-output",
  ocr: "empty-output",
  math: "invalid-latex",
  table: "ragged-table",
  "table-region": "ragged-table",
  "chart-data": "empty-output",
  diagram: "empty-output",
  "image-label": null,
  skip: null,
};

const toAlt = (c: Candidate): Alternative => ({
  targetId: c.target.id,
  costUsd: c.est.expectedCostUsd,
  billedUsd: c.est.billedUsd,
  latencyMs: c.est.expectedLatencyMs,
  latencyP95Ms: c.est.latencyP95Ms,
  pPass: c.p,
  pPassLowerBound: c.lb,
});

export interface PlanPagesInput {
  needs: readonly PageNeeds[];
  pages: readonly PageInput[];
  catalog: readonly RoutingTarget[];
  objective: RoutingObjective;
  estimator: TargetEstimator;
  config?: Partial<PlannerConfig>;
}

export interface RejectedTarget {
  pageNumber: number;
  targetId: string;
  reason: RouteRejectionReason;
}

export function planPages(input: PlanPagesInput): {
  planned: PlannedAssignment[];
  rejected: RejectedTarget[];
  attention: PageAttention[];
} {
  // The env flag is the default for the preference; an explicit config value wins (tests, replays).
  const cfg: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG, preferNativeMarkdown: preferNativeMarkdownFromEnv(), ...input.config };
  const byRole = new Map<AssignmentRole, RoutingTarget[]>();
  const rejectedGlobal: Array<{ targetId: string; reason: RouteRejectionReason }> = [];
  for (const t of input.catalog) {
    if (isProhibitedRoutingModelId(t.id) || (t.ref.modelUri && isProhibitedRoutingModelId(t.ref.modelUri))) {
      rejectedGlobal.push({ targetId: t.id, reason: "prohibited-model" });
      continue;
    }
    if (cfg.disallowedPrivacy.has(t.availability.privacyClass)) {
      rejectedGlobal.push({ targetId: t.id, reason: "privacy" });
      continue;
    }
    for (const r of t.roles) {
      const arr = byRole.get(r);
      if (arr) arr.push(t);
      else byRole.set(r, [t]);
    }
  }
  const pageByNumber = new Map(input.pages.map((p) => [p.features.pageNumber, p]));
  const planned: PlannedAssignment[] = [];
  const rejected: RejectedTarget[] = [];
  const pageNumbersSeen = new Set<number>();
  const attention: PageAttention[] = [];
  const skipTarget = input.catalog.find((t) => t.id === SKIP_TARGET_ID);

  for (const needs of input.needs) {
    const page = pageByNumber.get(needs.pageNumber);
    if (!page) continue;
    const att = assessAttention(page);
    if (att.attention) attention.push(att.attention);
    if (att.skip) {
      // Locked documents: explicit needs-attention skip, never a silent empty result.
      if (skipTarget) {
        const alt: Alternative = { targetId: skipTarget.id, costUsd: 0, billedUsd: 0, latencyMs: 0, latencyP95Ms: 0, pPass: 1, pPassLowerBound: 1 };
        planned.push({
          assignment: {
            pageNumber: needs.pageNumber,
            scope: { kind: "page" },
            targetId: skipTarget.id,
            role: "skip",
            reason: att.attention!.reason,
            estimate: { costUsd: 0, latencyMs: 0, pPass: 1 },
            cascade: [],
          },
          billedUsd: 0,
          latencyP95Ms: 0,
          primary: alt,
          alternatives: [],
        });
      }
      continue;
    }
    if (!pageNumbersSeen.has(needs.pageNumber)) {
      pageNumbersSeen.add(needs.pageNumber);
      for (const r of rejectedGlobal) rejected.push({ pageNumber: needs.pageNumber, ...r });
    }
    for (const base of rolesForPage(needs, cfg)) {
      // Annotation/form text is not in the text layer: replace text-layer-only roles with a render-based one.
      let req: RoleRequest =
        att.renderNeeded && (base.role === "accept-text" || base.role === "extract-text")
          ? { ...base, role: "ocr", reason: `${base.reason}; needs-attention: form/annotation appearance requires rendering` }
          : base;
      const floor = Math.min(0.99, (cfg.floorByRole[req.role] ?? cfg.passFloor) + (req.floorBoost ?? 0));
      const dim = dimensionForRole(req.role);
      const targets = byRole.get(req.role) ?? [];
      const cands: Candidate[] = [];
      for (const target of targets) {
        const est = input.estimator({ page, role: req.role, scope: req.scope, target, probs: needs.probs });
        if (!est) {
          rejected.push({ pageNumber: needs.pageNumber, targetId: target.id, reason: "unavailable" });
          continue;
        }
        cands.push({ target, est, p: est.pPass[dim], lb: (est.pPassLowerBound ?? est.pPass)[dim] });
      }
      // Flag-gated preference: accept-text pages take native-pdf Markdown instead of the canonical slice.
      let preferred: Candidate | undefined;
      if (cfg.preferNativeMarkdown && req.role === "accept-text") {
        const md = input.catalog.find((t) => t.id === NATIVE_PDF_MARKDOWN_TARGET_ID && !cfg.disallowedPrivacy.has(t.availability.privacyClass));
        const est = md ? input.estimator({ page, role: "extract-text", scope: req.scope, target: md, probs: needs.probs }) : null;
        if (md && est) {
          const mdCand: Candidate = { target: md, est, p: est.pPass[dim], lb: (est.pPassLowerBound ?? est.pPass)[dim] };
          if (mdCand.lb >= floor) {
            cands.push(mdCand);
            preferred = mdCand;
            req = { ...req, role: "extract-text", reason: `${req.reason}; native-pdf markdown preferred over page slice` };
          }
        }
      }
      // Escalation-only targets (Sonnet 5.5) stay cascade-leg candidates and never become the primary.
      const primaryCands = cands.filter((c) => !c.target.escalationOnly);
      const pick = preferred
        ? { chosen: { c: preferred, p: preferred.p, lb: preferred.lb, costUsd: preferred.est.expectedCostUsd, latencyMs: preferred.est.expectedLatencyMs }, metFloor: true }
        : chooseCandidate(
        primaryCands.map((c) => ({ c, p: c.p, lb: c.lb, costUsd: c.est.expectedCostUsd, latencyMs: c.est.expectedLatencyMs })),
        input.objective,
        floor,
        cfg.costCapPerAssignmentUsd,
      );
      if (!pick) {
        rejected.push({ pageNumber: needs.pageNumber, targetId: `role:${req.role}`, reason: "capability" });
        continue;
      }
      const primary = pick.chosen.c;
      const alts = cands.map(toAlt);
      const primaryAlt = toAlt(primary);

      // At most one cascade: cheapest strictly-better candidate that clears the floor
      // (else the best-pPass one), only when the primary is not already near-certain.
      let cascade: Candidate | undefined;
      const trigger = TRIGGER_BY_ROLE[req.role];
      if (trigger && !preferred && primary.p < cfg.cascadeBelow && req.role !== "skip") {
        const better = cands.filter((c) => c !== primary && c.p > primary.p + 0.02);
        const ok = better.filter((c) => c.lb >= floor).sort((a, b) => a.est.expectedCostUsd - b.est.expectedCostUsd);
        cascade = ok[0] ?? better.sort((a, b) => b.p - a.p || a.est.expectedCostUsd - b.est.expectedCostUsd)[0];
      }
      const pEsc = cascade ? 1 - primary.p : 0;
      const cascadeAlt = cascade ? toAlt(cascade) : undefined;
      const pPass = cascade ? primary.p + (1 - primary.p) * cascade.p : primary.p;
      const costUsd = primaryAlt.costUsd + pEsc * (cascadeAlt?.costUsd ?? 0);
      const billedUsd = primaryAlt.billedUsd + pEsc * (cascadeAlt?.billedUsd ?? 0);
      const latencyMs = primaryAlt.latencyMs + pEsc * (cascadeAlt?.latencyMs ?? 0);
      const latencyP95Ms = primaryAlt.latencyP95Ms + (cascadeAlt?.latencyP95Ms ?? 0) * (pEsc > 0.05 ? 1 : pEsc * 4);

      const assignment: Assignment = {
        pageNumber: needs.pageNumber,
        scope: req.scope,
        targetId: primary.target.id,
        role: req.role,
        reason: `${req.reason}; ${input.objective}${pick.metFloor ? "" : " (no target clears floor; best effort)"} lb=${fmt(primary.lb)}`,
        estimate: { costUsd, latencyMs, pPass },
        cascade: cascade && trigger ? [{ targetId: cascade.target.id, trigger: cfg.verifierEnabled && (req.role === "chart-data" || req.role === "diagram") ? "decision-model-verifier" : trigger }] : [],
      };
      planned.push({
        assignment,
        billedUsd,
        latencyP95Ms,
        primary: primaryAlt,
        alternatives: alts,
        cascade: cascadeAlt,
      });
    }
  }
  return { planned, rejected, attention };
}

// ---- Plan assembly --------------------------------------------------------

export interface AssemblePlanInput {
  documentId: string;
  runId: string;
  routerId: string;
  routerKind: RouterKind;
  mode?: RoutingMode;
  objective: RoutingObjective;
  policyVersion: string;
  planned: PlannedAssignment[];
  rejected?: RejectedTarget[];
  /** From planPages / attentionForPages: pages with unusual features (H9). */
  attention?: PageAttention[];
  budget: RoutingBudget;
  decisionModelCalls?: DecisionModelCall[];
  triage?: Partial<RoutePlan["triage"]>;
  verifier?: Partial<RoutePlan["verifier"]>;
  routerCost?: { costUsd: number; billedUsd: number; latencyMs?: number };
  catalog: readonly RoutingTarget[];
  concurrency?: number;
}

/** Applies the budget guard and builds the final RoutePlan (plus guard details). */
export function assemblePlan(input: AssemblePlanInput): { plan: RoutePlan; guard: GuardResult } {
  const router = input.routerCost ?? { costUsd: 0, billedUsd: 0 };
  const skipAvailable = input.catalog.some((t) => t.id === SKIP_TARGET_ID);
  const guard = applyBudgetGuard(input.planned, router, input.budget, skipAvailable);
  const chunk = estimateChunk(
    guard.planned,
    router,
    input.budget,
    guard.actions.map((a) => a.action),
    input.concurrency ?? DEFAULT_PLANNER_CONFIG.concurrency,
  );
  const { billedUsd: _b, margin: _m, ...chunkEstimate } = chunk;
  const rejected: RoutePlan["rejected"] = [...(input.rejected ?? [])];
  for (const d of guard.deferred) {
    rejected.push({ pageNumber: d.assignment.pageNumber, targetId: d.assignment.targetId, reason: "budget" });
  }
  const triageCost = input.triage?.costUsd ?? (input.decisionModelCalls ?? []).filter((c) => c.stage === "triage").reduce((s, c) => s + c.costUsd, 0);
  const plan: RoutePlan = {
    schemaVersion: ROUTE_PLAN_SCHEMA_VERSION,
    documentId: input.documentId,
    runId: input.runId,
    routerId: input.routerId,
    routerKind: input.routerKind,
    mode: input.mode ?? "shadow",
    objective: input.objective,
    policyVersion: input.policyVersion,
    assignments: guard.planned.map((p) => p.assignment),
    rejected,
    decisionModelCalls: input.decisionModelCalls ?? [],
    attention: input.attention ?? [],
    triage: {
      ran: false,
      decisionModel: null,
      format: null,
      pagesPerCall: null,
      costUsd: triageCost,
      ...input.triage,
    },
    verifier: { decisionModel: null, calls: 0, escalations: 0, costUsd: 0, ...input.verifier },
    chunkEstimate,
  };
  return { plan, guard };
}
