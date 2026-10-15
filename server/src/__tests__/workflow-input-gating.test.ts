import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WORKER_CAPABILITIES, WORKER_CAPABILITY_PROTOCOL, normalizePipelineFeatures } from "@docslurp/shared";

/**
 * The capability handshake decides what new runs record in workflow input:
 * flag on + an older worker polling keeps the old input; flag on + every
 * worker new records the new behaviour.
 */
const mocks = vi.hoisted(() => ({ connect: vi.fn(async () => ({})), start: vi.fn(async () => undefined) }));
vi.mock("@temporalio/client", () => ({
  Connection: { connect: mocks.connect },
  Client: class {
    workflow = { start: mocks.start };
  },
}));
vi.mock("../db.js", () => ({ sql: vi.fn(async () => []) }));

const ENV_KEYS = ["NODE_ENV", "WORKER_CAPABILITY_GATE", "WORKER_INDEX_BEFORE_ENRICH", "WORKER_GROUP_ADJACENT_STAGES"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  Object.assign(process.env, { NODE_ENV: "development", WORKER_CAPABILITY_GATE: "on", WORKER_INDEX_BEFORE_ENRICH: "true", WORKER_GROUP_ADJACENT_STAGES: "true" });
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  const { setWorkerFleet } = await import("../services/worker-fleet.js");
  setWorkerFleet(null);
});

async function startWith(pollers: Array<{ identity: string; buildId: string }>) {
  const { WorkerFleetCapabilities, setWorkerFleet } = await import("../services/worker-fleet.js");
  const now = Date.now();
  setWorkerFleet(new WorkerFleetCapabilities({
    readRecords: async () => [{
      instanceId: "fly-new", identity: "new-worker", taskQueue: "docslurp-pipeline", buildId: "new",
      protocol: WORKER_CAPABILITY_PROTOCOL, capabilities: [...WORKER_CAPABILITIES], lastSeenAt: now - 1_000, stoppedAt: null,
    }],
    readPollers: async () => pollers.map((poller) => ({ ...poller, lastAccessMs: now })),
    now: () => Date.now(),
    log: () => {},
  }, process.env));
  const { startPipelineWorkflow } = await import("../lib/temporal.js");
  await startPipelineWorkflow("run-1", normalizePipelineFeatures({ summarize: true, propositionIndex: true }));
  const [, options] = mocks.start.mock.calls.at(-1) as unknown as [string, { args: Array<{ stageOrder: string[]; groupableStages?: string[] }> }];
  return options.args[0]!;
}

describe("startPipelineWorkflow with the capability gate", () => {
  it("records the old input while an older worker still polls", async () => {
    const input = await startWith([{ identity: "new-worker", buildId: "new" }, { identity: "old-worker", buildId: "old" }]);
    expect(input.stageOrder.at(-1)).toBe("index");
    expect(input.groupableStages).toBeUndefined();
  });

  it("records the new input once every worker supports it", async () => {
    const input = await startWith([{ identity: "new-worker", buildId: "new" }]);
    expect(input.stageOrder.at(-1)).toBe("proposition-index");
    expect(input.groupableStages?.length).toBeGreaterThan(0);
  });

  it("records the old input when the fleet cannot be observed", async () => {
    const { WorkerFleetCapabilities, setWorkerFleet } = await import("../services/worker-fleet.js");
    setWorkerFleet(new WorkerFleetCapabilities({
      readRecords: async () => [],
      readPollers: async () => { throw new Error("UNAVAILABLE"); },
      now: () => Date.now(),
      log: () => {},
    }, process.env));
    const { startPipelineWorkflow } = await import("../lib/temporal.js");
    await startPipelineWorkflow("run-2", normalizePipelineFeatures({ summarize: true, propositionIndex: true }));
    const [, options] = mocks.start.mock.calls.at(-1) as unknown as [string, { args: Array<{ stageOrder: string[]; groupableStages?: string[] }> }];
    expect(options.args[0]!.stageOrder.at(-1)).toBe("index");
    expect(options.args[0]!.groupableStages).toBeUndefined();
  });
});
