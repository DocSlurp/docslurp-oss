import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import type { WorkspaceRun } from "../models.js";

/**
 * Per-run routing version for the legacy (non-router) vision path:
 *
 * - `v3` (every run started since evidence routing): a page goes to a vision/OCR read only on facts about the PDF
 *   page itself (docs/page-routing-evidence.md): native words from the text layer, significant non-repeated images,
 *   the text layer's own quality, drawn content. Text routes only label pages for the report.
 * - `v1` (runs started earlier and still in flight, or states built without a pin): the keyword and character-class
 *   heuristics those runs were classified with. Nothing starts a new run on v1; delete it once in-flight runs drain.
 *
 * Why `v3` and not `v2`: the previous release pinned `v2` for its canary keyword-routing rules (VISION_ROUTING_V2).
 * Evidence routing changed what the pin means, and during a rolling deploy an old worker (which understands only
 * `v1` and `v2`) can pick up a run this release started. Under `v2` it would route the run with the old canary
 * rules; under `v3` it does not recognise the pin and routes as v1 with a warning, the behaviour of every run
 * that has no pin. Likewise this worker never reads a `v2` pin written by an old worker as evidence routing: it
 * routes that run as v1 (an unknown pin is never widened to the newest rules).
 *
 * The version is pinned when the run starts (`pinRunRoutingVersion` from `startRun`) and persisted as a run
 * artifact. Every later stage, shard and page task reads that artifact (`resolveRunRoutingV2`, v1 when it is
 * missing or unknown), so workers with different builds, retries and rehydrated runs all route the run the same
 * way. There is no environment switch: a flag would only bring the keyword triggers back.
 */

/** Run artifact slot holding the run's resolved routing version (`v1` or `v3`). */
export const VISION_ROUTING_VERSION_SLOT = "run:vision-routing-version";

export type RoutingVersion = "v1" | "v3";

export interface RoutingVersionOptions {
  /** Evidence routing (v3). Off reads as v1: the keyword routing of runs started earlier. */
  routingV2?: boolean;
}

/** Routing version recorded in stage stats so telemetry can tell the two apart. */
export function routingVersion(routingV2: boolean): RoutingVersion {
  return routingV2 ? "v3" : "v1";
}

function warnUnknownPin(runId: string, stored: string): void {
  const note = stored === "v2" ? " (pinned by a release with different v2 rules)" : "";
  console.warn(`[vision-routing] run=${runId} has routing version ${JSON.stringify(stored.slice(0, 40))}${note}; routing as v1`);
}

type RunRoutingState = { run: Pick<WorkspaceRun, "id" | "workspaceId">; artifactLedger: DocumentArtifactLedger };

/**
 * Pins the run to evidence routing (v3) unless it already has a version, and records it in the run's artifacts
 * (persisted by the caller's next checkpoint). Called by `startRun` before any stage executes; idempotent, so a
 * retried start keeps the first value.
 */
export function pinRunRoutingVersion(state: RunRoutingState): RoutingVersion {
  const stored = state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT);
  if (stored === "v1" || stored === "v3") return stored;
  if (stored !== undefined) {
    // Unknown value (a later version, or the previous release's `v2`): never widen to the newest rules.
    warnUnknownPin(state.run.id, stored);
    return "v1";
  }
  state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
  return "v3";
}

/**
 * Whether the run routes with evidence routing (v3): the version pinned at run start. A run without a pin (started before pins
 * existed, or a state built outside `startRun`) routes as v1, so no later stage, shard or retry can fill in a
 * different value.
 */
export function resolveRunRoutingV2(state: RunRoutingState): boolean {
  const stored = state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT);
  if (stored === "v3") return true;
  if (stored !== undefined && stored !== "v1") warnUnknownPin(state.run.id, stored);
  return false;
}
