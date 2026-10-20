import { describe, expect, it } from "vitest";

import { materializeWorkflowId } from "./deferred-indexing.js";

describe("materializeWorkflowId", () => {
  it("is order- and duplicate-insensitive and deterministic", () => {
    expect(materializeWorkflowId("d1", [3, 1, 2, 2])).toBe(materializeWorkflowId("d1", [1, 2, 3]));
    expect(materializeWorkflowId("d1", [1, 2, 3])).toMatch(/^materialize:d1:[0-9a-z]+$/);
  });
  it("differs by page set and document", () => {
    expect(materializeWorkflowId("d1", [1, 2])).not.toBe(materializeWorkflowId("d1", [1, 3]));
    expect(materializeWorkflowId("d1", [1, 2])).not.toBe(materializeWorkflowId("d2", [1, 2]));
  });
});
