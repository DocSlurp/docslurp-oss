import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded: Array<{ name: string; value: number; labels: Record<string, string>; kind: string }> = [];
vi.mock("@docslurp/shared/observability", () => ({
  pageCountBucket: (pages: number) => pages < 1 ? "unknown" : pages === 1 ? "1" : pages <= 10 ? "2-10" : pages <= 100 ? "11-100" : pages <= 1000 ? "101-1000" : "1001+",
  recordPipelineTelemetry: (name: string, value: number, labels: Record<string, string> = {}, kind = "counter") => {
    recorded.push({ name, value, labels, kind });
  },
}));

const {
  finalPageStage, noteDocumentStageComplete, noteRunMilestone, noteRunOutcome, noteRunPageStage, recordPagesRouted, recordRunOutcome,
  resetRunMilestoneMemory, workerStartKind,
} = await import("../pipeline/run-milestones.js");
const { defaultPipelineFeatures: DEFAULT_PIPELINE } = await import("@docslurp/shared");

function fakeStore(hits: Partial<Record<string, { seconds: number; pages: number } | null>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    async markRunMilestone(runId: string, milestone: string) {
      calls.push(`${runId}:${milestone}`);
      return milestone in hits ? hits[milestone]! : { seconds: 4, pages: 12 };
    },
  };
}

function state(store: ReturnType<typeof fakeStore>, runId = "run-1") {
  return { run: { id: runId, pipeline: DEFAULT_PIPELINE, createdAt: new Date(Date.now() - 30_000), pagesTotal: 12 }, store } as never;
}

beforeEach(() => { recorded.length = 0; resetRunMilestoneMemory(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("run milestones", () => {
  it("picks the last page-checkpointing stage of the plan, ignoring reused stages", () => {
    expect(finalPageStage(["split-pages", "extract-markdown", "embed", "index"])).toBe("embed");
    expect(finalPageStage(["split-pages", "extract-markdown", "embed", "index"], ["embed"])).toBe("extract-markdown");
    expect(finalPageStage(["format-detect", "index"])).toBeNull();
  });

  it("records a milestone once per process and only when the store stamped it", async () => {
    const store = fakeStore();
    await noteRunMilestone(store, "run-1", "worker_started", { start: "cold" });
    await noteRunMilestone(store, "run-1", "worker_started", { start: "cold" });
    expect(store.calls).toEqual(["run-1:worker_started"]);
    expect(recorded).toEqual([{ name: "run.milestone.duration", value: 4, labels: { milestone: "worker_started", start: "cold" }, kind: "duration" }]);

    recorded.length = 0;
    const already = fakeStore({ worker_started: null });
    await noteRunMilestone(already, "run-2", "worker_started");
    expect(already.calls).toHaveLength(1);
    expect(recorded).toEqual([]);
  });

  it("never throws when the stamp fails, logs no error text, and tries again later", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let calls = 0;
    const store = { async markRunMilestone() { calls += 1; if (calls === 1) throw new Error("connection lost: secret-dsn"); return { seconds: 9, pages: 3 }; } };
    await expect(noteRunMilestone(store, "run-1", "first_page_extracted")).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("secret-dsn");
    await noteRunMilestone(store, "run-1", "first_page_extracted");
    await noteRunMilestone(store, "run-1", "first_page_extracted");
    expect(calls).toBe(2);
    expect(recorded).toHaveLength(1);
  });

  it("records a run's outcome only for the caller that stamped it", async () => {
    const run = { id: "run-9", createdAt: new Date(Date.now() - 60_000), pagesTotal: 8 };
    await noteRunOutcome(fakeStore(), run, "completed");
    await noteRunOutcome(fakeStore({ outcome_recorded: null }), run, "failed", "embed");
    await noteRunOutcome(undefined, run, "failed", "embed");
    expect(recorded.filter((entry) => entry.name === "run.outcomes").map((entry) => entry.labels)).toEqual([{ outcome: "completed", pages: "2-10" }]);
  });

  it("stamps first-extracted on an extraction stage and first-completed on the plan's last page stage", async () => {
    const store = fakeStore();
    await noteRunPageStage(state(store), "split-pages");
    expect(store.calls).toEqual([]);
    await noteRunPageStage(state(store), "extract-markdown");
    expect(store.calls).toEqual(["run-1:first_page_extracted"]);
    const { compilePipelinePlan } = await import("@docslurp/shared");
    const final = finalPageStage(compilePipelinePlan(DEFAULT_PIPELINE).stageOrder)!;
    await noteRunPageStage(state(store), final);
    expect(store.calls).toContain("run-1:first_page_completed");
  });

  it("closes both page milestones when a document is indexed and records document milestones from run acceptance", async () => {
    const store = fakeStore();
    await noteDocumentStageComplete(state(store), "embed", 250);
    expect(store.calls).toEqual([]);
    await noteDocumentStageComplete(state(store), "index", 250);
    expect(store.calls).toEqual(["run-1:first_page_extracted", "run-1:first_page_completed"]);
    const documents = recorded.filter((entry) => entry.name === "document.milestone.duration");
    expect(documents.map((entry) => entry.labels)).toEqual([{ milestone: "embedded", pages: "101-1000" }, { milestone: "indexed", pages: "101-1000" }]);
    expect(documents[0]!.value).toBeGreaterThanOrEqual(30);
    await noteDocumentStageComplete(state(store), "summary-tree", 250);
    expect(recorded.filter((entry) => entry.name === "document.milestone.duration")).toHaveLength(2);
  });

  it("records run outcomes with bounded labels and throughput only for runs that completed", () => {
    recordRunOutcome({ createdAt: new Date(Date.now() - 120_000), pagesTotal: 600 }, "completed");
    recordRunOutcome({ createdAt: new Date(Date.now() - 120_000), pagesTotal: 600 }, "failed", "run 8f2c customer.pdf");
    expect(recorded.filter((entry) => entry.name === "run.outcomes").map((entry) => entry.labels)).toEqual([
      { outcome: "completed", pages: "101-1000" },
      { outcome: "failed", pages: "101-1000", stage: "other" },
    ]);
    const rates = recorded.filter((entry) => entry.name === "run.pages_per_minute");
    expect(rates).toHaveLength(1);
    expect(rates[0]!.value).toBeGreaterThan(290);
    expect(rates[0]!.value).toBeLessThanOrEqual(300);
  });

  it("skips empty route counts and collapses unbounded reasons", () => {
    recordPagesRouted("read", "raster", 0);
    recordPagesRouted("read", "Customer Name Ltd", 3);
    expect(recorded).toEqual([{ name: "pages.routed", value: 3, labels: { route: "read", reason: "other" }, kind: "counter" }]);
  });

  it("calls a young worker process a cold start", () => {
    expect(workerStartKind(5)).toBe("cold");
    expect(workerStartKind(3_600)).toBe("warm");
  });
});
