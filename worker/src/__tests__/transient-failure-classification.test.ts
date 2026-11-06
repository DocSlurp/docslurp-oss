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

  it.each([
    // F6: a statement timeout during re-authorization (PostgresError 57014), and the rest of SQLSTATE classes 08, 53 and 57.
    Object.assign(new Error("canceling statement due to statement timeout"), { name: "PostgresError", code: "57014" }),
    Object.assign(new Error("out of shared memory"), { name: "PostgresError", code: "53200" }),
    Object.assign(new Error("could not serialize access"), { name: "PostgresError", code: "40001" }),
    Object.assign(new Error("deadlock detected"), { name: "PostgresError", code: "40P01" }),
    new Error("measured pages", { cause: Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }) }),
    Object.assign(new Error("spend check for a 10.49-credit charge failed"), { name: "SpendCheckUnavailableError" }),
  ])("retries a database failure (%s) as an interruption, re-authorizing from durable state", (error) => {
    expect(classifyActivityError(error, ctx)).toBe("interruption");
  });

  it("keeps data errors from the document ordinary", () => {
    expect(classifyActivityError(Object.assign(new Error("invalid input syntax"), { name: "PostgresError", code: "22P02" }), ctx)).toBe("ordinary");
    expect(classifyActivityError(Object.assign(new Error("unique violation"), { name: "PostgresError", code: "23505" }), ctx)).toBe("ordinary");
  });
});


describe("parser sandbox failures (real-Modal F5, recheck Q #1)", () => {
  it("an infrastructure failure is an interruption, wrapped or not; a document's staging violation stays ordinary", async () => {
    const { SandboxInfrastructureError, SandboxOutputError } = await import("../sandbox/types.js");
    const notShuttingDown = { shuttingDown: () => false };
    const vm = new SandboxInfrastructureError("modal sandbox creation failed: parser VM kernel link protections could not be turned on");
    expect(classifyActivityError(vm, notShuttingDown)).toBe("interruption");
    expect(classifyActivityError(new Error("extract failed", { cause: vm }), notShuttingDown)).toBe("interruption");
    expect(classifyActivityError(new SandboxOutputError("parser VM output entry/depth limit exceeded"), notShuttingDown)).toBe("ordinary");
  });
});
