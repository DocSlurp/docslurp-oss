import { describe, expect, it } from "vitest";

import {
  applyProjectPipelineOverrides,
  defaultPipelineFeatures,
  getProjectTemplate,
  mergePipelineFeatures,
  normalizePipelineFeatures,
  pipelineFeatureOverridesSchema,
  projectAllowsWebhookEvent,
} from "../index.js";

describe("pipeline overrides", () => {
  it("keeps partial overrides partial instead of filling defaults", () => {
    const parsed = pipelineFeatureOverridesSchema.parse({ summarize: true });
    expect(parsed).toEqual({ summarize: true });
  });

  it("rejects unknown keys and invalid values", () => {
    expect(pipelineFeatureOverridesSchema.safeParse({ notAFeature: true }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ embed: false, indexVectors: true }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ outputSchema: { type: "object", required: ["missing"], properties: {} } }).success).toBe(false);
  });

  it("deep-merges nested settings and replaces outputSchema", () => {
    const base = normalizePipelineFeatures({
      piiPolicy: { enabled: true, action: "redact_artifacts", allowlistPatterns: ["ACME-\\d+"] },
      outputSchema: { type: "object", properties: { a: { type: "string" } } },
    });
    const merged = mergePipelineFeatures(base, {
      piiPolicy: { action: "block_indexing" },
      outputSchema: { type: "object", properties: { b: { type: "number" } } },
    });
    expect(merged.piiPolicy).toMatchObject({ enabled: true, action: "block_indexing", allowlistPatterns: ["ACME-\\d+"] });
    expect(merged.outputSchema).toEqual({ type: "object", properties: { b: { type: "number" } } });
  });

  it("re-applies template locks after overrides", () => {
    const template = getProjectTemplate("meeting-notes")!;
    const pipeline = applyProjectPipelineOverrides(template.pipeline, { summarize: false, pageIndex: true }, template);
    expect(pipeline.summarize).toBe(true);
    expect(pipeline.pageIndex).toBe(true);
  });

  it("gates webhook events per project", () => {
    expect(projectAllowsWebhookEvent(defaultPipelineFeatures, "run.completed")).toBe(true);
    expect(projectAllowsWebhookEvent({ webhooks: { enabled: false } }, "run.completed")).toBe(false);
    expect(projectAllowsWebhookEvent({ webhooks: { enabled: true, events: ["run.failed"] } }, "run.completed")).toBe(false);
    expect(projectAllowsWebhookEvent({ webhooks: { enabled: true, events: ["run.failed"] } }, "run.failed")).toBe(true);
    expect(projectAllowsWebhookEvent(null, "run.failed")).toBe(true);
  });
});
