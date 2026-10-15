/**
 * Records the Temporal workflow history fixtures replayed by
 * src/__tests__/temporal-replay.test.ts.
 *
 *   pnpm --filter @docslurp/worker temporal:record-histories
 *
 * Runs the real workflows in workflows.ts on Temporal's time-skipping test
 * server (downloaded by @temporalio/testing on first use) with stubbed
 * activities, then writes each closed workflow's history to
 * worker/testdata/temporal-histories/.
 *
 * Re-record ONLY when you add a scenario, or when you intentionally break
 * compatibility AND no production workflow can still carry the old history
 * (every run started on the old code has closed: 24 h execution timeout, or
 * the fleet was drained). Re-recording to make a failing replay test pass
 * hides exactly the nondeterminism the test exists to catch; use patched()
 * instead. See docs/temporal-workflow-changes.md.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { Context } from "@temporalio/activity";
import { WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { historyToJSON } from "@temporalio/common/lib/proto-utils";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type { Activities } from "../../temporal/activities.js";
import {
  PROVIDER_RATE_LIMITED,
  WORKER_SLOT_UNAVAILABLE,
  type PipelineWorkflowInput,
  type StageInput,
  type StageOutput,
  type UsageSummary,
  type VisionPageTask,
} from "../../temporal/shared.js";
import { HISTORY_FIXTURE_DIR, WORKFLOWS_PATH, type HistoryFixture } from "./fixtures.js";

const TASK_QUEUE = "replay-fixtures";
/** Failure stack traces carry absolute paths; keep fixtures machine-independent. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const TEMPORAL_SDK_VERSION = (createRequire(import.meta.url)("@temporalio/worker/package.json") as { version: string }).version;
const usage: UsageSummary = { inputTokens: 10, outputTokens: 5, costCents: 1 };
const vision = { enabled: true } as unknown as VisionPageTask["vision"];

function pageTasks(runId: string, total: number): VisionPageTask[] {
  // Two documents so bundling has a document boundary to respect.
  const firstDocPages = Math.ceil(total / 2);
  return Array.from({ length: total }, (_, index) => {
    const documentId = index < firstDocPages ? "doc-a" : "doc-b";
    const pageNumber = index < firstDocPages ? index + 1 : index - firstDocPages + 1;
    return { runId, documentId, pageNumber, pageCount: documentId === "doc-a" ? firstDocPages : total - firstDocPages, vision };
  });
}

/** An activity-side latch the driver can wait on and release. */
function latch() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  return { release, released, reached: reachedPromise, markReached: () => reached() };
}

interface Behaviour {
  stage?: (input: StageInput, attempt: number) => Promise<StageOutput | undefined>;
  page?: (tasks: VisionPageTask[], attempt: number) => Promise<void>;
  pageTotal?: number;
  /** Stage groups: how many stages the group ran before yielding. */
  groupStagesRun?: (stageNames: string[]) => number;
}

let behaviour: Behaviour = {};

const activities: Activities = {
  async initPipelineRun() {
    return { documentIds: ["doc-a", "doc-b"], artifacts: { "doc-a:raw": "s3://fixtures/raw/doc-a.pdf", "doc-b:raw": "s3://fixtures/raw/doc-b.pdf" } };
  },
  async runPipelineStage(input: StageInput) {
    const custom = await behaviour.stage?.(input, Context.current().info.attempt);
    return custom ?? { artifacts: { [`${input.stageName}:out`]: `s3://fixtures/${input.runId}/${input.stageName}.json` }, usage, stats: {} };
  },
  async runPipelineStages(input: { stageNames: string[]; runId: string }) {
    const stagesRun = behaviour.groupStagesRun?.(input.stageNames) ?? input.stageNames.length;
    return {
      artifacts: Object.fromEntries(input.stageNames.slice(0, stagesRun).map((stage) => [`${stage}:out`, `s3://fixtures/${input.runId}/${stage}.json`])),
      usage,
      stats: {},
      stagesRun,
    };
  },
  async runPipelineStageShard() {
    return usage;
  },
  async setRunShardDemand() {},
  async completePipelineRun() {},
  async failPipelineRun() {},
  async prepareVisionPageTasks(input: StageInput) {
    return pageTasks(input.runId, behaviour.pageTotal ?? 0);
  },
  async prepareVisionPageBatches() {
    return { total: behaviour.pageTotal ?? 0 };
  },
  async loadVisionPageBatch(input: { runId: string; offset: number; limit: number }) {
    return pageTasks(input.runId, behaviour.pageTotal ?? 0).slice(input.offset, input.offset + input.limit);
  },
  async runVisionPageTask(task: VisionPageTask) {
    await behaviour.page?.([task], Context.current().info.attempt);
    return usage;
  },
  async runVisionPageBundle(tasks: VisionPageTask[]) {
    await behaviour.page?.(tasks, Context.current().info.attempt);
    return { inputTokens: usage.inputTokens * tasks.length, outputTokens: usage.outputTokens * tasks.length, costCents: usage.costCents * tasks.length };
  },
} as unknown as Activities;

function slotUnavailable(): ApplicationFailure {
  return ApplicationFailure.create({ type: WORKER_SLOT_UNAVAILABLE, message: "org fixture has 4/4 worker slots in use (org)", nonRetryable: true });
}

/** Fails `key` once, then lets it through on later calls. */
function once() {
  const seen = new Set<string>();
  return (key: string) => (seen.has(key) ? false : (seen.add(key), true));
}

interface Scenario {
  name: string;
  description: string;
  input: PipelineWorkflowInput;
  behaviour: () => Behaviour;
  /** Number of page-batch child workflows the run starts (recorded too). */
  children?: number;
  drive?: (handle: WorkflowHandle, current: Behaviour & { latches?: ReturnType<typeof latch>[] }) => Promise<void>;
  expect: "completed" | "failed" | "cancelled";
}

const pipeline = {} as PipelineWorkflowInput["pipeline"];

const scenarios: Scenario[] = [
  {
    name: "legacy-stages-success",
    description: "Pre-slot-gating input (no scaling fields): sequential stages on the legacy activity proxies.",
    input: { runId: "fixture-legacy", pipeline, stageOrder: ["quarantine", "format-detect", "extract-markdown", "embed", "index"] },
    behaviour: () => ({}),
    expect: "completed",
  },
  {
    name: "legacy-page-fanout-bundled",
    description: "Legacy in-workflow vision page fan-out with page bundles (pageConcurrency without pageChildBatchSize).",
    input: { runId: "fixture-legacy-pages", pipeline, stageOrder: ["split-pages", "vision-extract", "embed"], pageConcurrency: 4, pageBundleSize: 2 },
    behaviour: () => ({ pageTotal: 7 }),
    expect: "completed",
  },
  {
    name: "production-default-stages",
    description: "Current production input shape: every default stage, slot gate, page children of 500, page concurrency 8.",
    input: { runId: "fixture-production", pipeline, pageConcurrency: 8, pageBundleSize: 1, slotGate: true, pageChildBatchSize: 500 },
    behaviour: () => ({ pageTotal: 3 }),
    children: 1,
    expect: "completed",
  },
  {
    name: "production-default-stages-page-router",
    description:
      "Current production input without an explicit stageOrder, recorded after the route-pages stage landed: " +
      "the patched('page-router-stage') marker keeps the stage in the fallback order for new runs.",
    input: { runId: "fixture-production-page-router", pipeline, pageConcurrency: 8, pageBundleSize: 1, slotGate: true, pageChildBatchSize: 500 },
    behaviour: () => ({ pageTotal: 3 }),
    children: 1,
    expect: "completed",
  },
  {
    name: "slot-gated-children-retries",
    description:
      "Slot-gated run with two page-batch children: slot denials (workflow back-off timers) on a stage and a page bundle, " +
      "a provider-throttled page retried with nextRetryDelay, and an ordinary stage error retried by Temporal.",
    input: {
      runId: "fixture-slot-retries", pipeline, stageOrder: ["split-pages", "render-images", "vision-extract", "embed", "index"],
      pageConcurrency: 8, pageBundleSize: 2, slotGate: true, pageChildBatchSize: 50,
    },
    behaviour: () => {
      const first = once();
      return {
        pageTotal: 70,
        async stage(input) {
          if (input.stageName === "render-images" && first("render-images")) throw new Error("transient storage timeout");
          if (input.stageName === "embed" && first("embed")) throw slotUnavailable();
          return undefined;
        },
        async page(tasks) {
          const key = `${tasks[0]!.documentId}:${tasks[0]!.pageNumber}`;
          if (key === "doc-a:3" && first(key)) throw slotUnavailable();
          if (key === "doc-b:5" && first(key)) {
            throw ApplicationFailure.create({ type: PROVIDER_RATE_LIMITED, message: "provider 429", nonRetryable: false, nextRetryDelay: "2s" });
          }
        },
      };
    },
    children: 2,
    expect: "completed",
  },
  {
    name: "grouped-light-stages-sharded",
    description:
      "Production input before WORKER_INDEX_BEFORE_ENRICH / groupableStages: groupLightStages groups quarantine..normalize, " +
      "pdf-tooling and split-pages run alone, and shardable stages fan out to two document shards.",
    input: {
      runId: "fixture-grouped-light", pipeline,
      stageOrder: [
        "quarantine", "format-detect", "to-canonical", "format-tooling", "normalize", "pdf-tooling", "split-pages",
        "extract-markdown", "classify-route", "render-images", "vision-extract", "document-summary", "embed", "index",
      ],
      pageConcurrency: 8, pageBundleSize: 1, slotGate: true, pageChildBatchSize: 500,
      documentSharding: { minDocsPerShard: 1, maxShards: 2, minPagesPerShard: 1 }, groupLightStages: true,
    },
    behaviour: () => ({ pageTotal: 3 }),
    children: 1,
    expect: "completed",
  },
  {
    name: "grouped-adjacent-stages-index-first",
    description:
      "WORKER_GROUP_ADJACENT_STAGES + WORKER_INDEX_BEFORE_ENRICH input: groupableStages groups adjacent stages around the " +
      "sharded and page fan-out stages, the first group yields once to a pause request (stagesRun), and index runs before " +
      "document-summary.",
    input: {
      runId: "fixture-grouped-adjacent", pipeline,
      stageOrder: [
        "quarantine", "format-detect", "to-canonical", "format-tooling", "normalize", "pdf-tooling", "split-pages",
        "extract-markdown", "classify-route", "render-images", "vision-extract", "embed", "index", "document-summary",
      ],
      pageConcurrency: 8, pageBundleSize: 1, slotGate: true, pageChildBatchSize: 500,
      documentSharding: { minDocsPerShard: 1, maxShards: 2, minPagesPerShard: 1 }, groupLightStages: true,
      groupableStages: [
        "quarantine", "format-detect", "to-canonical", "format-tooling", "normalize", "pdf-tooling", "split-pages",
        "extract-markdown", "extract-html", "classify-route", "route-pages", "render-images", "vision-extract", "pii-detect",
        "document-summary", "structured-extract", "embed", "graph-enrich", "page-index", "proposition-index", "index",
      ],
    },
    behaviour: () => {
      const first = once();
      return { pageTotal: 3, groupStagesRun: (stageNames: string[]) => (first("group") ? 2 : stageNames.length) };
    },
    children: 1,
    expect: "completed",
  },
  {
    name: "stage-failure",
    description: "A non-retryable stage error: failPipelineRun runs and the workflow fails.",
    input: { runId: "fixture-stage-failure", pipeline, stageOrder: ["quarantine", "extract-markdown", "embed"], slotGate: true, pageChildBatchSize: 500 },
    behaviour: () => ({
      async stage(input) {
        if (input.stageName === "extract-markdown") throw ApplicationFailure.create({ message: "corrupt document", nonRetryable: true });
        return undefined;
      },
    }),
    expect: "failed",
  },
  {
    name: "pause-resume-cancel-signals",
    description: "Pause and resume signals between stages, a progress query, then the cancel signal (user cancel).",
    input: { runId: "fixture-signals", pipeline, stageOrder: ["quarantine", "format-detect", "extract-markdown", "embed"], slotGate: true, pageChildBatchSize: 500 },
    behaviour: () => {
      const latches = [latch(), latch()];
      return {
        latches,
        async stage(input) {
          const index = input.stageName === "quarantine" ? 0 : input.stageName === "format-detect" ? 1 : -1;
          if (index >= 0) {
            latches[index]!.markReached();
            await latches[index]!.released;
          }
          return undefined;
        },
      } as Behaviour;
    },
    async drive(handle, current) {
      const [first, second] = current.latches!;
      await first!.reached;
      await handle.signal("pause");
      first!.release();
      await handle.query("progress");
      await handle.signal("resume");
      await second!.reached;
      await handle.signal("cancel");
      second!.release();
    },
    expect: "failed",
  },
  {
    name: "temporal-cancel-mid-stage",
    description: "Temporal cancellation (handle.cancel) while a heartbeating stage runs: the stage observes the cancel and failPipelineRun runs non-cancellable.",
    input: { runId: "fixture-cancel", pipeline, stageOrder: ["quarantine", "extract-markdown", "embed"], slotGate: true, pageChildBatchSize: 500 },
    behaviour: () => {
      const started = latch();
      return {
        latches: [started],
        async stage(input) {
          if (input.stageName !== "extract-markdown") return undefined;
          started.markReached();
          const context = Context.current();
          for (;;) {
            context.heartbeat();
            await context.sleep(50);
          }
        },
      } as Behaviour;
    },
    async drive(handle, current) {
      await current.latches![0]!.reached;
      await handle.cancel();
    },
    expect: "cancelled",
  },
];

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const selected = only.length > 0 ? scenarios.filter((scenario) => only.includes(scenario.name)) : scenarios;
  if (selected.length === 0) throw new Error(`No scenario matches ${only.join(", ")}`);

  const env = await TestWorkflowEnvironment.createTimeSkipping();
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUE,
      workflowsPath: WORKFLOWS_PATH,
      activities,
      // Deliver cancellation to heartbeating stubs promptly.
      maxHeartbeatThrottleInterval: "100ms",
      defaultHeartbeatThrottleInterval: "100ms",
    });

    mkdirSync(HISTORY_FIXTURE_DIR, { recursive: true });
    if (only.length === 0) {
      for (const file of readdirSync(HISTORY_FIXTURE_DIR)) if (file.endsWith(".json")) rmSync(`${HISTORY_FIXTURE_DIR}${file}`);
    }

    await worker.runUntil(async () => {
      for (const scenario of selected) {
        const current = scenario.behaviour() as Behaviour & { latches?: ReturnType<typeof latch>[] };
        behaviour = current;
        const workflowId = `run-${scenario.input.runId}`;
        const handle = await env.client.workflow.start("documentPipeline", {
          taskQueue: TASK_QUEUE,
          workflowId,
          args: [scenario.input],
          workflowExecutionTimeout: "24 hours",
        });
        const driving = scenario.drive?.(handle, current);
        let outcome: Scenario["expect"] = "completed";
        try {
          await handle.result();
        } catch (error) {
          if (!(error instanceof WorkflowFailedError)) throw error;
          outcome = error.cause?.name === "CancelledFailure" ? "cancelled" : "failed";
        }
        await driving;
        if (outcome !== scenario.expect) throw new Error(`${scenario.name}: expected ${scenario.expect}, got ${outcome}`);

        const runId = handle.firstExecutionRunId;
        const recorded: Array<{ workflowId: string; workflowType: string; suffix: string }> = [
          { workflowId, workflowType: "documentPipeline", suffix: "" },
          ...Array.from({ length: scenario.children ?? 0 }, (_, index) => ({
            workflowId: `${workflowId}-pages-${runId.slice(0, 8)}-${index}`,
            workflowType: "visionPageBatch",
            suffix: `.child-${index}`,
          })),
        ];
        for (const entry of recorded) {
          const history = await env.client.workflow.getHandle(entry.workflowId).fetchHistory();
          const fixture: HistoryFixture = {
            scenario: scenario.name,
            description: scenario.description,
            workflowType: entry.workflowType,
            workflowId: entry.workflowId,
            recordedWith: { temporalSdk: TEMPORAL_SDK_VERSION, server: "temporal-test-server (time-skipping)" },
            history: JSON.parse(historyToJSON(history).replaceAll(REPO_ROOT, "<repo>/")),
          };
          const file = `${HISTORY_FIXTURE_DIR}${scenario.name}${entry.suffix}.json`;
          writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
          console.log(`[replay-fixtures] wrote ${file} events=${history.events?.length ?? 0} outcome=${outcome}`);
        }
      }
    });
  } finally {
    await env.teardown();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
