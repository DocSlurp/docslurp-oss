import { afterEach, expect, it, vi } from "vitest";

const signal = vi.fn();
const query = vi.fn();
const describe = vi.fn();
const withDeadline = vi.fn(async (_deadline: number, fn: () => Promise<unknown>) => fn());
vi.mock("@temporalio/client", () => ({
  Connection: { connect: vi.fn(async () => ({ withDeadline })) },
  Client: class {
    connection = { withDeadline };
    workflow = { getHandle: () => ({ query, describe, signal }) };
  },
}));
const { queryPipelineProgress, describePipelineWorkflow, signalPipelineResume } = await import("../lib/temporal.js");

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

it("bounds the actual resume RPC to five seconds by default", async () => {
  const start = Date.now();
  await signalPipelineResume("run-resume");
  expect(signal).toHaveBeenCalledWith("resume");
  expect(withDeadline.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(start + 5_000);
  expect(withDeadline.mock.calls[0]?.[0]).toBeLessThanOrEqual(start + 5_100);
});
