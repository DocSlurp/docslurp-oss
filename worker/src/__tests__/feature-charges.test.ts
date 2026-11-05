import { describe, expect, it } from "vitest";

import { chargeDocumentFeature, chargeFeatureForTextRead, featurePages, textPagesOfText, textReadPages } from "../pipeline/feature-charges.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { chargeMediaMinutes } from "../media/extract.js";
import type { ProjectRun } from "../models.js";

const run = { id: "run-1", userId: "u1", orgId: "o1", projectId: "w1", stats: {}, artifacts: {}, pipeline: {}, stage: "queued" } as unknown as ProjectRun;

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

describe("features priced on text read", () => {
  it("bills a document's billing pages, not its page basis, and caps a layout-measured count by the text it holds", () => {
    const state = WorkflowState.create(run, []);
    // A 300-page DOCX: the page basis is 1 (its text has no page breaks), the layout engine measured 300.
    expect(featurePages(state, { id: "d", pageCount: 1, billingPages: 300, billingPagesMethod: "pdf-conversion" })).toBe(300);
    // 5,000 pages of which almost all are blank: features read text, so they price the text (2 pages), base fee still bills 5,000.
    expect(featurePages(state, { id: "d", pageCount: 1, billingPages: 5_000, billingPagesMethod: "pdf-conversion" }, { textPages: textPagesOfText("one short note\n".repeat(100)) })).toBe(1);
    expect(featurePages(state, { id: "d", pageCount: 1, billingPages: 5_000, billingPagesMethod: "pdf-conversion" }, { textPages: 40 })).toBe(40);
    // A count that is not from a layout conversion (sheet rows, text rule) is already a count of text.
    expect(featurePages(state, { id: "d", pageCount: 1, billingPages: 50, billingPagesMethod: "sheet-rows" }, { textPages: 2 })).toBe(50);
  });

  it("raises a charge to the text read and never lowers it; a repeat adds nothing, a larger read adds the difference under a new id", () => {
    const state = WorkflowState.create(run, []);
    const document = { id: "doc-1", pageCount: 1 };
    // 800,000 characters: 229 pages of text, 23 started blocks of 10 pages. By page count: 1 credit.
    chargeFeatureForTextRead(state, document, "structuredFields", { chars: 300_000, floorPages: false });
    chargeFeatureForTextRead(state, document, "structuredFields", { chars: 300_000, floorPages: false });
    chargeFeatureForTextRead(state, document, "structuredFields", { chars: 800_000 });
    chargeFeatureForTextRead(state, document, "structuredFields", { chars: 100_000 }); // a smaller read lowers nothing
    const events = state.usageLedger.snapshot();
    expect(events.map((event) => event.id)).toEqual(["feature:structuredFields:run-1:doc-1", expect.stringContaining("feature:structuredFields:run-1:doc-1:topup:")]);
    expect(events.reduce((sum, event) => sum + event.costCents, 0)).toBe(23);
    expect(textReadPages(800_000)).toBe(229);
  });

  it("weighs East Asian text three characters to one, as the text page rule does", () => {
    expect(textReadPages(3_500)).toBe(1);
    expect(textReadPages(3_500, 3_500)).toBe(3);
    expect(textPagesOfText("漢".repeat(3_500))).toBe(3);
    expect(textPagesOfText("   ")).toBe(0);
  });
});

