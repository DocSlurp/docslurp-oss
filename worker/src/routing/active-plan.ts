import { defaultPageRouterConfig, effectiveLadder, type RoutePlan } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { PAGE_ROUTE_PLAN_SLOT, effectivePageRouterMode, parseRoutePlan } from "./runtime.js";

/** No page-revenue allocation exists yet; cost-only receipts cannot support a margin promise. */
export function assertSupportedActiveMargin(marginFloor: number): void {
  if (!Number.isFinite(marginFloor) || marginFloor > 0) {
    throw new Error("page-router-incomplete: positive margin floors require once-per-page billable revenue allocation; active routing is unavailable");
  }
}

/** Refuse persisted partial plans: budget deferrals have no durable execution queue. */
export function assertCompleteActivePlan(plan: RoutePlan): void {
  assertSupportedActiveMargin(plan.chunkEstimate.budget.marginFloor);
  if (plan.rejected.some((entry) => entry.reason === "budget") ||
      plan.chunkEstimate.overBudgetActions.some((action) => action === "defer" || action === "skip")) {
    throw new Error("page-router-incomplete: budget guard removed content; refusing successful partial extraction");
  }
}

/**
 * The document's stored RoutePlan, only when the page router is effectively `active` and the
 * plan was written in active mode. Off, shadow and absent plans return null.
 * Callers selecting paid reads use strict mode so an unreadable plan cannot drop its budgets.
 */
export async function loadActiveRoutePlan(
  state: WorkflowState,
  storage: Pick<ArtifactStore, "bucket" | "getJson">,
  documentId: string,
  cfg: Pick<Config, "pageRouterMode"> | undefined,
  options?: { strict?: boolean },
): Promise<RoutePlan | null> {
  if (effectivePageRouterMode(state, cfg) !== "active") return null;
  // An Auto ladder limit (pipeline.ladder) plans every page read from page triage; a router plan would read pages outside
  // it, so documents of a run with a limit take the triage path (the router still records its plan).
  if (effectiveLadder(state.run.pipeline).active) return null;
  assertSupportedActiveMargin((state.run.pipeline.pageRouter ?? defaultPageRouterConfig).marginFloor);
  const uri = state.artifactLedger.readDocument(documentId, PAGE_ROUTE_PLAN_SLOT);
  const key = uri ? keyFromStorageUri(uri, storage.bucket) : null;
  if (!key) {
    if (options?.strict && uri) throw new Error("Invalid route plan artifact reference");
    return null;
  }
  let plan: RoutePlan | null;
  try {
    plan = parseRoutePlan(await storage.getJson<unknown>(key));
  } catch (error) {
    if (options?.strict) throw error;
    return null;
  }
  if (!plan && options?.strict) throw new Error("Invalid route plan artifact");
  if (!plan || plan.mode !== "active") return null;
  assertCompleteActivePlan(plan);
  return plan;
}
