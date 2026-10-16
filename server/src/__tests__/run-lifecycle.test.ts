import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: {} }));
vi.mock("../lib/temporal.js", () => ({
  startPipelineWorkflow: vi.fn(),
  signalPipelineCancel: vi.fn(),
  signalPipelinePause: vi.fn(),
  signalPipelineResume: vi.fn(),
}));

const { defaultPipelineFeatures, planRunFailure } = await import("@docslurp/shared");
const { createRunLifecycle, TEMPORAL_DEFERRED_RUN_MESSAGE } = await import("../services/run-lifecycle.js");
type SqlClient = import("../db.js").SqlClient;

const temporalDown = new Error(
  "Temporal API client could not connect to Temporal at temporal.example.invalid:7233.\noriginalError=Error: Failed to connect before the deadline",
);

// Start and retry only write the workflow-start marker; record those writes.
let queries: string[] = [];
function lifecycle(startWorkflow: (...args: unknown[]) => Promise<void>) {
  queries = [];
  const sql = (async (strings: TemplateStringsArray) => {
    queries.push(strings.join("?").replace(/\s+/g, " ").trim());
    return strings.join("?").includes("select id from workspace_runs") ? [{ id: "run-1" }] : [];
  }) as unknown as SqlClient;
  return createRunLifecycle({ sql, startWorkflow, failureThreshold: 3 });
}

const run = { id: "run-1", pipeline: defaultPipelineFeatures };

describe("Run Lifecycle start", () => {
  it("starts the workflow", async () => {
    const startWorkflow = vi.fn(async () => {});
    await expect(lifecycle(startWorkflow).start(run)).resolves.toEqual({ status: "started" });
    expect(startWorkflow).toHaveBeenCalledWith("run-1", defaultPipelineFeatures, undefined);
    expect(queries).toHaveLength(2);
  });

  it("defers the Run when Temporal is unavailable and schedules a backed-off recovery", async () => {
    const outcome = await lifecycle(vi.fn(async () => { throw temporalDown; })).start(run);
    expect(outcome).toEqual({ status: "deferred", reason: TEMPORAL_DEFERRED_RUN_MESSAGE });
    expect(queries).toHaveLength(2);
  });

  it("still reports the outcome when the start marker cannot be written", async () => {
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    const sql = (async (strings: TemplateStringsArray) => {
      if (strings.join("?").includes("select id from workspace_runs")) return [{ id: "run-1" }];
      throw new Error("db down");
    }) as unknown as SqlClient;
    const outcome = await createRunLifecycle({ sql, startWorkflow: vi.fn(async () => {}), failureThreshold: 3 }).start(run);
    expect(outcome).toEqual({ status: "started" });
  });

  it("treats an already-started workflow as running unless a restart was requested", async () => {
    const alreadyStarted = vi.fn(async () => { throw new Error("Workflow execution already started"); });
    await expect(lifecycle(alreadyStarted).start(run)).resolves.toEqual({ status: "already-started" });
    await expect(lifecycle(alreadyStarted).start(run, { restartExisting: true })).rejects.toThrow("already started");
  });

  it("surfaces other orchestration errors", async () => {
    await expect(lifecycle(vi.fn(async () => { throw new Error("bad args"); })).start(run)).rejects.toThrow("bad args");
  });
});

describe("Run Lifecycle retry", () => {
  it("restarts a deferred queued Run's workflow", async () => {
    const startWorkflow = vi.fn(async () => {});
    const outcome = await lifecycle(startWorkflow).retry({ ...run, status: "queued" });
    expect(outcome).toEqual({ status: "restarted", start: { status: "started" } });
    expect(startWorkflow).toHaveBeenCalledWith("run-1", defaultPipelineFeatures, { restartExisting: true });
  });

  it("reports deferral when a queued Run still cannot reach Temporal", async () => {
    const outcome = await lifecycle(vi.fn(async () => { throw temporalDown; })).retry({ ...run, status: "queued" });
    expect(outcome).toEqual({ status: "restarted", start: { status: "deferred", reason: TEMPORAL_DEFERRED_RUN_MESSAGE } });
  });

  it.each(["processing"] as const)("leaves a %s Run alone", async (status) => {
    const startWorkflow = vi.fn(async () => {});
    await expect(lifecycle(startWorkflow).retry({ ...run, status })).resolves.toEqual({ status: "not-retryable" });
    expect(startWorkflow).not.toHaveBeenCalled();
  });
});

describe("Run failure bookkeeping rule", () => {
  it("counts failures, bounds history, and dead-letters at the threshold", () => {
    const first = planRunFailure({ failureCount: 0, stats: { keep: 1 }, stage: "parse", message: "boom", threshold: 2 });
    expect(first).toMatchObject({ failureCount: 1, deadLettered: false, eventMessage: "boom" });
    expect(first.stats).toMatchObject({ keep: 1, deadLettered: false, lastFailure: { stage: "parse", failureCount: 1 } });

    const second = planRunFailure({ failureCount: 1, stats: first.stats, stage: "parse", message: "boom", threshold: 2 });
    expect(second).toMatchObject({ failureCount: 2, deadLettered: true });
    expect(second.eventMessage).toBe("boom (moved to dead-letter after 2 failures)");
    expect(second.stats.failureHistory).toHaveLength(2);

    let stats: Record<string, unknown> = {};
    for (let count = 0; count < 15; count += 1) {
      stats = planRunFailure({ failureCount: count, stats, stage: "s", message: "m", threshold: 99 }).stats;
    }
    expect(stats.failureHistory).toHaveLength(10);
  });
});
