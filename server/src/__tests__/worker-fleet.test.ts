import { describe, expect, it, vi } from "vitest";

import { WORKER_CAPABILITIES, WORKER_CAPABILITY_PROTOCOL, resolveCreditLeaseConfig, type WorkerCapabilityRecord } from "@docslurp/shared";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const fleet = await import("../services/worker-fleet.js");
const { searchEarlyLexicalEnabled } = await import("../search/eligibility.js");

const NOW = 1_800_000_000_000;
const ALL = [...WORKER_CAPABILITIES].sort();

function record(identity: string, overrides: Partial<WorkerCapabilityRecord> = {}): WorkerCapabilityRecord {
  return {
    instanceId: identity, identity, taskQueue: "docslurp-pipeline", buildId: "new",
    protocol: WORKER_CAPABILITY_PROTOCOL, capabilities: [...WORKER_CAPABILITIES],
    lastSeenAt: NOW - 5_000, stoppedAt: null, ...overrides,
  };
}

function harness(overrides: Partial<import("../services/worker-fleet.js").FleetDeps> = {}, env: Record<string, string> = {}) {
  let now = NOW;
  const logs: string[] = [];
  const deps = {
    readRecords: vi.fn(async () => [record("w1")]),
    readPollers: vi.fn(async () => [{ identity: "w1", lastAccessMs: NOW - 1_000, buildId: "new" }]),
    now: () => now,
    log: (line: string) => logs.push(line),
    ...overrides,
  };
  const instance = new fleet.WorkerFleetCapabilities(deps, { NODE_ENV: "production", ...env });
  return { instance, deps, logs, advance: (ms: number) => { now += ms; } };
}

describe("WorkerFleetCapabilities", () => {
  it("resolves the intersection and caches it for WORKER_CAPABILITY_CACHE_MS", async () => {
    const { instance, deps, advance } = harness();
    expect((await instance.resolve("docslurp-pipeline")).capabilities).toEqual(ALL);
    await instance.resolve("docslurp-pipeline");
    expect(deps.readRecords).toHaveBeenCalledTimes(1);
    advance(16_000);
    await instance.resolve("docslurp-pipeline");
    expect(deps.readRecords).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight resolution between concurrent callers", async () => {
    const { instance, deps } = harness();
    await Promise.all([instance.resolve(), instance.resolve(), instance.resolve()]);
    expect(deps.readPollers).toHaveBeenCalledTimes(1);
  });

  it("is fail-safe: an unreachable registry or Temporal resolves to no capabilities", async () => {
    const noRegistry = harness({ readRecords: vi.fn(async () => { throw Object.assign(new Error("relation \"worker_capabilities\" does not exist"), { code: "42P01" }); }) });
    expect(await noRegistry.instance.resolve()).toMatchObject({ basis: "unknown", capabilities: [] });
    const noTemporal = harness({ readPollers: vi.fn(async () => { throw new Error("UNAVAILABLE"); }) });
    expect(await noTemporal.instance.resolve()).toMatchObject({ basis: "unknown", capabilities: [] });
  });

  it("retries an unknown answer sooner than a settled one", async () => {
    const readPollers = vi.fn(async () => { throw new Error("UNAVAILABLE"); });
    const { instance, advance } = harness({ readPollers });
    await instance.resolve();
    advance(6_000);
    await instance.resolve();
    expect(readPollers).toHaveBeenCalledTimes(2);
  });

  it("logs held-back flags once per change", async () => {
    const { instance, logs, advance } = harness({
      readPollers: vi.fn(async () => [
        { identity: "w1", lastAccessMs: NOW, buildId: "new" },
        { identity: "old", lastAccessMs: NOW, buildId: "abc" },
      ]),
    }, { WORKER_INDEX_BEFORE_ENRICH: "true" });
    await instance.resolve();
    advance(20_000);
    await instance.resolve();
    const held = logs.filter((line) => line.includes("WORKER_INDEX_BEFORE_ENRICH is configured on but held back"));
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("worker old (build abc)");
  });

  it("peek serves a recent snapshot synchronously and unknown when stale or missing", async () => {
    const { instance, advance } = harness();
    expect(instance.peek().basis).toBe("unknown");
    await instance.resolve();
    expect(instance.peek().capabilities).toEqual(ALL);
    advance(5 * 60_000);
    expect(instance.peek().basis).toBe("unknown");
  });
});

describe("gate wiring", () => {
  it("is on by default outside tests and can be turned off", () => {
    expect(fleet.capabilityGateEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(fleet.capabilityGateEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(fleet.capabilityGateEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(fleet.capabilityGateEnabled({ NODE_ENV: "production", WORKER_CAPABILITY_GATE: "off" })).toBe(false);
  });

  it("reads each flag with the same defaults as its owner", () => {
    for (const env of [
      { NODE_ENV: "production" },
      { NODE_ENV: "development" },
      { NODE_ENV: "production", SEARCH_EARLY_LEXICAL: "1", WORKER_CREDIT_LEASES: "on" },
      { NODE_ENV: "development", SEARCH_EARLY_LEXICAL: "off", WORKER_CREDIT_LEASES: "off" },
    ]) {
      const configured = fleet.configuredGatedFlags(env);
      expect(configured.SEARCH_EARLY_LEXICAL).toBe(searchEarlyLexicalEnabled(env));
      expect(configured.WORKER_CREDIT_LEASES).toBe(resolveCreditLeaseConfig(env).enabled);
    }
    expect(fleet.configuredGatedFlags({ NODE_ENV: "production", WORKER_GROUP_ADJACENT_STAGES: "true", WORKER_GROUP_LIGHT_STAGES: "false" }).WORKER_GROUP_ADJACENT_STAGES).toBe(false);
  });

  it("routes load-test orgs to the load-test queue", () => {
    const env = { TEMPORAL_LOADTEST_TASK_QUEUE: "docslurp-loadtest", TEMPORAL_LOADTEST_ORG_IDS: "lt" };
    expect(fleet.taskQueueForOrgKey("lt", "docslurp-pipeline", env).taskQueue).toBe("docslurp-loadtest");
    expect(fleet.taskQueueForOrgKey("org", "docslurp-pipeline", env).taskQueue).toBe("docslurp-pipeline");
  });
});

describe("synchronous readers", () => {
  it("fleetSupportsNow is unsupported until a snapshot exists, then follows it", async () => {
    const env = process.env;
    const saved = env.WORKER_CAPABILITY_GATE;
    env.WORKER_CAPABILITY_GATE = "on";
    try {
      const { instance } = harness();
      fleet.setWorkerFleet(instance);
      expect(fleet.fleetSupportsNow("billing.credit-leases")).toBe(false);
      await instance.resolve();
      expect(fleet.fleetSupportsNow("billing.credit-leases")).toBe(true);
      env.WORKER_CAPABILITY_GATE = "off";
      fleet.setWorkerFleet(harness({ readPollers: vi.fn(async () => { throw new Error("down"); }) }).instance);
      expect(fleet.fleetSupportsNow("billing.credit-leases")).toBe(true);
    } finally {
      if (saved === undefined) delete env.WORKER_CAPABILITY_GATE;
      else env.WORKER_CAPABILITY_GATE = saved;
      fleet.setWorkerFleet(null);
    }
  });

  it("the refresher only runs with the gate on and a gated flag configured", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    fleet.setWorkerFleet(harness().instance);
    fleet.startWorkerFleetRefresher({ NODE_ENV: "production" });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    fleet.startWorkerFleetRefresher({ NODE_ENV: "production", WORKER_CAPABILITY_GATE: "off", WORKER_INDEX_BEFORE_ENRICH: "true" });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    fleet.startWorkerFleetRefresher({ NODE_ENV: "production", WORKER_INDEX_BEFORE_ENRICH: "true" });
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    fleet.stopWorkerFleetRefresher();
    fleet.setWorkerFleet(null);
    setIntervalSpy.mockRestore();
  });
});
