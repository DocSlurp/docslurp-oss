/**
 * One document's chart export: collects candidates from every free signal, runs the ladder for the visuals the
 * project asked for, and keeps the exported visuals for Markdown, `charts[]` and the candidate stats. The stage
 * (`stages/vision-extract.ts`) owns rasters, artifacts and the model client; this class owns the decisions.
 */
import {
  mediaMapSchema,
  type Assignment,
  type AssignmentRole,
  type BBox,
  type ChartExportConfig,
  type ExportedVisual,
  type RoutePlan,
  type RoutingTarget,
  type VisualCandidateStats,
  visualSpecSchema,
} from "@docslurp/shared";

import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { budgetGuardDowngraded, budgetGuardSkippedRole } from "../routing/estimate.js";
import type { ChartExportAttempt } from "./billing.js";
import {
  DETERMINISTIC_HIGH_CONFIDENCE,
  formatsFor,
  MAX_GENERATOR_CALLS_PER_DOCUMENT,
  MAX_GENERATOR_CALLS_PER_RUN,
  MAX_LEGACY_PAGE_EXPORTS_PER_DOCUMENT,
  MAX_MODEL_READS_PER_DOCUMENT,
  MAX_VISUALS_PER_DOCUMENT,
} from "./config.js";
import { exportVisual } from "./generator.js";
import { newVisualMarkerNonce, visualBody, wrapVisualGroup } from "./markdown.js";
import { selectGeneratorModel, type GeneratorSelection } from "./model-selection.js";
import { buildVisualCandidateStats } from "./stats.js";
import type {
  ChartExportCallRecord,
  ChartModelClient,
  DeterministicVisualPartial,
  DeterministicVisualResult,
  VisualCandidate,
  VisualImage,
  VisualKind,
} from "./types.js";

export interface ChartExportSessionInput {
  documentId: string;
  config: ChartExportConfig;
  /** Privacy-filtered admitted routing catalog (lazy: only built when a model rung is reached). */
  catalog: () => readonly RoutingTarget[];
  envModel?: string | null;
  client: ChartModelClient | null;
  recordUsage: (input: WorkerAiUsageInput) => void;
  canCallModel?: () => boolean;
  /** Caps (defaults: the shared chart export limits). */
  limits?: Partial<ChartExportLimits>;
  /** Generator calls across the run's documents; shared so the per-run cap holds. */
  runBudget?: ChartExportRunBudget;
  /**
   * Called once a candidate's model work is done when the provider answered at least one of its calls (exported or
   * not): the stage charges it right away, so the cost cap and credit lease see the spend within the document.
   */
  onModelRead?: (attempt: ChartExportAttempt) => void;
  /** This export's visual marker nonce (default: fresh random); tests pin it. */
  markerNonce?: string;
}

export interface RoutedExportResult {
  /** Insert body (the merge adds the `**Chart data (image N)**` heading). */
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  latencyMs: number;
}

const ROLE_KIND: Partial<Record<AssignmentRole, VisualKind>> = { "chart-data": "chart", diagram: "diagram" };

export function candidateFromAssignment(assignment: Pick<Assignment, "role" | "scope" | "pageNumber">, index: number): VisualCandidate | null {
  const kind = ROLE_KIND[assignment.role];
  if (!kind) return null;
  const scope = assignment.scope;
  const imageIndex = scope.kind === "image" ? scope.imageIndex : null;
  const bbox = scope.kind === "region" ? scope.bbox : scope.kind === "image" ? scope.bbox ?? null : null;
  return {
    id: imageIndex !== null ? `p${assignment.pageNumber}-i${imageIndex}` : `p${assignment.pageNumber}-a${index}`,
    pageNumber: assignment.pageNumber,
    imageIndex,
    bbox,
    kind,
    detectedBy: scope.kind === "image" ? "router-inset" : "router-region",
  };
}

/**
 * Router chart/diagram labels in a stored plan. Roles the budget guard downgraded to a cheaper target are left out
 * (its skips are already `skip` roles): the end pass never overrides the planner's budget with a generator call, and
 * the estimate's stats do not count them.
 */
export function candidatesFromPlan(plan: Pick<RoutePlan, "assignments"> | null | undefined): VisualCandidate[] {
  if (!plan) return [];
  return plan.assignments
    .map((a, i) => (budgetGuardDowngraded(a) ? null : candidateFromAssignment(a, i)))
    .filter((c): c is VisualCandidate => c !== null);
}

/**
 * Chart and diagram scopes the budget guard downgraded to a cheaper target or skipped. The end pass spends no generator
 * call on them, whichever signal (router, image routing, a placement) lists the same picture: `addGuardedScopes`.
 */
export function guardedScopesFromPlan(plan: Pick<RoutePlan, "assignments"> | null | undefined): VisualCandidate[] {
  if (!plan) return [];
  return plan.assignments.flatMap((a, i) => {
    const skipped = budgetGuardSkippedRole(a);
    const role = skipped ?? (budgetGuardDowngraded(a) ? a.role : null);
    const scope = role ? candidateFromAssignment({ ...a, role }, i) : null;
    return scope ? [scope] : [];
  });
}

/** Legacy classifier pages routed `chart-or-figure` (kind unknown: the page may hold a chart or a diagram). */
export function candidatesFromLegacyRoutes(pages: ReadonlyArray<{ pageNumber: number; route?: string | null }>): VisualCandidate[] {
  return pages
    .filter((page) => page.route === "chart-or-figure")
    .map((page) => ({ id: `p${page.pageNumber}-page`, pageNumber: page.pageNumber, imageIndex: null, bbox: null, kind: null, detectedBy: "legacy-page-route" as const }));
}

/** Embedded images image routing classed `chart-diagram` (media map, PDF sources), with their page placement. */
export function candidatesFromMediaMap(map: unknown): VisualCandidate[] {
  const parsed = mediaMapSchema.safeParse(map);
  if (!parsed.success) return [];
  return parsed.data.images
    .filter((image) => image.class.label === "chart-diagram")
    .map((image) => ({
      id: `p${image.pageNumber}-o${image.occurrence}`,
      pageNumber: image.pageNumber,
      imageIndex: null,
      occurrence: image.occurrence,
      // Media-map placements are [x0, y0, x1, y1] in page points, top-left origin (the router's space).
      bbox: image.placement.status === "known"
        ? { x: image.placement.bbox[0], y: image.placement.bbox[1], width: image.placement.bbox[2] - image.placement.bbox[0], height: image.placement.bbox[3] - image.placement.bbox[1] }
        : null,
      kind: null,
      detectedBy: "image-routing" as const,
    }));
}

function iou(a: BBox, b: BBox): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = x * y;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Whether two candidates are the same picture: the same id, overlapping placements, or (without placements) the same
 * page-local image index (a router image index or an image-routing occurrence).
 */
export function sameVisual(a: VisualCandidate, b: VisualCandidate): boolean {
  if (a.pageNumber !== b.pageNumber) return false;
  if (a.id === b.id) return true;
  if (a.bbox && b.bbox) return iou(a.bbox, b.bbox) >= 0.5;
  const ai = a.imageIndex ?? a.occurrence ?? null;
  const bi = b.imageIndex ?? b.occurrence ?? null;
  return ai !== null && bi !== null && ai === bi;
}

/** A page-level candidate (a legacy keyword route): no image and no region. */
export function isPageLevel(candidate: VisualCandidate): boolean {
  return candidate.detectedBy === "legacy-page-route";
}

function kindsCompatible(candidate: VisualCandidate, partial: DeterministicVisualPartial): boolean {
  const kind = partial.kind ?? partial.spec?.kind ?? null;
  return candidate.kind === null || kind === null || candidate.kind === kind;
}

/** A candidate and a partial with placements are the same visual when their boxes overlap this much (IoU)... */
export const PARTIAL_PAIR_MIN_IOU = 0.5;
/**
 * ...or when this share of the smaller box lies inside the other (a crop that includes the caption or axis padding),
 * provided the boxes are of comparable size (`PARTIAL_PAIR_MIN_AREA_RATIO`): a small figure inside a large region is
 * one visual among others there, not the region's visual.
 */
export const PARTIAL_PAIR_MIN_CONTAINMENT = 0.8;
/** Smaller area over larger area at or above which containment alone may pair two placements. */
export const PARTIAL_PAIR_MIN_AREA_RATIO = 0.5;

function containment(a: BBox, b: BBox): number {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (x * y) / smaller : 0;
}

function areaRatio(a: BBox, b: BBox): number {
  const areaA = a.width * a.height;
  const areaB = b.width * b.height;
  const larger = Math.max(areaA, areaB);
  return larger > 0 ? Math.min(areaA, areaB) / larger : 0;
}

/**
 * How well two placements match (0 when they are not the same visual): IoU at or above `PARTIAL_PAIR_MIN_IOU`, or
 * containment at or above `PARTIAL_PAIR_MIN_CONTAINMENT` between boxes of comparable area; the larger of the two scores.
 */
export function placementMatch(a: BBox, b: BBox): number {
  const overlap = iou(a, b);
  const contained = areaRatio(a, b) >= PARTIAL_PAIR_MIN_AREA_RATIO ? containment(a, b) : 0;
  return overlap >= PARTIAL_PAIR_MIN_IOU || contained >= PARTIAL_PAIR_MIN_CONTAINMENT ? Math.max(overlap, contained) : 0;
}

/**
 * Whether a partial could be this candidate's visual: same page, compatible kind, no conflicting image index, and,
 * when both have placements, matching ones. A partial without a page (Office chart parts) never pairs: it is exported
 * on its own rather than given to whichever candidate sits on page 1. A raster image found by image routing is never
 * an SVG-geometry figure unless their placements match: they are different objects by construction.
 */
/** A partial whose spec is used as is (no model read): valid and at or above the high-confidence threshold. */
function confidentPartial(partial: DeterministicVisualPartial): boolean {
  return Number.isFinite(partial.confidence) && partial.confidence >= DETERMINISTIC_HIGH_CONFIDENCE
    && partial.spec !== null && visualSpecSchema.safeParse(partial.spec).success;
}

function couldPair(candidate: VisualCandidate, partial: DeterministicVisualPartial): boolean {
  if (partial.pageNumber === null || partial.pageNumber === undefined) return false;
  if (partial.pageNumber !== candidate.pageNumber || !kindsCompatible(candidate, partial)) return false;
  const index = partial.imageIndex ?? null;
  if (index !== null && candidate.imageIndex !== null && index !== candidate.imageIndex) return false;
  if (partial.bbox && candidate.bbox) return placementMatch(partial.bbox, candidate.bbox) > 0;
  if (candidate.detectedBy === "image-routing" && partial.source === "svg-geometry") return false;
  return true;
}

export interface ChartExportLimits {
  /** Exported visuals, free ones included (output size). */
  maxVisuals: number;
  /** Visuals a model reads, each charged (the estimate's per-document clamp). */
  maxModelReads: number;
  maxCallsPerDocument: number;
  maxCallsPerRun: number;
  maxPageExports: number;
}

export const DEFAULT_CHART_EXPORT_LIMITS: ChartExportLimits = {
  maxVisuals: MAX_VISUALS_PER_DOCUMENT,
  maxModelReads: MAX_MODEL_READS_PER_DOCUMENT,
  maxCallsPerDocument: MAX_GENERATOR_CALLS_PER_DOCUMENT,
  maxCallsPerRun: MAX_GENERATOR_CALLS_PER_RUN,
  maxPageExports: MAX_LEGACY_PAGE_EXPORTS_PER_DOCUMENT,
};

/** Generator calls made across a run's documents (shared by their sessions). */
export interface ChartExportRunBudget {
  calls: number;
}

export interface RoutedExportOutcome {
  /** Null when nothing was exported. */
  result: RoutedExportResult | null;
  /** The provider answered a generator call for this crop (paid): the caller must not read the crop again. */
  modelCalled: boolean;
  /** Usage of this visual's calls (also when `result` is null). */
  usage: Omit<RoutedExportResult, "text" | "model">;
}

export class ChartExportSession {
  readonly candidates: VisualCandidate[] = [];
  /** Legacy keyword pages no other signal confirmed: counted apart, never exported or priced. */
  readonly lowConfidence: VisualCandidate[] = [];
  readonly visuals: ExportedVisual[] = [];
  readonly calls: ChartExportCallRecord[] = [];
  /** Visuals already placed by the routed merge (their Markdown is in the page). */
  readonly routedIds = new Set<string>();
  /** Candidates that went through the ladder (exported or not): never tried twice. */
  readonly attempted = new Set<string>();
  /** Candidates the provider answered at least one generator call for (exported or not): each is charged once. */
  readonly modelReads = new Map<string, ChartExportAttempt>();
  private partials: DeterministicVisualPartial[] = [];
  /** Scopes the budget guard downgraded or skipped (`addGuardedScopes`). */
  private readonly guarded: VisualCandidate[] = [];
  /** Partial index -> candidate id that claimed it. */
  private readonly claims = new Map<number, string>();
  private presence: DeterministicVisualResult["presence"] = {};
  private readonly selections = new Map<string, GeneratorSelection | null>();
  private readonly limits: ChartExportLimits;
  private readonly runBudget: ChartExportRunBudget;
  private callsMade = 0;
  /** Reads started and not yet finished (concurrent routed crops): reserved against the read cap. */
  private readsInFlight = 0;
  private pageExports = 0;
  private capLogged = false;
  private readonly client: ChartModelClient | null;
  /** The nonce in this export's visual group markers (recorded in the chart-export artifact for the next reprocess). */
  readonly markerNonce: string;

  constructor(private readonly input: ChartExportSessionInput) {
    this.markerNonce = input.markerNonce ?? newVisualMarkerNonce();
    this.limits = { ...DEFAULT_CHART_EXPORT_LIMITS, ...input.limits };
    this.runBudget = input.runBudget ?? { calls: 0 };
    const inner = input.client;
    // Every generator call is counted before it is made, so caps bound attempts (failed and `none` answers too).
    this.client = inner ? {
      complete: async (request) => {
        if (!this.callBudgetLeft()) throw new Error("chart export call cap reached");
        this.callsMade += 1;
        this.runBudget.calls += 1;
        return await inner.complete(request);
      },
    } : null;
  }

  get enabled(): boolean {
    return this.input.config.enabled;
  }

  get config(): ChartExportConfig {
    return this.input.config;
  }

  /** Generator calls this document made. */
  get modelCalls(): number {
    return this.callsMade;
  }

  /** Whether the project exports this kind (diagrams are opt-out). */
  exportsKind(kind: VisualKind | null): boolean {
    return this.enabled && (kind !== "diagram" || this.input.config.diagrams);
  }

  /**
   * Scopes the budget guard priced out (`guardedScopesFromPlan`): any candidate for the same picture, listed before or
   * after, is dropped, so the end pass never re-reads with the generator what the guard cut. A page-scope guard covers
   * every picture on its page. Not counted in stats either, as the plan's own labels for them are not.
   */
  addGuardedScopes(scopes: readonly VisualCandidate[]): void {
    this.guarded.push(...scopes);
    for (let i = this.candidates.length - 1; i >= 0; i -= 1) {
      if (this.isGuarded(this.candidates[i]!)) this.candidates.splice(i, 1);
    }
  }

  private isGuarded(candidate: VisualCandidate): boolean {
    return this.guarded.some((scope) => scope.pageNumber === candidate.pageNumber
      && ((scope.imageIndex === null && scope.bbox === null) || sameVisual(scope, candidate)));
  }

  /** Adds candidates, one per picture: a later signal for a picture already listed only fills in its kind. */
  addCandidates(candidates: readonly VisualCandidate[]): void {
    for (const candidate of candidates) {
      if (this.isGuarded(candidate)) continue;
      const prior = this.candidates.find((c) => !isPageLevel(c) && !isPageLevel(candidate) ? sameVisual(c, candidate) : c.id === candidate.id);
      if (prior) {
        if (prior.kind === null && candidate.kind !== null) prior.kind = candidate.kind;
        if (!prior.bbox && candidate.bbox) prior.bbox = candidate.bbox;
        continue;
      }
      this.candidates.push({ ...candidate });
    }
  }

  /**
   * Legacy keyword pages (`chart-or-figure`) over-trigger, so they stand alone only when a non-keyword signal agrees on
   * the page (`signalPages`: Doppler figures, deterministic partials). A page another candidate already covers (router
   * label, image routing) is represented by that candidate. The rest are low-confidence: counted, never exported.
   */
  resolveLegacyPages(signalPages: ReadonlySet<number>): void {
    for (let i = this.candidates.length - 1; i >= 0; i -= 1) {
      const candidate = this.candidates[i]!;
      if (!isPageLevel(candidate)) continue;
      const covered = this.candidates.some((c) => c !== candidate && !isPageLevel(c) && c.pageNumber === candidate.pageNumber);
      if (covered) this.candidates.splice(i, 1);
      else if (!signalPages.has(candidate.pageNumber) && !this.partials.some((p) => p.pageNumber === candidate.pageNumber)) {
        this.candidates.splice(i, 1);
        this.lowConfidence.unshift(candidate);
      }
    }
  }

  setDeterministic(result: DeterministicVisualResult): void {
    this.partials = result.partials.slice(0, this.limits.maxVisuals);
    this.claims.clear();
    this.presence = result.presence ?? {};
  }

  /** Pages deterministic partials sit on (partials without a page are on no known page). */
  partialPages(): Set<number> {
    return new Set(this.partials.flatMap((p) => (typeof p.pageNumber === "number" ? [p.pageNumber] : [])));
  }

  /**
   * The deterministic partial for a candidate: one it already claimed, else (in order) an unclaimed partial with the
   * same image index, the unclaimed partial whose placement matches the candidate's best (`placementMatch`), or, when
   * neither side has a placement, the page's only possible partial provided the candidate is also the page's only
   * candidate that could match it. A placement on one side only is not a match: a placed figure and an unplaced image
   * may be different objects. The exception is a page-level candidate (a legacy keyword page), which covers the whole
   * page and so every placement on it. Anything ambiguous pairs nothing: the partial is exported on its own and the
   * candidate goes through the model, rather than giving a chart another chart's numbers.
   *
   * `wholePageRead`: the model would read the whole page. A page-level candidate then pairs only a confident partial
   * (used as is, no model read): a middling one's digest and numbers would be applied to whatever chart the model reads
   * on the page, which may be another one. `focusPageCandidate` crops to such a figure instead.
   */
  private claimPartial(candidate: VisualCandidate, wholePageRead: boolean): DeterministicVisualPartial | null {
    for (const [index, owner] of this.claims) if (owner === candidate.id) return this.partials[index] ?? null;
    const index = this.choosePartial(candidate);
    if (index === null) return null;
    const partial = this.partials[index]!;
    if (isPageLevel(candidate) && wholePageRead && !confidentPartial(partial)) return null;
    this.claims.set(index, candidate.id);
    return partial;
  }

  /** The unclaimed partial `claimPartial` would give this candidate (index), without claiming it. */
  private choosePartial(candidate: VisualCandidate): number | null {
    const open: number[] = [];
    for (let i = 0; i < this.partials.length; i += 1) {
      if (!this.claims.has(i) && couldPair(candidate, this.partials[i]!)) open.push(i);
    }
    const exact = open.find((i) => candidate.imageIndex !== null && this.partials[i]!.imageIndex === candidate.imageIndex);
    if (exact !== undefined) return exact;
    let best = -1;
    let bestIou = 0;
    for (const i of open) {
      const box = this.partials[i]!.bbox;
      const overlap = box && candidate.bbox ? placementMatch(box, candidate.bbox) : 0;
      if (overlap > bestIou) { best = i; bestIou = overlap; }
    }
    if (best >= 0) return best;
    // No index or geometry match: pair only a one-to-one page (one possible partial, one possible candidate), and only
    // when neither side is placed (or the candidate is the whole page).
    const loose = open.filter((i) => isPageLevel(candidate) || (!this.partials[i]!.bbox && !candidate.bbox));
    if (loose.length !== 1) return null;
    const partial = this.partials[loose[0]!]!;
    const owners = new Set(this.claims.values());
    const rivals = this.candidates.filter((c) => c.id !== candidate.id && !owners.has(c.id) && couldPair(c, partial));
    return rivals.length === 0 ? loose[0]! : null;
  }

  /**
   * A whole-page candidate whose figure is placed but not confident enough to use as is: the candidate takes the
   * figure's placement, so the end pass reads a crop of that figure (with its digest) instead of the whole page. The
   * caller drops the placement again when no crop can be made: the page is then read without the figure's digest and
   * the figure is exported on its own. Returns whether the placement was taken.
   */
  focusPageCandidate(candidate: VisualCandidate): boolean {
    if (!isPageLevel(candidate) || candidate.bbox || this.attempted.has(candidate.id)) return false;
    const index = this.choosePartial(candidate);
    const partial = index === null ? null : this.partials[index]!;
    if (!partial?.bbox || confidentPartial(partial)) return false;
    candidate.bbox = { ...partial.bbox };
    return true;
  }

  generator(kind: VisualKind | null): GeneratorSelection | null {
    const key = kind ?? "any";
    if (!this.selections.has(key)) {
      let selection: GeneratorSelection | null = null;
      try {
        selection = selectGeneratorModel({ kind, catalog: this.input.catalog(), projectModel: this.input.config.generatorModel, envModel: this.input.envModel ?? null });
      } catch (error) {
        console.warn(`[chart-export] generator catalog unavailable document=${this.input.documentId} error=${error instanceof Error ? error.message : String(error)}`);
      }
      if (!selection) console.warn(`[chart-export] no admitted generator model document=${this.input.documentId} kind=${key}; model rungs skipped`);
      this.selections.set(key, selection);
    }
    return this.selections.get(key) ?? null;
  }

  private callBudgetLeft(): boolean {
    const left = this.callsMade < this.limits.maxCallsPerDocument && this.runBudget.calls < this.limits.maxCallsPerRun;
    if (!left && !this.capLogged) {
      this.capLogged = true;
      console.warn(`[chart-export] generator call cap reached document=${this.input.documentId} documentCalls=${this.callsMade} runCalls=${this.runBudget.calls}`);
    }
    return left;
  }

  /** Whether another generator call may be made (caps, read cap, cost cap): the pass renders no raster otherwise. */
  modelAvailable(): boolean {
    return this.readsLeft() && this.canCallModel();
  }

  private canCallModel(): boolean {
    return this.callBudgetLeft() && (this.input.canCallModel?.() ?? true);
  }

  /**
   * Model reads left this document. Every read is charged (a read with no export too), so reads stay within the cap the
   * estimate clamps billable visuals to. Free deterministic exports do not count against it.
   */
  private readsLeft(): boolean {
    return this.modelReads.size + this.readsInFlight < this.limits.maxModelReads;
  }

  /** The output-size cap on exported visuals (free and model-read alike). */
  private atLimit(): boolean {
    return this.visuals.length >= this.limits.maxVisuals;
  }

  /** Whole-page raster exports left this document (crops are not counted). */
  pageExportsLeft(): boolean {
    return this.pageExports < this.limits.maxPageExports;
  }

  private async run(candidate: VisualCandidate, image: VisualImage | null, signal?: AbortSignal, wholePage = false): Promise<ExportedVisual | null> {
    if (!this.exportsKind(candidate.kind) || this.atLimit()) return null;
    if (this.attempted.has(candidate.id) || this.visuals.some((v) => v.id === candidate.id)) return null;
    this.attempted.add(candidate.id);
    // A confident free spec needs no image, so no model is reached and no page export is spent.
    const modelImage = image && this.readsLeft() && this.canCallModel() ? image : null;
    const partial = this.claimPartial(candidate, wholePage && modelImage !== null);
    const callsBefore = this.callsMade;
    if (modelImage) this.readsInFlight += 1;
    const result = await exportVisual({
      candidate,
      image: modelImage,
      deterministic: partial,
      config: this.input.config,
      generatorModelUri: modelImage ? this.generator(candidate.kind)?.modelUri ?? null : null,
      client: this.client,
      recordUsage: this.input.recordUsage,
      documentId: this.input.documentId,
      canCallModel: () => this.canCallModel(),
      ...(signal ? { signal } : {}),
    }).finally(() => {
      if (modelImage) this.readsInFlight -= 1;
    });
    this.calls.push(...result.calls.map((call) => ({ ...call, visualId: candidate.id })));
    if (wholePage && this.callsMade > callsBefore) this.pageExports += 1;
    const exported = !!result.visual && this.exportsKind(result.visual.kind);
    if (exported) this.visuals.push(result.visual!);
    if (result.calls.some((call) => call.responded)) {
      // Charged whatever the outcome (`none`, invalid, a diagram the project does not export): the read was paid for.
      // Priced by the candidate's kind at call time (the formats requested), never by the kind the model answered.
      const attempt: ChartExportAttempt = { id: candidate.id, pageNumber: candidate.pageNumber, kind: candidate.kind, exported };
      this.modelReads.set(candidate.id, attempt);
      this.input.onModelRead?.(attempt);
    }
    return exported ? result.visual : null;
  }

  /**
   * Routed chart/diagram insert: the generator replaces the role's vision prompt. A null result with `modelCalled`
   * false keeps the usual reading (export off, kind not exported, capped before any call); with `modelCalled` true the
   * crop was already paid for and must not be read again.
   */
  async exportRouted(args: { assignment: Pick<Assignment, "role" | "scope" | "pageNumber">; assignmentIndex: number; image: VisualImage; signal?: AbortSignal }): Promise<RoutedExportOutcome> {
    const none = { inputTokens: 0, outputTokens: 0, costCents: 0, latencyMs: 0 };
    const candidate = candidateFromAssignment(args.assignment, args.assignmentIndex);
    if (!candidate || !this.exportsKind(candidate.kind)) return { result: null, modelCalled: false, usage: none };
    this.addCandidates([candidate]);
    const listed = this.candidates.find((c) => sameVisual(c, candidate)) ?? candidate;
    const before = this.calls.length;
    const visual = await this.run(listed, args.image, args.signal);
    const made = this.calls.slice(before);
    const calls = made.filter((c) => c.ok || c.costCents > 0);
    const usage = {
      inputTokens: calls.reduce((s, c) => s + c.inputTokens, 0),
      outputTokens: calls.reduce((s, c) => s + c.outputTokens, 0),
      costCents: calls.reduce((s, c) => s + c.costCents, 0),
      latencyMs: calls.reduce((s, c) => s + c.latencyMs, 0),
    };
    // Only an answered call spends the crop's reading; a call that failed before any answer (provider error, timeout,
    // privacy refusal) falls through to the role's usual read.
    const modelCalled = made.some((c) => c.responded);
    if (!visual) return { result: null, modelCalled, usage };
    const body = wrapVisualGroup(visual.id, this.markerNonce, visualBody(visual, formatsFor(this.input.config, visual.kind)));
    if (!body) return { result: null, modelCalled, usage };
    this.routedIds.add(visual.id);
    return { result: { text: body, model: visual.model ?? "deterministic", ...usage }, modelCalled, usage };
  }

  /** A candidate with an image the stage provides (page raster or crop). `wholePage` counts against the page cap. */
  async exportWithImage(candidate: VisualCandidate, image: VisualImage | null, signal?: AbortSignal, options: { wholePage?: boolean } = {}): Promise<ExportedVisual | null> {
    return await this.run(candidate, image, signal, options.wholePage === true);
  }

  /** Candidates the end-of-stage pass still has to try (not attempted, kind exported). */
  pendingCandidates(): VisualCandidate[] {
    return this.candidates.filter((c) => !this.attempted.has(c.id) && this.exportsKind(c.kind));
  }

  /**
   * Deterministic partials no candidate claimed (Office chart parts, embedded specs, SVG figures on pages without a
   * candidate): exported from the spec alone when confident enough. Partials without a page never pair with a
   * candidate; they are exported on their own with no page (`u-d<n>`), and the stage appends them as unpaged blocks.
   */
  async exportUnmatchedDeterministic(signal?: AbortSignal): Promise<ExportedVisual[]> {
    if (!this.enabled) return [];
    const out: ExportedVisual[] = [];
    for (let i = 0; i < this.partials.length; i += 1) {
      if (this.claims.has(i) || this.atLimit()) continue;
      const partial = this.partials[i]!;
      const unpaged = typeof partial.pageNumber !== "number";
      // An unpaged candidate's page is nominal: it is never paired, rendered or read (no image is passed).
      const page = unpaged ? 1 : partial.pageNumber!;
      const candidate: VisualCandidate = {
        id: unpaged ? `u-d${i + 1}` : partial.imageIndex !== null && partial.imageIndex !== undefined ? `p${page}-i${partial.imageIndex}` : `p${page}-d${i + 1}`,
        pageNumber: page,
        ...(unpaged ? { unpaged: true } : {}),
        imageIndex: partial.imageIndex ?? null,
        bbox: partial.bbox ?? null,
        kind: partial.kind ?? partial.spec?.kind ?? null,
        detectedBy: "deterministic",
      };
      if (this.visuals.some((v) => v.id === candidate.id)) continue;
      this.claims.set(i, candidate.id);
      // No image: only the deterministic rungs can run, so no model is called.
      const visual = await this.run(candidate, null, signal);
      if (visual) out.push(visual);
    }
    return out;
  }

  stats(): VisualCandidateStats {
    return buildVisualCandidateStats({ candidates: this.candidates, presence: this.presence, exported: this.visuals });
  }
}
