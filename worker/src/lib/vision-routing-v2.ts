import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import type { WorkspaceRun } from "../models.js";

/**
 * Per-run routing version for the legacy (non-router) vision path:
 *
 * - `v2` (every run started since evidence routing): a page goes to a vision/OCR read only on facts about the PDF
 *   page itself (docs/page-routing-evidence.md): native words from the text layer, significant non-repeated images,
 *   the text layer's own quality, drawn content. Text routes only label pages for the report.
 * - `v1` (runs started earlier and still in flight, or states built without a pin): the keyword and character-class
 *   heuristics those runs were classified with. Nothing starts a new run on v1; delete it once in-flight runs drain.
 *
 * The version is pinned when the run starts (`pinRunRoutingVersion` from `startRun`) and persisted as a run
 * artifact. Every later stage, shard and page task reads that artifact (`resolveRunRoutingV2`, v1 when it is
 * missing), so workers with different builds, retries and rehydrated runs all route the run the same way. There is
 * no environment switch: a flag would only bring the keyword triggers back.
 */

/** Run artifact slot holding the run's resolved routing version (`v1` or `v2`). */
export const VISION_ROUTING_VERSION_SLOT = "run:vision-routing-version";

export type RoutingVersion = "v1" | "v2";

export interface RoutingVersionOptions {
  /** Evidence routing (v2). Off reads as v1: the keyword routing of runs started earlier. */
  routingV2?: boolean;
}

/** Routing version recorded in stage stats so telemetry can tell the two apart. */
export function routingVersion(routingV2: boolean): RoutingVersion {
  return routingV2 ? "v2" : "v1";
}

type RunRoutingState = { run: Pick<WorkspaceRun, "id" | "workspaceId">; artifactLedger: DocumentArtifactLedger };

/**
 * Pins the run to evidence routing (v2) unless it already has a version, and records it in the run's artifacts
 * (persisted by the caller's next checkpoint). Called by `startRun` before any stage executes; idempotent, so a
 * retried start keeps the first value.
 */
export function pinRunRoutingVersion(state: RunRoutingState): RoutingVersion {
  const stored = state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT);
  if (stored === "v1" || stored === "v2") return stored;
  if (stored !== undefined) {
    // Unknown value (a later version this worker does not know): never widen to the newest rules.
    console.warn(`[vision-routing] run=${state.run.id} has routing version ${JSON.stringify(stored.slice(0, 40))}; routing as v1`);
    return "v1";
  }
  state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v2");
  return "v2";
}

/**
 * Whether the run routes with v2: the version pinned at run start. A run without a pin (started before pins
 * existed, or a state built outside `startRun`) routes as v1, so no later stage, shard or retry can fill in a
 * different value.
 */
export function resolveRunRoutingV2(state: RunRoutingState): boolean {
  const stored = state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT);
  if (stored === "v2") return true;
  if (stored !== undefined && stored !== "v1") {
    console.warn(`[vision-routing] run=${state.run.id} has routing version ${JSON.stringify(stored.slice(0, 40))}; routing as v1`);
  }
  return false;
}
