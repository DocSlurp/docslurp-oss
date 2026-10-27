import { defaultPageRouterConfig, type RoutePlan } from "@docslurp/shared";

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
 * plan was written in active mode. Everything else (off, shadow, no plan, unreadable plan)
 * returns null so callers keep the legacy path byte-for-byte.
 */
export async function loadActiveRoutePlan(
  state: WorkflowState,
  storage: Pick<ArtifactStore, "bucket" | "getJson">,
  documentId: string,
  cfg: Pick<Config, "pageRouterMode"> | undefined,
): Promise<RoutePlan | null> {
  if (effectivePageRouterMode(state, cfg) !== "active") return null;
  assertSupportedActiveMargin((state.run.pipeline.pageRouter ?? defaultPageRouterConfig).marginFloor);
  const uri = state.artifactLedger.readDocument(documentId, PAGE_ROUTE_PLAN_SLOT);
  const key = uri ? keyFromStorageUri(uri, storage.bucket) : null;
  if (!key) return null;
  let plan: RoutePlan | null;
  try {
    plan = parseRoutePlan(await storage.getJson<unknown>(key));
  } catch {
    return null;
  }
  if (!plan || plan.mode !== "active") return null;
  assertCompleteActivePlan(plan);
  return plan;
}
