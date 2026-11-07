import { describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { assertExecutionOwnership, StaleExecutionError } from "../db/execution-ownership.js";

describe("execution ownership fence", () => {
  const owner = { runId: "run", orgId: "org", projectId: "project" };
  function transaction(generation: string | null) {
    return (async (_parts: TemplateStringsArray, ...values: unknown[]) =>
      values[0] === owner.runId && values[1] === owner.orgId && values[2] === owner.projectId &&
      values[3] === generation ? [{ id: owner.runId }] : []) as unknown as TransactionSql;
  }
  it("accepts repeated activities from the same intent", async () => {
    for (let i = 0; i < 2; i++) await expect(assertExecutionOwnership(transaction("new"), { ...owner, executionGeneration: "new" })).resolves.toBeUndefined();
  });
  it("rejects delayed old init and terminal activities after a new intent", async () => {
    await expect(assertExecutionOwnership(transaction("new"), { ...owner, executionGeneration: "old" })).rejects.toBeInstanceOf(StaleExecutionError);
  });
  it("permits legacy only on an unowned row", async () => {
    await expect(assertExecutionOwnership(transaction(null), owner)).resolves.toBeUndefined();
    await expect(assertExecutionOwnership(transaction("new"), owner)).rejects.toBeInstanceOf(StaleExecutionError);
    await expect(assertExecutionOwnership(transaction(null), { ...owner, executionGeneration: "new" })).rejects.toBeInstanceOf(StaleExecutionError);
  });
  it.each(["orgId", "projectId", "runId"] as const)("rejects another %s", async key => {
    await expect(assertExecutionOwnership(transaction("new"), { ...owner, executionGeneration: "new", [key]: "other" })).rejects.toBeInstanceOf(StaleExecutionError);
  });
});
