import { z } from "zod";
import type { ArtifactPlacement } from "./extractors.js";

const nonempty = z.string().min(1);
const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const placementSchema = z.strictObject({
  pageNumber: z.number().int().positive(),
  bbox: bboxSchema.optional(),
  coordinateSpace: z.enum(["pdf-points", "pixels", "normalized"]).optional(),
  fidelity: z.enum(["exact", "approximate", "page-only"]),
});

/** Observations describe visible evidence; an unlabeled target has no answer field. */
export const visualObservationSchema = z.strictObject({
  id: nonempty,
  sourceDocumentId: nonempty,
  evidenceImageId: nonempty,
  kind: z.enum(["image", "diagram", "chart", "worksheet", "other"]),
  placements: z.array(placementSchema),
  ocrText: z.array(nonempty).default([]),
  description: nonempty.optional(),
  chart: z.strictObject({
    axes: z.array(z.strictObject({ label: nonempty.optional(), orientation: z.enum(["horizontal", "vertical", "other"]), unit: nonempty.optional(), visibleRange: nonempty.optional() })).default([]),
    marks: z.array(z.strictObject({ type: nonempty, visibleLabel: nonempty.optional(), visibleValue: nonempty.optional() })).default([]),
  }).optional(),
  visibleLabels: z.array(nonempty).default([]),
  givenValues: z.array(z.strictObject({ label: nonempty.optional(), value: nonempty, unit: nonempty.optional() })).default([]),
  unlabeledTargets: z.array(z.strictObject({ prompt: nonempty.optional(), location: nonempty.optional(), shape: nonempty.optional() })).default([]),
  uncertainty: z.strictObject({ level: z.enum(["none", "low", "medium", "high"]), notes: z.array(nonempty).default([]) }),
});

export type VisualObservation = z.infer<typeof visualObservationSchema>;
export type VisualPlacementDecision = "inline" | "page-sidecar" | "unplaced";

/** Inline insertion requires an exact bounding box in a declared coordinate space. */
export function decideVisualPlacement(placement?: ArtifactPlacement): VisualPlacementDecision {
  if (!placement) return "unplaced";
  return placement.fidelity === "exact" && placement.bbox && placement.coordinateSpace ? "inline" : "page-sidecar";
}

export interface VisualAssociation {
  observationId: string;
  evidenceImageId: string;
  placement: ArtifactPlacement;
  decision: Exclude<VisualPlacementDecision, "unplaced">;
}

export interface VisualAssociations {
  perPage: Record<number, VisualAssociation[]>;
  unplaced: Array<{ observationId: string; evidenceImageId: string }>;
}

/** One association per placement, so repeated images keep every page link. */
export function associateVisualObservations(observations: readonly VisualObservation[]): VisualAssociations {
  const perPage: Record<number, VisualAssociation[]> = {};
  const unplaced: VisualAssociations["unplaced"] = [];
  for (const observation of observations) {
    const checked = visualObservationSchema.parse(observation);
    if (checked.placements.length === 0) {
      unplaced.push({ observationId: checked.id, evidenceImageId: checked.evidenceImageId });
      continue;
    }
    for (const placement of checked.placements) {
      (perPage[placement.pageNumber] ??= []).push({
        observationId: checked.id,
        evidenceImageId: checked.evidenceImageId,
        placement,
        decision: decideVisualPlacement(placement) as "inline" | "page-sidecar",
      });
    }
  }
  return { perPage, unplaced };
}
