import { describe, expect, it } from "vitest";

import { HUNG_WORK_MARKER, planRunFailure } from "./run-failure.js";

describe("planRunFailure", () => {
  it("dead-letters only at the poison threshold for ordinary failures", () => {
    expect(planRunFailure({ failureCount: 0, stats: {}, stage: "embed", message: "boom", threshold: 3 }).deadLettered).toBe(false);
    expect(planRunFailure({ failureCount: 2, stats: {}, stage: "embed", message: "boom", threshold: 3 }).deadLettered).toBe(true);
  });

  it("dead-letters hung work on the first failure", () => {
    const plan = planRunFailure({ failureCount: 0, stats: {}, stage: "extract-markdown", message: `${HUNG_WORK_MARKER} pdftotext exceeded 330 s`, threshold: 3 });
    expect(plan).toMatchObject({ failureCount: 1, deadLettered: true, eventPayload: { hungWork: true } });
  });
});
