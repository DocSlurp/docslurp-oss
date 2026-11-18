/**
 * Whether vision-extract will read pages: the run-level gate vision-extract itself applies, and the per-document
 * decision it makes. Pure (no privacy audit is written here; vision-extract audits a blocked route when it runs).
 */
import { isProviderCallAllowed, qualityAllowsPageReading, qualityReadsEveryPage, resolveVisionRoute, type PipelineFeatures } from "@docslurp/shared";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { visionCall } from "../tools/vision-runtime.js";
import { visionAllowedForDocument } from "./vision-page-budget.js";
import { resolveRunRoutingV2 } from "./vision-routing-v2.js";

type VisionPipeline = Pick<PipelineFeatures, "visionFallback" | "quality" | "privacyMode" | "vision">;

/** Vision fallback is on and the quality reads pages (Fast never does). vision-extract adds the audited privacy check. */
export function visionRunMayReadPages(pipeline: Pick<VisionPipeline, "visionFallback" | "quality">): boolean {
  return pipeline.visionFallback === true && qualityAllowsPageReading(pipeline.quality);
}

/** visionRunMayReadPages, and privacy mode allows the configured vision route. */
export function visionRunReadsPages(pipeline: VisionPipeline): boolean {
  return visionRunMayReadPages(pipeline) && isProviderCallAllowed(pipeline.privacyMode, visionCall(resolveVisionRoute(pipeline.vision)));
}

/**
 * Whether vision-extract may read this document's pages: the run reads pages, and either the quality reads every page
 * (vision's all-pages override) or extraction asked for vision and the document's playbook allows it. Errs towards
 * true: a document vision then leaves alone only loses stored table cells, never correctness.
 */
export function visionMayReadDocumentPages(state: Pick<WorkflowState, "run" | "artifactLedger">, documentId: string, needsVision: boolean): boolean {
  const pipeline = state.run.pipeline;
  if (!visionRunReadsPages(pipeline)) return false;
  if (qualityReadsEveryPage(pipeline.quality)) return true;
  return needsVision && visionAllowedForDocument(pipeline, state.artifactLedger.readDocument(documentId, "parser-playbook"), { evidenceRouting: resolveRunRoutingV2(state as WorkflowState) });
}
