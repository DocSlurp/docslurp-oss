import { afterEach, expect, it, vi } from "vitest";

const query = vi.fn();
const describe = vi.fn();
const withDeadline = vi.fn(async (_deadline: number, fn: () => Promise<unknown>) => fn());
vi.mock("@temporalio/client", () => ({
  Connection: { connect: vi.fn(async () => ({ withDeadline })) },
  Client: class {
    connection = { withDeadline };
    workflow = { getHandle: () => ({ query, describe }) };
  },
}));
const { queryPipelineProgress, describePipelineWorkflow } = await import("../lib/temporal.js");

afterEach(() => vi.clearAllMocks());

it("bounds worker progress queries and falls back when workers are unavailable", async () => {
  withDeadline.mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
  query.mockResolvedValue({ stage: "embed" });
  const start = Date.now();
  expect(await queryPipelineProgress("run-1")).toBeNull();
  const deadline = withDeadline.mock.calls[0]?.[0];
  expect(deadline).toBeGreaterThanOrEqual(start);
  expect(deadline).toBeLessThanOrEqual(start + 2_500);
});

it("bounds workflow descriptions and retains available progress", async () => {
  query.mockResolvedValue({ stage: "embed", stageIndex: 11, totalStages: 13 });
  expect(await queryPipelineProgress("run-1")).toMatchObject({ stage: "embed" });
  withDeadline.mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
  expect(await describePipelineWorkflow("run-1")).toBeNull();
  expect(withDeadline).toHaveBeenCalledTimes(2);
});
