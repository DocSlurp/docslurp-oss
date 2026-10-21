import {
  classifyAdaptivePage,
} from "../../stages/classify-route.js";
import type {
  AdaptivePageRoute,
  Assignment,
  AssignmentRole,
  PageAttention,
  PageInput,
  Router,
  RoutePlan,
  RoutingBudget,
  RoutingObjective,
  RoutingTarget,
} from "@docslurp/shared";
import { estimateTargetCost, type PlannedAssignment, type Alternative } from "../estimate.js";
import { attentionForPages, assessAttention } from "../attention.js";
import { assemblePlan, NATIVE_ACCEPT_TARGET_ID } from "../planner.js";

// Wraps the existing classify-route heuristics in the universal Router interface.
// classify-route decides only which pages get vision rescue (hint "vision-rescue");
// everything else keeps the native text layer. Targets are fixed, not objective-driven:
// that is the behaviour being compared against.

/** Prior pass rates for the legacy behaviour (no calibration data exists for it). */
const PRIOR_P = { native: 0.85, vision: 0.85 };

export interface HeuristicRouterOptions {
  id?: string;
  /** Optional page text lookup: when given, classify-route's text classifier is re-run. */
  pageText?: (page: PageInput) => string | undefined;
  documentId?: string;
  runId?: string;
}

export function heuristicWantsVision(route: AdaptivePageRoute, hint: string | null): boolean {
  return hint === "vision-rescue" || route === "handwriting-or-degraded";
}

/** Cheapest hosted/private VLM that can extract text (what vision-extract defaults toward). */
export function pickVisionTarget(catalog: readonly RoutingTarget[]): RoutingTarget | undefined {
  const scope = { kind: "page" } as const;
  return catalog
    .filter((t) => (t.kind === "hosted-vlm" || t.kind === "private-vlm") && t.roles.includes("extract-text"))
    .map((t) => ({ t, c: estimateTargetCost(t, "extract-text", scope).costUsd }))
    .sort((a, b) => a.c - b.c)[0]?.t;
}

/** Cheapest local OCR target: the render-based fallback when no VLM is configured. */
export function pickOcrTarget(catalog: readonly RoutingTarget[]): RoutingTarget | undefined {
  const scope = { kind: "page" } as const;
  return catalog
    .filter((t) => t.kind === "local-ocr" && t.roles.includes("ocr"))
    .map((t) => ({ t, c: estimateTargetCost(t, "ocr", scope).costUsd }))
    .sort((a, b) => a.c - b.c)[0]?.t;
}

export class HeuristicRouter implements Router {
  readonly kind = "heuristic" as const;
  readonly id: string;
  constructor(private readonly opts: HeuristicRouterOptions = {}) {
    this.id = opts.id ?? "heuristic:classify-route";
  }

  async plan(
    pages: PageInput[],
    catalog: RoutingTarget[],
    budget: RoutingBudget,
    objective: RoutingObjective,
  ): Promise<RoutePlan> {
    const vision = pickVisionTarget(catalog);
    const ocr = vision ? undefined : pickOcrTarget(catalog);
    const nativeTarget = catalog.find((t) => t.id === NATIVE_ACCEPT_TARGET_ID);
    const planned: PlannedAssignment[] = [];
    const unresolved: PageAttention[] = [];
    const scope = { kind: "page" } as const;
    for (const page of pages) {
      if (assessAttention(page).skip) continue; // locked: reported in plan.attention
      const text = this.opts.pageText?.(page);
      const entry = text !== undefined ? classifyAdaptivePage(page.features.pageNumber, text) : undefined;
      const route = entry?.route ?? page.features.heuristic.route;
      const hint = entry?.extractorHint ?? page.features.heuristic.extractorHint;
      const wantsPixels = heuristicWantsVision(route, hint);
      // Missing render capability must not read as "the text layer is fine": use OCR, or flag the gap.
      const [target, role]: [RoutingTarget | undefined, AssignmentRole] = !wantsPixels
        ? [nativeTarget, "accept-text"]
        : vision ? [vision, "extract-text"] : ocr ? [ocr, "ocr"] : [nativeTarget, "accept-text"];
      if (!target) continue;
      const useVision = role !== "accept-text";
      const visionUnavailable = wantsPixels && !useVision;
      if (visionUnavailable) {
        unresolved.push({ pageNumber: page.features.pageNumber, outcome: "flagged", features: ["vision-target-unavailable"],
          reason: "needs-attention: page needs a rendering target but none is configured; native text layer accepted as-is" });
      }
      const c = estimateTargetCost(target, role, scope, page);
      const p = useVision ? PRIOR_P.vision : PRIOR_P.native;
      const alt: Alternative = {
        targetId: target.id,
        costUsd: c.costUsd,
        billedUsd: c.billedUsd,
        latencyMs: c.latencyP50Ms,
        latencyP95Ms: c.latencyP95Ms,
        pPass: p,
        pPassLowerBound: p,
      };
      const assignment: Assignment = {
        pageNumber: page.features.pageNumber,
        scope,
        targetId: target.id,
        role,
        reason: `classify-route route=${route} hint=${hint ?? "none"}${visionUnavailable ? "; vision-unavailable" : ""}`,
        estimate: { costUsd: c.costUsd, latencyMs: c.latencyP50Ms, pPass: p },
        cascade: [],
      };
      planned.push({ assignment, billedUsd: c.billedUsd, latencyP95Ms: c.latencyP95Ms, primary: alt, alternatives: [] });
    }
    return assemblePlan({
      documentId: this.opts.documentId ?? "unknown-document",
      runId: this.opts.runId ?? "unknown-run",
      routerId: this.id,
      routerKind: this.kind,
      objective,
      policyVersion: "heuristic:classify-route",
      planned,
      attention: [...attentionForPages(pages), ...unresolved],
      budget,
      catalog,
    }).plan;
  }
}
