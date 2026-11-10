import { beforeEach, expect, it, vi } from "vitest";
import { defaultPipelineFeatures, projectRunSchema, projectRunTemporalSchema } from "@docslurp/shared";
const sql = Object.assign(vi.fn(), { json: (value: unknown) => value });
const temporal = vi.fn();
vi.mock("../db.js", () => ({ sql }));
vi.mock("../lib/temporal.js", () => ({ getPipelineTemporalSnapshot: temporal }));
const { buildRunProgressSnapshot } = await import("../services/runs.js");
const run = projectRunSchema.parse({
  id: "run-1", userId: "user-1", orgId: "org-1", projectId: "ws-1", projectName: "My documents",
  kind: "direct-upload", status: "processing", stage: "index", totalDocuments: 1,
  processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, costCents: 0, computeEstimated: false,
  pipeline: defaultPipelineFeatures, stats: {}, artifacts: {}, error: null,
  createdAt: "2026-09-30T12:00:00.000Z", updatedAt: "2026-09-30T12:00:00.000Z",
});
beforeEach(() => {
  sql.mockReset();
  sql.mockResolvedValue([]);
  temporal.mockResolvedValue(projectRunTemporalSchema.parse({
    workflowId: "run-run-1", workflowStatus: "FAILED", closeTime: "2026-09-30T12:01:00.000Z",
    queriedAt: "2026-09-30T12:02:00.000Z",
  }));
});
it("preserves persisted status and project name when observing a failed workflow", async () => {
  const snapshot = await buildRunProgressSnapshot(run, { recentEventLimit: 0 });
  expect(snapshot.run).toMatchObject({ status: "processing", projectName: "My documents" });
  expect(snapshot.temporal?.workflowStatus).toBe("FAILED");
  expect(sql.mock.calls.some(([parts]) => /update |insert |delete /i.test(parts.join("")))).toBe(false);
});
it("does not fail a newly queued retry using the previous workflow's terminal state", async () => {
  const snapshot = await buildRunProgressSnapshot({ ...run, status: "queued", updatedAt: "2026-09-30T12:02:00.000Z" }, { recentEventLimit: 0 });
  expect(snapshot.run.status).toBe("queued");
  expect(sql.mock.calls.some(([parts]) => parts.join("").includes("update project_runs"))).toBe(false);
});
