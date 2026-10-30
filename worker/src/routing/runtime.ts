/**
 * Runtime glue between the page router and the worker pipeline: asset loading
 * (policy packs, model prices), the live target / decision-model catalogs, mode
 * resolution and the helpers render-images and vision-extract use to execute a
 * stored RoutePlan. Pure except for reading bundled JSON assets and env presence.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDecisionModelCatalog,
  buildRoutingTargetCatalog,
  llmModelUriSchema,
  resolvePageRouterMode,
  routePlanSchema,
  visionModelCatalog,
  visionModelUriProblem,
  type ActualOutcome,
  type Assignment,
  type DecisionModel,
  type PageRouterMode,
  type PlanValidation,
  type PolicyPack,
  type RoutePlan,
  type RoutingModelPriceMap,
  type RoutingTarget,
  type RoutingVisionCatalogEntry,
} from "@docslurp/shared";

import { executorFor } from "./executors/registry.js";
import { readRoutingFlags } from "./flags.js";
import type { ExecutionRequest } from "./executors/types.js";
import { NATIVE_ACCEPT_TARGET_ID, SKIP_TARGET_ID } from "./planner.js";
import { loadPolicyPack } from "./policy.js";
import { validatePlan } from "./validate.js";
import { PLAN_QUALITY_METHOD } from "./quality.js";

/** Artifact slot (per document) holding the RoutePlan JSON. */
export const PAGE_ROUTE_PLAN_SLOT = "page-route-plan";

// ---- Assets ---------------------------------------------------------------

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates: string[]): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** `src/routing/policies` in dev and tests, `dist/routing/policies` after the build copy. */
export function routingAssetPath(name: string): string | null {
  return firstExisting([
    path.join(moduleDir, "policies", name),
    path.join(process.cwd(), "worker", "src", "routing", "policies", name),
    path.join(process.cwd(), "src", "routing", "policies", name),
  ]);
}

/**
 * The one pack each router ships with. Superseded packs live in scripts/page-router/packs/ as fit bases
 * only; a missing current pack is a packaging error, not a reason to fall back to an older fit.
 */
export const RUNTIME_POLICY_PACKS = {
  baseline: "page-router-baseline-v1.json",
  "decision-model": "page-router-dm-v6.json",
} as const;

let cachedPacks = new Map<string, PolicyPack>();

export function loadRuntimePolicyPack(router: keyof typeof RUNTIME_POLICY_PACKS): PolicyPack {
  const name = RUNTIME_POLICY_PACKS[router];
  const cached = cachedPacks.get(name);
  if (cached) return cached;
  const file = routingAssetPath(name);
  if (!file) throw new Error(`page router policy pack not found (${name})`);
  const pack = loadPolicyPack(JSON.parse(readFileSync(file, "utf8")));
  cachedPacks.set(name, pack);
  return pack;
}

let cachedPrices: RoutingModelPriceMap | null | undefined;

/** List prices used for hosted VLM targets; null when the price file is not shipped. */
export function loadRuntimePrices(): RoutingModelPriceMap | null {
  if (cachedPrices !== undefined) return cachedPrices;
  const override = readRoutingFlags().modelPricesPath;
  const file = firstExisting([
    ...(override ? [override] : []),
    path.join(moduleDir, "policies", "model-prices.json"),
    path.resolve(moduleDir, "..", "..", "..", "scripts", "lib", "model-prices.json"),
    path.join(process.cwd(), "scripts", "lib", "model-prices.json"),
  ]);
  cachedPrices = file ? (JSON.parse(readFileSync(file, "utf8")) as RoutingModelPriceMap) : null;
  return cachedPrices;
}

/** Test hook. */
export function resetRuntimeAssetCaches(): void {
  cachedPacks = new Map();
  cachedPrices = undefined;
}

// ---- Catalogs -------------------------------------------------------------

export interface RuntimeCatalog {
  /** Targets the router may plan with (privacy filtered). */
  targets: RoutingTarget[];
  /** Every admitted target regardless of privacy, for resolving a stored plan. */
  allTargets: RoutingTarget[];
  decisionModels: DecisionModel[];
}

function envPresence(env: NodeJS.ProcessEnv): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = true;
  }
  return out;
}

/** Targets already reported as filtered, so the log line appears once per process and target. */
const reportedFilteredTargets = new Set<string>();

/**
 * Whether the vision runtime will send to `target` (tools/vision-runtime.ts re-checks `visionModelUriProblem` before
 * anything is admitted). A VLM target it would refuse (a hosted model outside the priced vision catalog) is dropped
 * here, so the planner picks the next-best admitted target instead of planning a page the runtime refuses.
 */
export function vlmTargetProblem(target: RoutingTarget): string | null {
  if (target.kind !== "hosted-vlm" && target.kind !== "private-vlm") return null;
  if (!target.ref.modelUri) return null;
  // A URI the route grammar rejects (a private seed without its registry alias) would throw at execution.
  const parsed = llmModelUriSchema.safeParse(target.ref.modelUri);
  if (!parsed.success) return `invalid model URI: ${parsed.error.issues[0]?.message ?? "unparseable"}`;
  return visionModelUriProblem(target.ref.modelUri);
}

function admitVisionTargets(targets: RoutingTarget[]): RoutingTarget[] {
  return targets.filter((target) => {
    const problem = vlmTargetProblem(target);
    if (!problem) return true;
    if (!reportedFilteredTargets.has(target.id)) {
      reportedFilteredTargets.add(target.id);
      console.warn(`[page-router] target=${target.id} filtered from the routing catalog: ${problem}`);
    }
    return false;
  });
}

/**
 * Builds the live catalogs from the environment. Non-standard privacy modes drop
 * hosted targets and hosted decision models (the call sites also fail closed).
 * DISABLE_NON_FREE_SOFTWARE drops non-free-licensed targets and decision models at admission (a stored plan that
 * names one resolves to no target and falls back to the workspace vision model). VLM targets the vision runtime
 * refuses (`vlmTargetProblem`: hosted models outside the priced vision catalog) are dropped the same way.
 */
export function buildRuntimeCatalog(
  options: { env?: NodeJS.ProcessEnv; privacyMode?: string | null; disableNonFree?: boolean } = {},
): RuntimeCatalog {
  const envSource = options.env ?? process.env;
  const env = envPresence(envSource);
  const disableNonFree = options.disableNonFree ?? readRoutingFlags(envSource).disableNonFreeSoftware;
  const prices = loadRuntimePrices();
  const checkedAt = prices?.asOf;
  const all = admitVisionTargets(buildRoutingTargetCatalog({
    visionCatalog: visionModelCatalog as unknown as readonly RoutingVisionCatalogEntry[],
    ...(prices ? { prices } : {}),
    env,
    disableNonFree,
    ...(checkedAt ? { checkedAt } : {}),
  }).targets);
  const decisionAll = buildDecisionModelCatalog({ env, disableNonFree }).models;
  const hostedAllowed = options.privacyMode === undefined || options.privacyMode === null || options.privacyMode === "standard";
  return {
    allTargets: all,
    targets: hostedAllowed ? all : all.filter((t) => t.availability.privacyClass !== "hosted"),
    decisionModels: hostedAllowed ? decisionAll : decisionAll.filter((m) => m.availability.privacyClass !== "hosted"),
  };
}

// ---- Mode -----------------------------------------------------------------

export function effectivePageRouterMode(
  state: { run: { pipeline?: { pageRouter?: { mode?: PageRouterMode } | null } | null } },
  cfg: { pageRouterMode?: PageRouterMode } | undefined,
): PageRouterMode {
  return resolvePageRouterMode(state.run.pipeline?.pageRouter?.mode, cfg?.pageRouterMode);
}

// ---- Executing a stored plan ----------------------------------------------

export function parseRoutePlan(input: unknown): RoutePlan | null {
  const parsed = routePlanSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** Roles that need no pixels: the native text layer is accepted, or the page is skipped. */
const PIXEL_FREE_ROLES = new Set<Assignment["role"]>(["accept-text", "skip"]);

/** Native extractors read the source document, so they need no page raster either. */
export function assignmentNeedsPixels(assignment: Assignment): boolean {
  return !PIXEL_FREE_ROLES.has(assignment.role) && assignment.targetId !== SKIP_TARGET_ID
    && assignment.targetId !== NATIVE_ACCEPT_TARGET_ID && !assignment.targetId.startsWith("native:");
}

/** Pages whose plan needs a raster: every non-native, non-skip assignment (cascade legs included). */
export function pagesNeedingPixels(plan: RoutePlan): number[] {
  return [...new Set(plan.assignments.filter(assignmentNeedsPixels).map((a) => a.pageNumber))]
    .sort((a, b) => a - b);
}

export interface RoutedGroup {
  targetId: string;
  target: RoutingTarget;
  modelUri: string;
  /** Pages in ascending order. */
  pages: number[];
  /** Indexes into plan.assignments served by this group. */
  assignmentIndexes: number[];
}

export interface RoutedExecution {
  /** Page-scope extraction on a VLM target, batched per target (workspace vision path, cached, fan-out capable). */
  groups: RoutedGroup[];
  /**
   * Assignments the executor registry runs (native text, OCR, local labeler, region/image-scoped
   * and image-label VLM calls), in plan order. Includes accept-text so the page prose can be
   * merged with scoped outputs; accept-text-only pages produce no replacement.
   */
  requests: ExecutionRequest[];
  /**
   * Extraction assignments no executor can run (unknown target, unconfigured engine). Their pages
   * fall back to the workspace vision model so a page that needs pixels is never silently dropped.
   */
  fallbackPages: number[];
  /** Planned target id to attribute each fallback page's actual cost to (first unexecutable assignment). */
  fallbackServes: Record<number, string>;
  /** Assignments that run nothing (accept-text, skip) or are unexecutable enrichment roles. */
  idleAssignmentIndexes: number[];
}

const isVlm = (target: RoutingTarget | undefined): target is RoutingTarget & { ref: { modelUri: string } } =>
  !!target && (target.kind === "hosted-vlm" || target.kind === "private-vlm") && !!target.ref.modelUri;

/** Groups the plan's assignments: batched VLM pages per target, executor requests, and fallbacks. */
export function groupAssignmentsByTarget(plan: RoutePlan, catalog: readonly RoutingTarget[]): RoutedExecution {
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const groups = new Map<string, RoutedGroup>();
  const requests: ExecutionRequest[] = [];
  const fallback = new Map<number, string>();
  const idle: number[] = [];
  plan.assignments.forEach((assignment, index) => {
    const target = byId.get(assignment.targetId);
    if (assignment.role === "skip" || assignment.targetId === SKIP_TARGET_ID) {
      idle.push(index);
      return;
    }
    if (assignment.role === "accept-text" || assignment.targetId === NATIVE_ACCEPT_TARGET_ID) {
      idle.push(index);
      if (target && executorFor(target)) requests.push({ assignment, index, target });
      return;
    }
    // Whole-page VLM extraction keeps the batched workspace vision path.
    if (isVlm(target) && assignment.scope.kind === "page" && assignment.role !== "image-label") {
      const group = groups.get(target.id) ?? {
        targetId: target.id,
        target,
        modelUri: target.ref.modelUri,
        pages: [],
        assignmentIndexes: [],
      };
      if (!group.pages.includes(assignment.pageNumber)) group.pages.push(assignment.pageNumber);
      group.assignmentIndexes.push(index);
      groups.set(target.id, group);
      return;
    }
    if (target && executorFor(target)) {
      requests.push({ assignment, index, target });
      return;
    }
    // Enrichment roles (captions) have no fallback value; extraction roles do.
    if (assignment.role === "image-label") idle.push(index);
    else if (!fallback.has(assignment.pageNumber)) fallback.set(assignment.pageNumber, assignment.targetId);
  });
  for (const group of groups.values()) group.pages.sort((a, b) => a - b);
  const covered = (page: number) =>
    [...groups.values()].some((g) => g.pages.includes(page))
    || requests.some((r) => r.assignment.pageNumber === page && r.assignment.scope.kind === "page" && r.assignment.role !== "accept-text" && r.assignment.role !== "image-label");
  const fallbackPages = [...fallback.keys()].filter((page) => !covered(page)).sort((a, b) => a - b);
  return {
    groups: [...groups.values()],
    requests,
    fallbackPages,
    fallbackServes: Object.fromEntries(fallbackPages.map((page) => [page, fallback.get(page)!])),
    idleAssignmentIndexes: idle,
  };
}

export interface RoutedPageActual {
  pageNumber: number;
  /** The planned (primary) target this call serves; an escalation leg names the primary it replaced. */
  servesTargetId: string;
  /** Set for executor-run assignments, which attribute exactly; vision-group calls match by page and target. */
  assignmentIndex?: number;
  costUsd: number;
  latencyMs: number;
}

/** Output-based quality proxy for one executed part (see quality.ts). */
export interface RoutedPageQuality {
  pageNumber: number;
  servesTargetId: string;
  assignmentIndex?: number;
  quality: number | null;
  passed: boolean;
}

/**
 * PlanValidation from what actually ran. `actuals` come from the usage events recorded
 * for each page call (cost) and the call latency; an escalation leg is attributed to the
 * assignment whose primary it replaced. Assignments accepted from the text layer cost
 * nothing. A page/target served by several assignments splits its actual evenly so the
 * chunk total stays exact (executor actuals carry their assignment index and do not split).
 * Assignments that did not execute are left out. `qualities` fill ActualOutcome.quality/passed
 * from the output-plausibility proxy; assignments without one stay null.
 */
export function buildRoutedValidation(
  plan: RoutePlan,
  actuals: readonly RoutedPageActual[],
  qualities: readonly RoutedPageQuality[] = [],
): PlanValidation {
  const perAssignment: Array<ActualOutcome | null> = plan.assignments.map(() => null);
  const key = (page: number, target: string) => `${page}|${target}`;
  const owners = new Map<string, number[]>();
  plan.assignments.forEach((a, i) => {
    if (!assignmentNeedsPixels(a)) {
      perAssignment[i] = { costUsd: 0, latencyMs: 0, quality: null, passed: null };
      return;
    }
    const k = key(a.pageNumber, a.targetId);
    owners.set(k, [...(owners.get(k) ?? []), i]);
  });
  const direct = new Map<number, { costUsd: number; latencyMs: number }>();
  const totals = new Map<string, { costUsd: number; latencyMs: number }>();
  for (const actual of actuals) {
    if (actual.assignmentIndex !== undefined && actual.assignmentIndex < plan.assignments.length) {
      const prev = direct.get(actual.assignmentIndex) ?? { costUsd: 0, latencyMs: 0 };
      direct.set(actual.assignmentIndex, { costUsd: prev.costUsd + actual.costUsd, latencyMs: prev.latencyMs + actual.latencyMs });
      continue;
    }
    const k = key(actual.pageNumber, actual.servesTargetId);
    const prev = totals.get(k) ?? { costUsd: 0, latencyMs: 0 };
    totals.set(k, { costUsd: prev.costUsd + actual.costUsd, latencyMs: prev.latencyMs + actual.latencyMs });
  }
  const set = (index: number, costUsd: number, latencyMs: number) => {
    perAssignment[index] = { costUsd, latencyMs, quality: null, passed: null };
  };
  for (const [index, total] of direct) set(index, total.costUsd, total.latencyMs);
  for (const [k, total] of totals) {
    const indexes = (owners.get(k) ?? []).filter((i) => !direct.has(i));
    for (const index of indexes) set(index, total.costUsd / indexes.length, total.latencyMs / indexes.length);
  }
  // Quality proxy: by assignment index when known, else shared by page and target.
  const qByIndex = new Map<number, RoutedPageQuality[]>();
  for (const q of qualities) {
    const indexes = q.assignmentIndex !== undefined ? [q.assignmentIndex] : owners.get(key(q.pageNumber, q.servesTargetId)) ?? [];
    for (const index of indexes) qByIndex.set(index, [...(qByIndex.get(index) ?? []), q]);
  }
  for (const [index, list] of qByIndex) {
    const current = perAssignment[index];
    if (!current) continue;
    const scored = list.map((q) => q.quality).filter((v): v is number => v !== null);
    perAssignment[index] = {
      ...current,
      quality: scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      passed: list.every((q) => q.passed),
      qualityMethod: PLAN_QUALITY_METHOD,
    };
  }
  return validatePlan({ plan, assignmentActuals: perAssignment });
}
