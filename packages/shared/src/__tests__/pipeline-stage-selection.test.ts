import { describe, expect, it } from "vitest";

import {
  compilePipelinePlan,
  defaultPipelineFeatures,
  findMissingReuseInputs,
  getPipelineStageOrder,
  pipelineFeaturesSchema,
  reprocessRunSchema,
  withoutStageSelection,
} from "../index.js";

describe("partial pipeline plans", () => {
  it("runs every enabled stage and reuses nothing without a selection", () => {
    const plan = compilePipelinePlan(defaultPipelineFeatures);
    expect(plan.reusedStages).toEqual([]);
    expect(plan.addedStages).toEqual([]);
    expect(plan.stageOrder[0]).toBe("quarantine");
    expect(plan.stageOrder.at(-1)).toBe("index");
  });

  it("restartFromStage runs that stage onward and reuses the earlier ones", () => {
    const full = getPipelineStageOrder(defaultPipelineFeatures);
    const plan = compilePipelinePlan({ ...defaultPipelineFeatures, restartFromStage: "embed" });

    expect(plan.stageOrder).toEqual(["embed", "index"]);
    expect(plan.reusedStages).toEqual(full.slice(0, full.indexOf("embed")));
    expect(plan.addedStages).toEqual([]);
    expect(plan.phases.map((phase) => phase.key)).toEqual(["index"]);
  });

  it("restartFromStage on a disabled stage starts at the next enabled one", () => {
    // extract-html is disabled by default.
    const plan = compilePipelinePlan({ ...defaultPipelineFeatures, restartFromStage: "extract-html" });
    expect(plan.stageOrder[0]).toBe("classify-route");
    expect(plan.reusedStages).toContain("extract-markdown");
  });

  it("stageSubset runs exactly the selected stages", () => {
    const plan = compilePipelinePlan({ ...defaultPipelineFeatures, stageSubset: ["embed", "index"] });
    expect(plan.stageOrder).toEqual(["embed", "index"]);
    expect(plan.addedStages).toEqual([]);
    expect(plan.reusedStages).toContain("extract-markdown");
    expect(plan.reusedStages).not.toContain("embed");
  });

  it("adds hard dependencies and always-rerun stages explicitly", () => {
    const plan = compilePipelinePlan({
      ...defaultPipelineFeatures,
      summarize: true,
      piiPolicy: { ...defaultPipelineFeatures.piiPolicy, enabled: true },
      stageSubset: ["document-summary"],
    });

    expect(plan.stageOrder).toEqual(["pii-detect", "document-summary", "embed", "index"]);
    expect(plan.addedStages.map((added) => added.stage).sort()).toEqual(["embed", "index", "pii-detect"]);
  });

  it("re-runs every enabled downstream consumer of a re-run stage's outputs, transitively", () => {
    const plan = compilePipelinePlan({
      ...defaultPipelineFeatures,
      summarize: true,
      pageIndex: true,
      stageSubset: ["extract-markdown"],
    });

    expect(plan.stageOrder).toEqual([
      "extract-markdown",
      "classify-route",
      "render-images",
      "vision-extract",
      "document-summary",
      "embed",
      "page-index",
      "index",
    ]);
    const reasons = Object.fromEntries(plan.addedStages.map((added) => [added.stage, added.reason]));
    expect(reasons["classify-route"]).toContain("extract-markdown");
    // Transitive: render-images reads classification, which classify-route rewrites.
    expect(reasons["render-images"]).toContain("classify-route");
    expect(reasons["document-summary"]).toContain("extract-markdown");
    // Untouched earlier stages stay reused.
    expect(plan.reusedStages).toEqual(
      expect.arrayContaining(["quarantine", "format-detect", "split-pages"]),
    );
    expect(plan.reusedStages).not.toContain("document-summary");
  });

  it("keeps stages whose inputs did not change reused", () => {
    const plan = compilePipelinePlan({
      ...defaultPipelineFeatures,
      summarize: true,
      propositionIndex: true,
      stageSubset: ["document-summary"],
    });
    expect(plan.stageOrder).toEqual(["document-summary", "embed", "index"]);
    expect(plan.reusedStages).toContain("proposition-index");
  });

  it("re-runs page-index when embed rewrites the chunks it links", () => {
    const plan = compilePipelinePlan({ ...defaultPipelineFeatures, pageIndex: true, stageSubset: ["index"] });
    expect(plan.stageOrder).toEqual(["embed", "page-index", "index"]);
    expect(plan.addedStages.find((added) => added.stage === "page-index")?.reason).toContain("embed");
  });

  it("cascades from PII redaction, which rewrites the extracted text", () => {
    const pii = { ...defaultPipelineFeatures.piiPolicy, enabled: true };
    const flagOnly = compilePipelinePlan({
      ...defaultPipelineFeatures,
      summarize: true,
      piiPolicy: { ...pii, action: "flag_for_review" },
      stageSubset: ["index"],
    });
    expect(flagOnly.stageOrder).toEqual(["pii-detect", "embed", "index"]);

    const redacting = compilePipelinePlan({
      ...defaultPipelineFeatures,
      summarize: true,
      piiPolicy: { ...pii, action: "redact_artifacts" },
      stageSubset: ["index"],
    });
    expect(redacting.stageOrder).toEqual(["pii-detect", "document-summary", "embed", "index"]);
  });

  it("restarting at index pulls embed back in", () => {
    const plan = compilePipelinePlan({ ...defaultPipelineFeatures, restartFromStage: "index" });
    expect(plan.stageOrder).toEqual(["embed", "index"]);
    expect(plan.addedStages).toEqual([
      expect.objectContaining({ stage: "embed" }),
    ]);
  });

  it("ignores selected stages the pipeline disables", () => {
    const plan = compilePipelinePlan({
      ...defaultPipelineFeatures,
      embed: false,
      indexVectors: false,
      stageSubset: ["embed"],
    });
    expect(plan.stageOrder).toEqual([]);

    // Forced stages do not run on their own when nothing requested is enabled.
    const disabledOnly = compilePipelinePlan({ ...defaultPipelineFeatures, stageSubset: ["page-index"] });
    expect(disabledOnly.stageOrder).toEqual([]);
    expect(disabledOnly.addedStages).toEqual([]);
  });

  it("rejects unknown subset stages and combined selections", () => {
    expect(pipelineFeaturesSchema.safeParse({ stageSubset: ["embed", "nope"] }).success).toBe(false);
    expect(pipelineFeaturesSchema.safeParse({ stageSubset: [] }).success).toBe(false);
    expect(
      pipelineFeaturesSchema.safeParse({ restartFromStage: "embed", stageSubset: ["index"] }).success,
    ).toBe(false);
    expect(reprocessRunSchema.safeParse({ stages: ["embed"], stageFrom: "embed" }).success).toBe(false);
    expect(reprocessRunSchema.safeParse({ stageFrom: "completed" }).success).toBe(false);
    expect(reprocessRunSchema.safeParse({ stages: ["embed", "index"] }).success).toBe(true);
  });

  it("reports executed stages whose inputs the source document lacks", () => {
    const plan = compilePipelinePlan({ ...defaultPipelineFeatures, restartFromStage: "embed" });
    expect(findMissingReuseInputs(plan, new Set(["markdown"]))).toEqual([]);
    expect(findMissingReuseInputs(plan, new Set(["canonical-document"]))).toEqual([]);
    expect(findMissingReuseInputs(plan, new Set(["images"]))).toEqual([
      { stage: "embed", anyOf: ["markdown", "canonical-document"] },
    ]);

    // Inputs produced inside the run need nothing from the source document.
    const fromExtract = compilePipelinePlan({ ...defaultPipelineFeatures, restartFromStage: "extract-markdown" });
    expect(findMissingReuseInputs(fromExtract, new Set())).toEqual([]);
  });

  it("strips the stage selection from copied features", () => {
    const stripped = withoutStageSelection({ ...defaultPipelineFeatures, restartFromStage: "embed" });
    expect("restartFromStage" in stripped).toBe(false);
    expect(compilePipelinePlan(stripped).reusedStages).toEqual([]);
  });
});
