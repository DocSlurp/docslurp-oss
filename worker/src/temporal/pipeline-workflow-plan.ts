import { WORKFLOW_STAGE_ORDER } from "./workflow-stage-order.js";

export type WorkflowStageName = (typeof WORKFLOW_STAGE_ORDER)[number];

export interface PipelineWorkflowPlanInput {
  stageOrder?: readonly string[] | null;
}

/**
 * Stages added to WORKFLOW_STAGE_ORDER after runs already existed, with the
 * `patched()` id that gates each in the legacy fallback order. Histories that
 * started before the stage existed (no explicit `stageOrder`, no patch marker)
 * keep their original command sequence. Never reuse an id; see
 * docs/temporal-workflow-changes.md.
 */
export const PATCHED_FALLBACK_STAGES = [
  { stage: "route-pages", patchId: "page-router-stage" },
  { stage: "document-map", patchId: "document-map-stage" },
  { stage: "page-embed", patchId: "page-embed-stage" },
] as const satisfies ReadonlyArray<{ stage: WorkflowStageName; patchId: string }>;

export function resolvePipelineWorkflowStageOrder(
  input: PipelineWorkflowPlanInput,
  /** Whether a patch id is active for this execution (workflow code passes `patched`). */
  isPatched: (patchId: string) => boolean = () => true,
): WorkflowStageName[] {
  const allowed = new Set<string>(WORKFLOW_STAGE_ORDER);
  const stageOrder =
    input.stageOrder?.filter((stage): stage is WorkflowStageName =>
      allowed.has(stage),
    ) ?? [];

  if (stageOrder.length > 0) return stageOrder;
  // Legacy fallback: drop stages whose patch is not active so old histories replay unchanged.
  // `patched` is evaluated lazily, only on this path, so explicit stage orders add no markers.
  const dropped = new Set<string>(
    PATCHED_FALLBACK_STAGES.filter((entry) => !isPatched(entry.patchId)).map((entry) => entry.stage),
  );
  return WORKFLOW_STAGE_ORDER.filter((stage) => !dropped.has(stage));
}
