import { BILLABLE_UNIT_METRICS } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

import { WorkflowState } from "../pipeline/pipeline.js";
import { RICH_PAGE_READ_METRICS } from "../pipeline/usage-ledger.js";
import type { ProjectRun } from "../models.js";

const run = { id: "run-1", userId: "u1", orgId: "o1", projectId: "w1", stats: {}, artifacts: {}, pipeline: {}, stage: "queued" } as unknown as ProjectRun;

/** What vision-extract's recordLocalUsage writes for a local model's call on a page. */
function localRead(state: WorkflowState, metric: string, pageNumber: number) {
  state.usageLedger.record({
    provider: "vision-runtime", model: metric === "image-label" ? "florence-2-base" : "ppocr-v6-small", metric, amount: 1, unit: "image",
    costCents: 0, inputTokens: 0, outputTokens: 0,
    metadata: { documentId: "d1", pageNumber, runtime: "local-cli", latencyMs: 40, outputChars: 32 },
  });
}

describe("a local photo caption does not make a page Rich", () => {
  it("charges no Rich page for a caption; an OCR read of the page still does", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(RICH_PAGE_READ_METRICS.has("image-label")).toBe(false);
    const state = WorkflowState.create(run, []);
    localRead(state, "image-label", 3); // a caption of a photo on page 3: the page's text was not read by a model
    localRead(state, "page-ocr", 4); // page 4 was OCR'd
    const events = state.usageLedger.checkpoint().events;
    const rich = events.filter((event) => event.metric === BILLABLE_UNIT_METRICS.richPage);
    expect(rich.map((event) => event.metadata?.pageNumber)).toEqual([4]);
  });
});
