import { describe, expect, it } from "vitest";

import { classifyActivityError } from "../temporal/failure-classification.js";

describe("transient infrastructure errors are not document failures", () => {
  const ctx = { shuttingDown: () => false };

  it.each([
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
    new Error("Connection terminated unexpectedly"),
    new Error("stage failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }) }),
  ])("retries %s without spending an ordinary attempt", (error) => {
    expect(classifyActivityError(error, ctx)).toBe("interruption");
  });

  it("still counts genuine document failures and bare timeouts as ordinary", () => {
    expect(classifyActivityError(new Error("unsupported PDF structure"), ctx)).toBe("ordinary");
    expect(classifyActivityError(new Error("parser timed out on page 3"), ctx)).toBe("ordinary");
  });
});
