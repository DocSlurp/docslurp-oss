import { describe, expect, it } from "vitest";

import {
  calculatePoolTargetMachines,
  calculateWorkerTargetMachines,
  parseOrgDemand,
  resolveWorkerScalerConfig,
  slotDemand,
  type WorkerScalerConfig,
} from "../lib/worker-autoscale.js";

const config = (overrides: Partial<WorkerScalerConfig> = {}): WorkerScalerConfig => ({
  slotsPerMachine: 8,
  globalSlotCap: 0,
  headroom: 1,
  maxMachines: 125,
  excludedOrgKeys: new Set(),
  ...overrides,
});

describe("worker autoscale formula", () => {
  it("is zero when idle and one while a live lease drains", () => {
    expect(calculateWorkerTargetMachines({ orgs: [], workerActive: 0 }, config())).toBe(0);
    expect(calculateWorkerTargetMachines({ orgs: [], workerActive: 3 }, config())).toBe(1);
  });

  it("caps each org at its slots before summing", () => {
    const orgs = [
      { orgKey: "free", demand: 400, slots: 2 },
      { orgKey: "platinum", demand: 126, slots: 1_000 },
    ];
    expect(slotDemand(orgs)).toBe(128);
    expect(calculateWorkerTargetMachines({ orgs, workerActive: 0 }, config())).toBe(16);
  });

  it("reaches 125 machines for one Platinum org at 1,000 slots", () => {
    const orgs = [{ orgKey: "platinum", demand: 5_000, slots: 1_000 }];
    expect(calculateWorkerTargetMachines({ orgs, workerActive: 1 }, config())).toBe(125);
    expect(calculateWorkerTargetMachines({ orgs, workerActive: 1 }, config({ maxMachines: 20 }))).toBe(20);
  });

  it("applies the global slot cap and headroom", () => {
    const orgs = [{ orgKey: "a", demand: 1_000, slots: 1_000 }, { orgKey: "b", demand: 100, slots: 100 }];
    expect(calculateWorkerTargetMachines({ orgs, workerActive: 0 }, config({ globalSlotCap: 512 }))).toBe(64);
    expect(calculateWorkerTargetMachines({ orgs: [{ orgKey: "a", demand: 80, slots: 100 }], workerActive: 0 }, config({ headroom: 1.25 }))).toBe(13);
  });

  it("never rounds exact multiples up", () => {
    expect(calculateWorkerTargetMachines({ orgs: [{ orgKey: "a", demand: 128, slots: 128 }], workerActive: 0 }, config())).toBe(16);
    expect(calculateWorkerTargetMachines({ orgs: [{ orgKey: "a", demand: 129, slots: 1_000 }], workerActive: 0 }, config())).toBe(17);
  });

  it("excludes load-test orgs from the production fleet and sizes their pool separately", () => {
    const orgs = [{ orgKey: "lt", demand: 128, slots: 128 }, { orgKey: "customer", demand: 3, slots: 20 }];
    const excluded = new Set(["lt"]);
    expect(calculateWorkerTargetMachines({ orgs, workerActive: 0 }, config({ excludedOrgKeys: excluded }))).toBe(1);
    expect(calculatePoolTargetMachines(orgs, excluded, { slotsPerMachine: 8, headroom: 1, maxMachines: 125 })).toBe(16);
    expect(calculatePoolTargetMachines(orgs, new Set(["nobody"]), { slotsPerMachine: 8, headroom: 1, maxMachines: 125 })).toBe(0);
  });

  it("parses the scaler query's JSON aggregate", () => {
    expect(parseOrgDemand('[{"org_key":"a","slots":2,"demand":5}]')).toEqual([{ orgKey: "a", slots: 2, demand: 5 }]);
    expect(parseOrgDemand(null)).toEqual([]);
    expect(parseOrgDemand("not json")).toEqual([]);
  });

  it("reads its configuration from env", () => {
    const resolved = resolveWorkerScalerConfig({
      DOCSLURP_WORKER_SLOTS_PER_MACHINE: "8", WORKER_GLOBAL_SLOT_CAP: "1000",
      DOCSLURP_WORKER_SCALE_HEADROOM: "1.1", DOCSLURP_WORKER_MAX_AUTOSCALE_MACHINES: "125",
      TEMPORAL_LOADTEST_ORG_IDS: "lt-1,lt-2",
    });
    expect(resolved).toMatchObject({ slotsPerMachine: 8, globalSlotCap: 1_000, headroom: 1.1, maxMachines: 125 });
    expect([...resolved.excludedOrgKeys]).toEqual(["lt-1", "lt-2"]);
    expect(resolveWorkerScalerConfig({ WORKER_ACTIVITY_CONCURRENCY: "8" }).slotsPerMachine).toBe(8);
  });

  it("uses the worker's resolved slot count when neither env var is set, and the env still wins", () => {
    expect(resolveWorkerScalerConfig({}).slotsPerMachine).toBe(1);
    expect(resolveWorkerScalerConfig({}, 6).slotsPerMachine).toBe(6);
    expect(resolveWorkerScalerConfig({ WORKER_ACTIVITY_CONCURRENCY: "3" }, 6).slotsPerMachine).toBe(3);
    expect(resolveWorkerScalerConfig({ DOCSLURP_WORKER_SLOTS_PER_MACHINE: "8" }, 6).slotsPerMachine).toBe(8);
  });
});
