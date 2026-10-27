import { describe, expect, it } from "vitest";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";

const { graphJobPublicError } = await import("../services/workspace-graph.js");

describe("graphJobPublicError", () => {
  it("never returns the worker's failure text", () => {
    expect(graphJobPublicError("failed", "TypeError: cannot read 'x' of undefined at /app/worker/dist/graph.js:12")).toBe(PUBLIC_ERROR_MESSAGES.graphRebuildFailed);
  });

  it("keeps the worker's fixed cancellation notes and drops anything else on a cancelled job", () => {
    expect(graphJobPublicError("cancelled", "Cancelled by request")).toBe("Cancelled by request");
    expect(graphJobPublicError("cancelled", "Stopped at the $12.50 cost cap")).toBe("Stopped at the $12.50 cost cap");
    expect(graphJobPublicError("cancelled", "connect ECONNREFUSED 10.0.0.4:5432")).toBeNull();
  });

  it("has no error while running or done", () => {
    expect(graphJobPublicError("running", null)).toBeNull();
    expect(graphJobPublicError("completed", "stale text")).toBeNull();
  });
});
