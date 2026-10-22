import { describe, expect, it } from "vitest";

import { chargeDocumentFeature, featurePages } from "../pipeline/feature-charges.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { chargeMediaMinutes } from "../media/extract.js";
import type { WorkspaceRun } from "../models.js";

const run = { id: "run-1", userId: "u1", orgId: "o1", workspaceId: "w1", stats: {}, artifacts: {}, pipeline: {}, stage: "queued" } as unknown as WorkspaceRun;

describe("optional per-document feature charges", () => {
  it("charges each feature once per document per run, priced on its pages", () => {
    const state = WorkflowState.create(run, []);
    const document = { id: "doc-1", pageCount: 23 };
    chargeDocumentFeature(state, document, "documentSummary");
    chargeDocumentFeature(state, document, "knowledgeGraph");
    chargeDocumentFeature(state, document, "knowledgeGraph"); // a retried stage: no second charge
    chargeDocumentFeature(state, document, "structuredFields");
    chargeDocumentFeature(state, document, "propositions");
    const events = state.usageLedger.snapshot();
    expect(events.map((event) => [event.id, event.metric, event.costCents])).toEqual([
      ["feature:documentSummary:run-1:doc-1", "feature-document-summary", 0.5],
      ["feature:knowledgeGraph:run-1:doc-1", "feature-knowledge-graph", 4.5],
      ["feature:structuredFields:run-1:doc-1", "feature-structured-fields", 3],
      ["feature:propositions:run-1:doc-1", "feature-propositions", 3],
    ]);
    expect(events.every((event) => event.metadata?.unitCharge === true && event.metadata?.billable === true)).toBe(true);
    expect(state.usageLedger.pendingBillableCents).toBeCloseTo(11);
  });

  it("prices a media file on its Rich-equivalent pages (minutes x factor)", () => {
    const state = WorkflowState.create(run, []);
    chargeMediaMinutes(state, "talk", "video", 30 * 60);
    expect(featurePages(state, { id: "talk", pageCount: 1 })).toBe(90);
    chargeDocumentFeature(state, { id: "talk", pageCount: 1 }, "structuredFields");
    expect(state.usageLedger.snapshot().find((event) => event.metric === "feature-structured-fields")?.costCents).toBe(9);
  });
});
