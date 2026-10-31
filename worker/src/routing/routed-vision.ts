import {
  inferModelTarget,
  type Assignment,
  type PolicyPack,
  type RoutePlan,
  type RoutingTarget,
  type VerifierTrigger,
  type VisionConfig,
} from "@docslurp/shared";

import type { VisionPageOutput } from "../stages/vision-extract.js";
import { freeCascadeTrigger, isContentRefusal, type CascadeVerifier } from "./cascade.js";
import { rankRefusalFallbacks, vendorOfTarget } from "./refusal-fallback.js";
import { executeAssignments, type ExecutorFailure } from "./executors/run.js";
import { mergePageText } from "./executors/merge.js";
import type { ExecutorDeps, ExecutorOutput } from "./executors/types.js";
import { scoreOutputQuality } from "./quality.js";
import type { RoutedExecution, RoutedPageActual, RoutedPageQuality } from "./runtime.js";

/** What one vision call returned, plus the priced usage event cost per page when one was recorded. */
export interface RoutedExtractResult {
  outputs: VisionPageOutput[];
  /** Cents from the usage ledger event recorded for each page call. */
  costCentsByPage: ReadonlyMap<number, number>;
}

export interface RoutedExtractOptions {
  /** Ignore fan-out results already cached for these pages (escalation legs re-run the page). */
  bypassCache?: boolean;
}

export interface RoutedVisionArgs {
  plan: RoutePlan;
  execution: RoutedExecution;
  catalog: readonly RoutingTarget[];
  /** Workspace vision config: the model for fallback pages and the base of every group's config. */
  selection: VisionConfig;
  extract: (vision: VisionConfig, pages: number[], options?: RoutedExtractOptions) => Promise<RoutedExtractResult>;
  /** Privacy gate for a group's vision config (false skips the group). */
  allow: (vision: VisionConfig) => Promise<boolean>;
  /** False once the run's cost cap is reached: remaining groups and escalations are skipped. */
  canContinue: () => boolean;
  /**
   * Real execution for non-VLM targets (text layer, native extractors, OCR, labeler) and for
   * region/image-scoped calls. Without it those assignments fall back to the workspace model.
   */
  executorDeps?: ExecutorDeps;
  /** Optional decision-model verifier consulted only when every free check passed. */
  verifier?: CascadeVerifier;
  /**
   * Rendered raster of a page for the verifier (it judges the page image against the cheap target's output).
   * Called only when the verifier is about to be consulted; `release` removes any temp file afterwards.
   */
  pageImage?: (pageNumber: number) => Promise<{ path: string; release?: () => Promise<void> } | undefined>;
  /** Policy pack ranking the next-best target when a vendor refuses a page (see refusal-fallback.ts). */
  pack?: PolicyPack | null;
  /** Page height in points, for positioning scoped outputs inside page prose. */
  pageHeightPt?: (pageNumber: number) => number | null;
  signal?: AbortSignal;
}

export interface RoutedEscalation {
  pageNumber: number;
  from: string;
  to: string;
  trigger: VerifierTrigger;
  /** True when the primary's vendor refused the page and the leg is the next-best target of another vendor. */
  refusalFallback?: boolean;
}

export interface RoutedVisionResult {
  /** One output per page; multi-target pages are merged. Accept-text-only pages produce none. */
  outputs: VisionPageOutput[];
  actuals: RoutedPageActual[];
  /** Output-plausibility proxy per executed part (see quality.ts). */
  qualities: RoutedPageQuality[];
  skipped: Array<{ targetId: string; pages: number[]; reason: "privacy-mode" | "cost-cap" }>;
  escalations: RoutedEscalation[];
  /** Executor assignments that failed and were reported instead of thrown. */
  executorFailures: ExecutorFailure[];
  /** Non-fatal executor notes (e.g. a refused crop that kept its outcome because no other vendor could serve it). */
  executorWarnings: string[];
  /** Verifier calls made and their billed cost (included in no assignment actual). */
  verifier: { calls: number; costUsd: number };
}

/** Prompt templates (vision-runtime) for roles that are not whole-page transcription. */
export const ROLE_PROMPT: Partial<Record<Assignment["role"], string>> = {
  "chart-data": "chart-data",
  diagram: "diagram",
  "image-label": "image-label",
};

export function visionConfigForModel(
  selection: VisionConfig,
  modelUri: string,
  role?: Assignment["role"],
): VisionConfig {
  const prompt = role ? ROLE_PROMPT[role] : undefined;
  return {
    ...selection,
    modelUri,
    target: inferModelTarget(modelUri),
    ...(prompt ? { prompt } : {}),
  };
}

const isEmpty = (output: VisionPageOutput | undefined): boolean => !output || output.text.trim() === "";

type PartPlacement = "prose" | "accept" | "insert";

/** One piece of a page's final text, with enough identity to attribute cost and quality. */
interface Part {
  pageNumber: number;
  placement: PartPlacement;
  servesTargetId: string;
  assignmentIndex?: number;
  role: Assignment["role"];
  output: VisionPageOutput;
  /** Executor output backing an insert (for scope and formatting). */
  exec?: ExecutorOutput;
}

function fromExecutor(output: ExecutorOutput): VisionPageOutput {
  return {
    pageNumber: output.pageNumber,
    runtime: output.runtime,
    model: output.model,
    prompt: output.role,
    baseUrl: null,
    latencyMs: output.latencyMs,
    inputTokens: output.inputTokens,
    outputTokens: output.outputTokens,
    usageSource: output.runtime === "native" ? "native" : "executor",
    fallbackUsed: false,
    fallbackReason: output.fallback ?? null,
    text: output.text,
    costCents: output.costCents,
    ...(output.finishReason !== undefined ? { finishReason: output.finishReason } : {}),
  };
}

function isInsert(output: ExecutorOutput): boolean {
  return output.scope.kind !== "page" || output.role === "image-label";
}

function buildPageOutput(pageNumber: number, parts: Part[], pageHeightPt: number | null): VisionPageOutput | null {
  const working = parts.filter((p) => p.placement !== "accept");
  if (working.length === 0) return null;
  const proseParts = parts.filter((p) => p.placement === "prose");
  const accept = parts.find((p) => p.placement === "accept");
  const prose = proseParts.length > 0
    ? proseParts.map((p) => p.output.text.trim()).filter(Boolean).join("\n\n")
    : accept?.output.text ?? "";
  const inserts = parts.filter((p) => p.placement === "insert" && p.exec).map((p) => ({ ...p.exec!, text: p.output.text }));
  const text = inserts.length > 0 ? mergePageText({ prose, inserts, pageHeightPt }) : prose;
  const first = working[0]!.output;
  if (working.length === 1 && inserts.length === 0) return { ...first, text };
  const all = parts.map((p) => p.output);
  return {
    ...first,
    pageNumber,
    text,
    latencyMs: all.reduce((sum, o) => sum + o.latencyMs, 0),
    inputTokens: all.reduce((sum, o) => sum + o.inputTokens, 0),
    outputTokens: all.reduce((sum, o) => sum + o.outputTokens, 0),
    costCents: all.reduce((sum, o) => sum + o.costCents, 0),
    model: [...new Set(working.map((p) => p.output.model))].join("+"),
  };
}

/**
 * Executes a plan: page-scope VLM assignments batched per target (each group runs its own model
 * instead of the workspace vision model), every other assignment through the executor registry
 * (text layer, native extractors, OCR, local labeler, region/image crops), merges each page's
 * outputs into one canonical-ready body, then escalates pages whose output trips a free check
 * (or the optional verifier) at most once through the assignment's planned cascade target. Pure
 * orchestration over injected `extract`/`allow`/`executorDeps` so it is testable without a runtime.
 */
export async function runRoutedVision(args: RoutedVisionArgs): Promise<RoutedVisionResult> {
  const { plan, execution, catalog, selection } = args;
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const parts = new Map<number, Part[]>();
  const actuals: RoutedPageActual[] = [];
  const skipped: RoutedVisionResult["skipped"] = [];
  const escalations: RoutedEscalation[] = [];
  const verifierStats = { calls: 0, costUsd: 0 };
  const refusedByPage = new Map<number, Set<string>>();
  const refusedVendors = (page: number): Set<string> => {
    const set = refusedByPage.get(page) ?? new Set<string>();
    refusedByPage.set(page, set);
    return set;
  };
  let executorFailures: ExecutorFailure[] = [];
  let executorWarnings: string[] = [];

  const addPart = (part: Part): void => {
    parts.set(part.pageNumber, [...(parts.get(part.pageNumber) ?? []), part]);
  };

  const recordVision = (
    result: RoutedExtractResult,
    servesTargetId: (page: number) => string,
    role: Assignment["role"],
  ): void => {
    for (const output of result.outputs) {
      const cents = result.costCentsByPage.get(output.pageNumber) ?? output.costCents;
      actuals.push({
        pageNumber: output.pageNumber,
        servesTargetId: servesTargetId(output.pageNumber),
        costUsd: cents / 100,
        latencyMs: output.latencyMs,
      });
      addPart({ pageNumber: output.pageNumber, placement: "prose", servesTargetId: servesTargetId(output.pageNumber), role, output });
    }
  };

  /** Free checks first; the verifier only sees outputs the free checks accepted. */
  const triggerFor = async (
    output: VisionPageOutput | undefined,
    context: { pageNumber: number; targetId: string },
    useVerifier = true,
  ): Promise<VerifierTrigger | null> => {
    const free = freeCascadeTrigger({ text: output?.text ?? "", finishReason: output?.finishReason });
    if (free || !output || !args.verifier || !useVerifier) return free;
    const image = await args.pageImage?.(context.pageNumber).catch(() => undefined);
    let verdict: Awaited<ReturnType<CascadeVerifier["verify"]>>;
    try {
      verdict = await args.verifier.verify({
        pageNumber: context.pageNumber,
        targetId: context.targetId,
        text: output.text,
        ...(image ? { imagePath: image.path } : {}),
      });
    } finally {
      await image?.release?.().catch(() => undefined);
    }
    if (!verdict) return null;
    verifierStats.calls += 1;
    verifierStats.costUsd += verdict.costUsd;
    return verdict.escalate ? "decision-model-verifier" : null;
  };

  /**
   * At most one escalation per assignment, to the plan's cascade target. `candidates` are
   * whole-page outputs; a leg replaces the primary only when it is non-empty and either clean or
   * the primary was empty. The leg's cost counts either way.
   */
  const escalate = async (
    candidates: Array<{ assignment: Assignment; index: number; fromTargetId: string; part: Part }>,
  ): Promise<void> => {
    const wanted = new Map<string, Array<{ part: Part; fromTargetId: string; trigger: VerifierTrigger; assignmentIndex: number; refusal: boolean }>>();
    for (const candidate of candidates) {
      let legTargetId = candidate.assignment.cascade[0]?.targetId;
      // Deterministic content-filter refusal: the same vendor refuses the same page every time, so the planned leg
      // (or a missing one) is replaced by the next-best target of a different vendor.
      const refusal = isContentRefusal(candidate.part.output);
      if (refusal) {
        const from = byId.get(candidate.fromTargetId);
        if (from) refusedVendors(candidate.part.pageNumber).add(vendorOfTarget(from));
        const planned = legTargetId ? byId.get(legTargetId) : undefined;
        if (!planned || refusedVendors(candidate.part.pageNumber).has(vendorOfTarget(planned))) {
          legTargetId = rankRefusalFallbacks({
            assignment: { role: candidate.assignment.role, targetId: candidate.fromTargetId },
            catalog,
            pack: args.pack,
            refusedVendors: refusedVendors(candidate.part.pageNumber),
          })[0]?.id;
        }
      }
      if (!legTargetId || legTargetId === candidate.fromTargetId) continue;
      const trigger = await triggerFor(candidate.part.output, { pageNumber: candidate.part.pageNumber, targetId: candidate.fromTargetId });
      if (!trigger) continue;
      const list = wanted.get(legTargetId) ?? [];
      list.push({ part: candidate.part, fromTargetId: candidate.fromTargetId, trigger, assignmentIndex: candidate.index, refusal });
      wanted.set(legTargetId, list);
    }
    for (const [cascadeId, entries] of wanted) {
      const target = byId.get(cascadeId);
      const modelUri = target?.ref.modelUri;
      const pages = [...new Set(entries.map((e) => e.part.pageNumber))].sort((a, b) => a - b);
      if (!target || !modelUri || (target.kind !== "hosted-vlm" && target.kind !== "private-vlm")) continue;
      if (!args.canContinue()) {
        skipped.push({ targetId: cascadeId, pages, reason: "cost-cap" });
        continue;
      }
      const cascadeVision = visionConfigForModel(selection, modelUri);
      if (!(await args.allow(cascadeVision))) {
        skipped.push({ targetId: cascadeId, pages, reason: "privacy-mode" });
        continue;
      }
      const leg = await args.extract(cascadeVision, pages, { bypassCache: true });
      for (const output of leg.outputs) {
        const cents = leg.costCentsByPage.get(output.pageNumber) ?? output.costCents;
        for (const entry of entries.filter((e) => e.part.pageNumber === output.pageNumber)) {
          actuals.push({
            pageNumber: output.pageNumber,
            servesTargetId: entry.fromTargetId,
            ...(entry.part.assignmentIndex !== undefined ? { assignmentIndex: entry.part.assignmentIndex } : {}),
            costUsd: cents / 100 / entries.filter((e) => e.part.pageNumber === output.pageNumber).length,
            latencyMs: output.latencyMs,
          });
          // The escalation leg is judged by the free checks only: no second verifier bill.
          const cleanLeg = !(await triggerFor(output, { pageNumber: output.pageNumber, targetId: cascadeId }, false));
          if (!isEmpty(output) && (cleanLeg || isEmpty(entry.part.output))) entry.part.output = output;
          escalations.push({ pageNumber: output.pageNumber, from: entry.fromTargetId, to: cascadeId, trigger: entry.trigger, ...(entry.refusal ? { refusalFallback: true } : {}) });
        }
      }
    }
  };

  // ---- Page-scope VLM groups (workspace vision path) ----
  for (const group of execution.groups) {
    if (!args.canContinue()) {
      skipped.push({ targetId: group.targetId, pages: group.pages, reason: "cost-cap" });
      continue;
    }
    const vision = visionConfigForModel(selection, group.modelUri);
    if (!(await args.allow(vision))) {
      skipped.push({ targetId: group.targetId, pages: group.pages, reason: "privacy-mode" });
      continue;
    }
    const before = new Set([...parts.values()].flat());
    const result = await args.extract(vision, group.pages);
    recordVision(result, () => group.targetId, "extract-text");
    const added = [...parts.values()].flat().filter((p) => !before.has(p) && p.servesTargetId === group.targetId);
    await escalate(group.assignmentIndexes.map((index) => {
      const assignment = plan.assignments[index]!;
      return { assignment, index, fromTargetId: group.targetId, part: added.find((p) => p.pageNumber === assignment.pageNumber) };
    }).filter((c): c is typeof c & { part: Part } => !!c.part));
  }

  // ---- Executor registry (native, OCR, labeler, scoped VLM calls) ----
  let executorRequests = execution.requests;
  const runnable = args.executorDeps ? executorRequests : [];
  if (!args.executorDeps) {
    // No executors wired: extraction pages the registry would have served use the workspace model.
    for (const request of executorRequests) {
      const a = request.assignment;
      if (a.role === "accept-text" || a.role === "image-label" || a.scope.kind !== "page") continue;
      if (!execution.fallbackPages.includes(a.pageNumber)) execution.fallbackPages.push(a.pageNumber);
      execution.fallbackServes[a.pageNumber] ??= a.targetId;
    }
    execution.fallbackPages.sort((x, y) => x - y);
    executorRequests = [];
  }
  const fallbackFromFailures: number[] = [];
  if (args.executorDeps && runnable.length > 0) {
    const run = await executeAssignments(runnable, args.executorDeps, {
      signal: args.signal,
      canContinue: args.canContinue,
      refusalFallback: { catalog, pack: args.pack },
    });
    executorFailures = run.failures;
    executorWarnings = run.warnings;
    for (const skip of run.skipped) skipped.push({ targetId: skip.targetId, pages: [skip.pageNumber], reason: skip.reason });
    const candidates: Array<{ assignment: Assignment; index: number; fromTargetId: string; part: Part }> = [];
    for (const output of run.outputs) {
      const assignment = plan.assignments[output.assignmentIndex]!;
      const vision = fromExecutor(output);
      const placement: PartPlacement = assignment.role === "accept-text" ? "accept" : isInsert(output) ? "insert" : "prose";
      const part: Part = {
        pageNumber: output.pageNumber,
        placement,
        servesTargetId: output.targetId,
        assignmentIndex: output.assignmentIndex,
        role: output.role,
        output: vision,
        ...(placement === "insert" ? { exec: output } : {}),
      };
      addPart(part);
      if (placement !== "accept") {
        actuals.push({
          pageNumber: output.pageNumber,
          servesTargetId: output.targetId,
          assignmentIndex: output.assignmentIndex,
          costUsd: output.costCents / 100,
          latencyMs: output.latencyMs,
        });
      }
      if (output.refusalFallback) {
        escalations.push({
          pageNumber: output.pageNumber,
          from: output.refusalFallback.fromTargetId,
          to: output.refusalFallback.toTargetId,
          trigger: "non-stop-finish",
          refusalFallback: true,
        });
      }
      if (placement === "prose") candidates.push({ assignment, index: output.assignmentIndex, fromTargetId: output.targetId, part });
    }
    await escalate(candidates);
    // A failed page-scope extraction with no other prose falls back to the workspace model.
    for (const failure of run.failures) {
      const assignment = plan.assignments[failure.assignmentIndex]!;
      if (assignment.scope.kind !== "page" || assignment.role === "accept-text" || assignment.role === "image-label" || assignment.role === "skip") continue;
      const served = (parts.get(failure.pageNumber) ?? []).some((p) => p.placement === "prose");
      if (!served && !execution.fallbackPages.includes(failure.pageNumber) && !fallbackFromFailures.includes(failure.pageNumber)) {
        fallbackFromFailures.push(failure.pageNumber);
        execution.fallbackServes[failure.pageNumber] ??= failure.targetId;
      }
    }
  }

  // ---- Workspace-model fallback ----
  const fallbackPages = [...new Set([...execution.fallbackPages, ...fallbackFromFailures])]
    .filter((page) => !(parts.get(page) ?? []).some((p) => p.placement === "prose"))
    .sort((a, b) => a - b);
  if (fallbackPages.length > 0) {
    if (args.canContinue()) {
      const result = await args.extract(selection, fallbackPages);
      recordVision(result, (page) => execution.fallbackServes[page] ?? "skip", "extract-text");
    } else {
      skipped.push({ targetId: "workspace-vision-model", pages: fallbackPages, reason: "cost-cap" });
    }
  }

  // ---- Merge + quality ----
  const outputs: VisionPageOutput[] = [];
  const qualities: RoutedPageQuality[] = [];
  for (const [pageNumber, pageParts] of [...parts.entries()].sort(([a], [b]) => a - b)) {
    const merged = buildPageOutput(pageNumber, pageParts, args.pageHeightPt?.(pageNumber) ?? null);
    if (merged) outputs.push(merged);
    for (const part of pageParts) {
      const score = scoreOutputQuality({ text: part.output.text, role: part.role, finishReason: part.output.finishReason });
      qualities.push({
        pageNumber,
        servesTargetId: part.servesTargetId,
        ...(part.assignmentIndex !== undefined ? { assignmentIndex: part.assignmentIndex } : {}),
        quality: score.quality,
        passed: score.passed,
      });
    }
  }
  return { outputs, actuals, qualities, skipped, escalations, executorFailures, executorWarnings, verifier: verifierStats };
}
