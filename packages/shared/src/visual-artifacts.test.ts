import { describe, expect, it } from "vitest";
import { associateVisualObservations, decideVisualPlacement, visualObservationSchema } from "./visual-artifacts.js";

const base = { id: "obs", sourceDocumentId: "doc", evidenceImageId: "image-7", kind: "worksheet" as const,
  ocrText: ["Find x"], visibleLabels: ["x"], givenValues: [{ label: "angle A", value: "45", unit: "degrees" }],
  unlabeledTargets: [{ prompt: "find x", location: "top right" }], uncertainty: { level: "medium" as const, notes: ["faint line"] } };

describe("visual observations", () => {
  it("keeps visible givens separate from unanswered targets", () => {
    const observation = visualObservationSchema.parse({ ...base, placements: [] });
    expect(observation.givenValues[0].value).toBe("45");
    expect(observation.unlabeledTargets[0]).not.toHaveProperty("value");
    expect(() => visualObservationSchema.parse({ ...base, placements: [], unlabeledTargets: [{ prompt: "find x", answer: "45" }] })).toThrow();
  });

  it("permits inline only with exact bbox and coordinate space", () => {
    expect(decideVisualPlacement({ pageNumber: 1, fidelity: "exact", bbox: [0, 0, 10, 10], coordinateSpace: "pdf-points" })).toBe("inline");
    expect(decideVisualPlacement({ pageNumber: 1, fidelity: "exact" })).toBe("page-sidecar");
    expect(decideVisualPlacement({ pageNumber: 1, fidelity: "approximate", bbox: [0, 0, 10, 10], coordinateSpace: "pdf-points" })).toBe("page-sidecar");
    expect(decideVisualPlacement()).toBe("unplaced");
  });

  it("retains every page association and image identity", () => {
    const observation = visualObservationSchema.parse({ ...base, placements: [
      { pageNumber: 1, fidelity: "exact", bbox: [0, 0, 10, 10], coordinateSpace: "pdf-points" },
      { pageNumber: 2, fidelity: "page-only" },
    ] });
    const orphan = visualObservationSchema.parse({ ...base, id: "orphan", evidenceImageId: "image-8", placements: [] });
    const result = associateVisualObservations([observation, orphan]);
    expect(result.perPage[1][0]).toMatchObject({ evidenceImageId: "image-7", decision: "inline" });
    expect(result.perPage[2][0]).toMatchObject({ evidenceImageId: "image-7", decision: "page-sidecar" });
    expect(result.unplaced).toEqual([{ observationId: "orphan", evidenceImageId: "image-8" }]);
  });
});
