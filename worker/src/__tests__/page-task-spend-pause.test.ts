import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";

import { RunPolicyError } from "../lib/document-failure.js";
import { UnfundedPagesError } from "../pipeline/page-basis.js";
import { pageTaskSpendPausedFailure } from "../temporal/activities.js";
import { PAGE_TASK_SPEND_PAUSED } from "../temporal/shared.js";

describe("a page task refused for funds", () => {
  it("becomes a typed, non-retryable failure the page fan-out requeues (never retried against a paused run)", () => {
    const refusal = new UnfundedPagesError("Credits do not cover the OCR read of 1 scanned page(s) of document d; run paused", true, 3, 0);
    for (const error of [refusal, new Error("wrapped", { cause: refusal })]) {
      const failure = pageTaskSpendPausedFailure(error);
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure).toMatchObject({ type: PAGE_TASK_SPEND_PAUSED, nonRetryable: true });
    }
  });

  it("leaves every other failure, a cost-cap stop included, to the ordinary classification", () => {
    expect(pageTaskSpendPausedFailure(new RunPolicyError("Run cost cap reached before the OCR read"))).toBeNull();
    expect(pageTaskSpendPausedFailure(new Error("provider unavailable"))).toBeNull();
  });
});
