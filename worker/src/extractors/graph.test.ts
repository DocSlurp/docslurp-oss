import { describe, expect, it } from "vitest";
import { planArtifactGraph } from "./graph.js";

describe("planArtifactGraph", () => {
  it("uses AND requirements and multi-output edges", () => {
    const result = planArtifactGraph({
      initial: ["pdf"], target: ["markdown"], adapters: [
        { id: "pdf-assets", accepts: ["pdf"], emits: ["text", "page-images"] },
        { id: "ocr", accepts: ["page-images"], emits: ["ocr-text"] },
        { id: "assemble", accepts: ["text", "ocr-text"], emits: ["markdown"] },
      ],
    });
    expect(result.ok && result.steps.map((step) => step.id)).toEqual(["pdf-assets", "ocr", "assemble"]);
  });

  it("chooses minimum cost rather than fewest steps", () => {
    const result = planArtifactGraph({ initial: ["pdf"], target: ["markdown"], adapters: [
      { id: "expensive", accepts: ["pdf"], emits: ["markdown"], cost: 10 },
      { id: "extract", accepts: ["pdf"], emits: ["text"], cost: 1 },
      { id: "format", accepts: ["text"], emits: ["markdown"], cost: 1 },
    ] });
    expect(result.ok && result.steps.map((step) => step.id)).toEqual(["extract", "format"]);
    expect(result.ok && result.cost).toBe(2);
  });

  it("reports impossible cycles without looping", () => {
    const result = planArtifactGraph({ initial: ["pdf"], target: ["markdown"], adapters: [
      { id: "a", accepts: ["html"], emits: ["text"] },
      { id: "b", accepts: ["text"], emits: ["html"] },
    ] });
    expect(result).toEqual({ ok: false, reason: "unreachable", missing: ["markdown"] });
  });

  it("honors depth and work limits", () => {
    const adapters = [
      { id: "a", accepts: ["pdf"], emits: ["text"] },
      { id: "b", accepts: ["text"], emits: ["markdown"] },
    ];
    expect(planArtifactGraph({ initial: ["pdf"], target: ["markdown"], adapters, maxSteps: 1 })).toMatchObject({ ok: false, reason: "limit" });
    expect(planArtifactGraph({ initial: ["pdf"], target: ["markdown"], adapters, maxStates: 1 })).toMatchObject({ ok: false, reason: "limit" });
  });

  it("accepts an already satisfied target and rejects invalid costs", () => {
    expect(planArtifactGraph({ initial: ["markdown"], target: ["markdown"], adapters: [] })).toMatchObject({ ok: true, steps: [], cost: 0 });
    expect(() => planArtifactGraph({ initial: [], target: ["text"], adapters: [{ id: "a", accepts: [], emits: ["text"], cost: -1 }] })).toThrow("invalid cost");
  });
});
