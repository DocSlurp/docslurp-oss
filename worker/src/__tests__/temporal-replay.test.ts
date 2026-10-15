/**
 * Replay safety gate for rolling worker deploys (docs/temporal-workflow-changes.md).
 *
 * Replays recorded workflow histories (worker/testdata/temporal-histories)
 * against the current workflows.ts. A failure here means a workflow change
 * would throw a NondeterminismError for runs already in flight when the new
 * worker image rolls out. Guard the change with patched() instead of
 * re-recording the fixtures.
 */

import { fileURLToPath } from "node:url";

import { Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";

import { WORKFLOWS_PATH, loadHistoryFixtures } from "../test/temporal-replay/fixtures.js";

const fixtures = loadHistoryFixtures();

describe("Temporal workflow replay safety", () => {
  it("has recorded histories for the main run paths", () => {
    const scenarios = new Set(fixtures.map((fixture) => fixture.scenario));
    for (const scenario of [
      "legacy-stages-success",
      "legacy-page-fanout-bundled",
      "production-default-stages",
      "grouped-light-stages-sharded",
      "grouped-adjacent-stages-index-first",
      "slot-gated-children-retries",
      "stage-failure",
      "pause-resume-cancel-signals",
      "temporal-cancel-mid-stage",
    ]) {
      expect(scenarios, `missing fixture scenario ${scenario}`).toContain(scenario);
    }
    expect(fixtures.some((fixture) => fixture.workflowType === "visionPageBatch")).toBe(true);
  });

  it("replays every recorded history against the current workflow code", async () => {
    const results = Worker.runReplayHistories(
      { workflowsPath: WORKFLOWS_PATH, replayName: "docslurp-replay" },
      fixtures.map((fixture) => ({ workflowId: fixture.workflowId, history: fixture.history })),
    );
    const failures: string[] = [];
    let replayed = 0;
    for await (const result of results) {
      replayed += 1;
      if (result.error) {
        const fixture = fixtures.find((candidate) => candidate.workflowId === result.workflowId);
        failures.push(`${fixture?.file ?? result.workflowId}: ${result.error.name}: ${result.error.message}`);
      }
    }
    expect(failures, `Replay failed. Guard the workflow change with patched() (docs/temporal-workflow-changes.md):\n${failures.join("\n")}`).toEqual([]);
    expect(replayed).toBe(fixtures.length);
  }, 180_000);

  it("detects a nondeterministic workflow change", async () => {
    const fixture = fixtures.find((candidate) => candidate.scenario === "legacy-stages-success")!;
    await expect(
      Worker.runReplayHistory(
        {
          workflowsPath: fileURLToPath(new URL("../test/temporal-replay/nondeterministic-workflows.ts", import.meta.url)),
          replayName: "docslurp-replay-mutant",
        },
        fixture.history,
        fixture.workflowId,
      ),
    ).rejects.toMatchObject({ name: "DeterminismViolationError" });
  }, 180_000);
});
