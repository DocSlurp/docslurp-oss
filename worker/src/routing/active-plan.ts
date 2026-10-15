import type { RoutePlan } from "@docslurp/shared";

import type { Config } from "../config.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { type ArtifactStore, keyFromStorageUri } from "../tools/storage.js";
import { PAGE_ROUTE_PLAN_SLOT, effectivePageRouterMode, parseRoutePlan } from "./runtime.js";

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
  const uri = state.artifactLedger.readDocument(documentId, PAGE_ROUTE_PLAN_SLOT);
  const key = uri ? keyFromStorageUri(uri, storage.bucket) : null;
  if (!key) return null;
  try {
    const plan = parseRoutePlan(await storage.getJson<unknown>(key));
    return plan && plan.mode === "active" ? plan : null;
  } catch {
    return null;
  }
}
