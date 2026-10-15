/**
 * A deliberately incompatible documentPipeline: it schedules a different
 * first activity than the real workflow. temporal-replay.test.ts replays a
 * real history against it to prove the replay gate catches such changes.
 */

import { proxyActivities } from "@temporalio/workflow";

import type { Activities } from "../../temporal/activities.js";
import type { PipelineWorkflowInput, PipelineWorkflowOutput } from "../../temporal/shared.js";

const { completePipelineRun } = proxyActivities<Activities>({ startToCloseTimeout: "5 minutes" });

export async function documentPipeline(input: PipelineWorkflowInput): Promise<PipelineWorkflowOutput> {
  await completePipelineRun({ runId: input.runId });
  return { runId: input.runId, usage: { inputTokens: 0, outputTokens: 0, costCents: 0 } };
}
