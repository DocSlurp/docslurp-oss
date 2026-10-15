import { describe, expect, it } from "vitest";

import {
  WORKER_CAPABILITIES,
  WORKER_CAPABILITY_PROTOCOL,
  gatedFeatureStates,
  intersectFleetCapabilities,
  type WorkerCapabilityRecord,
} from "../worker-capabilities.js";

const NOW = 1_800_000_000_000;
const ALL = [...WORKER_CAPABILITIES];

function record(identity: string, overrides: Partial<WorkerCapabilityRecord> = {}): WorkerCapabilityRecord {
  return {
    instanceId: identity,
    identity,
    taskQueue: "docslurp-pipeline",
    buildId: "new",
    protocol: WORKER_CAPABILITY_PROTOCOL,
    capabilities: ALL,
    lastSeenAt: NOW - 10_000,
    stoppedAt: null,
    ...overrides,
  };
}

const poller = (identity: string, buildId: string | null = "new", ageMs = 5_000) => ({ identity, buildId, lastAccessMs: NOW - ageMs });

describe("intersectFleetCapabilities", () => {
  it("enables everything when every live poller is a registered new worker", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1"), record("w2")],
      pollers: [poller("w1"), poller("w2")],
    });
    expect(snapshot.basis).toBe("pollers");
    expect(snapshot.capabilities).toEqual([...ALL].sort());
  });

  it("falls back to nothing when an unregistered (older build) worker polls", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1")],
      pollers: [poller("w1"), poller("old-worker", "abc")],
    });
    expect(snapshot.capabilities).toEqual([]);
    expect(snapshot.workers.find((worker) => worker.identity === "old-worker")).toMatchObject({ registered: false });
  });

  it("intersects a mixed fleet of registered builds", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [
        record("w1"),
        record("w2", { buildId: "mid", capabilities: ["workflow.index-before-enrich", "search.early-lexical"] }),
      ],
      pollers: [poller("w1"), poller("w2", "mid")],
    });
    expect(snapshot.capabilities).toEqual(["search.early-lexical", "workflow.index-before-enrich"]);
  });

  it("ignores a lingering poller whose process stopped cleanly (restart on the same machine)", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w-new"), record("w-old", { stoppedAt: NOW - 60_000, lastSeenAt: NOW - 60_000 })],
      // Temporal still lists the old process; its last poll was before it stopped.
      pollers: [poller("w-new"), poller("w-old", "new", 90_000)],
    });
    expect(snapshot.capabilities).toEqual([...ALL].sort());
    expect(snapshot.workers.map((worker) => worker.identity)).toEqual(["w-new"]);
  });

  it("still blocks a stopped row whose identity kept polling after the stop", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w-new"), record("w-old", { stoppedAt: NOW - 60_000, lastSeenAt: NOW - 60_000 })],
      pollers: [poller("w-new"), poller("w-old", "new", 5_000)],
    });
    expect(snapshot.capabilities).toEqual([]);
  });

  it("does not trust a stale registry heartbeat for a live poller", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { lastSeenAt: NOW - 10 * 60_000 })],
      pollers: [poller("w1")],
    });
    expect(snapshot.capabilities).toEqual([]);
    expect(snapshot.workers[0]?.note).toMatch(/stale/);
  });

  it("rejects a row whose build differs from the build the poller reports (pid reuse after a rollback)", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { buildId: "new" })],
      pollers: [poller("w1", "old")],
    });
    expect(snapshot.capabilities).toEqual([]);
  });

  it("ignores unknown capability keys and other protocols", () => {
    const unknownKey = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { capabilities: ["future.thing", "search.early-lexical"] })],
      pollers: [poller("w1")],
    });
    expect(unknownKey.capabilities).toEqual(["search.early-lexical"]);
    const otherProtocol = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { protocol: WORKER_CAPABILITY_PROTOCOL + 1 })],
      pollers: [poller("w1")],
    });
    expect(otherProtocol.capabilities).toEqual([]);
  });

  it("ignores pollers Temporal has not seen recently", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1")],
      pollers: [poller("w1"), poller("gone-old-worker", "old", 10 * 60_000)],
    });
    expect(snapshot.capabilities).toEqual([...ALL].sort());
  });

  it("is fail-safe when Temporal cannot be observed", () => {
    const snapshot = intersectFleetCapabilities({ now: NOW, records: [record("w1")], pollers: null });
    expect(snapshot).toMatchObject({ basis: "unknown", capabilities: [] });
  });

  it("uses recently seen workers for an idle fleet, and an old build among them holds features back", () => {
    const idle = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { lastSeenAt: NOW - 30 * 60_000, stoppedAt: NOW - 30 * 60_000 })],
      pollers: [],
    });
    expect(idle.basis).toBe("recent");
    expect(idle.capabilities).toEqual([...ALL].sort());

    const mixed = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1"), record("w2", { buildId: "mid", capabilities: [] })],
      pollers: [],
    });
    expect(mixed.capabilities).toEqual([]);
  });

  it("knows nothing about an idle fleet with no recent workers, or with the fallback disabled", () => {
    expect(intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { lastSeenAt: NOW - 7 * 60 * 60_000 })],
      pollers: [],
    })).toMatchObject({ basis: "unknown", capabilities: [] });
    expect(intersectFleetCapabilities({
      now: NOW,
      records: [record("w1")],
      pollers: [],
      options: { idleFallback: "none" },
    })).toMatchObject({ basis: "unknown", capabilities: [] });
  });

  it("uses the newest row per identity", () => {
    const snapshot = intersectFleetCapabilities({
      now: NOW,
      records: [record("w1", { capabilities: [], lastSeenAt: NOW - 60_000 }), record("w1", { lastSeenAt: NOW - 5_000 })],
      pollers: [poller("w1")],
    });
    expect(snapshot.capabilities).toEqual([...ALL].sort());
  });
});

describe("gatedFeatureStates", () => {
  it("flag on + old worker stays off; flag on + all new turns on; flag off stays off", () => {
    const configured = { WORKER_INDEX_BEFORE_ENRICH: true, WORKER_GROUP_ADJACENT_STAGES: true, WORKER_CREDIT_LEASES: false };
    const old = gatedFeatureStates(configured, new Set());
    expect(old.find((state) => state.flag === "WORKER_INDEX_BEFORE_ENRICH")).toMatchObject({ configured: true, supported: false, effective: false });
    const fresh = gatedFeatureStates(configured, new Set(WORKER_CAPABILITIES));
    expect(fresh.find((state) => state.flag === "WORKER_INDEX_BEFORE_ENRICH")?.effective).toBe(true);
    expect(fresh.find((state) => state.flag === "WORKER_CREDIT_LEASES")?.effective).toBe(false);
  });

  it("with the gate off the configured value decides", () => {
    const states = gatedFeatureStates({ SEARCH_EARLY_LEXICAL: true }, null);
    expect(states.find((state) => state.flag === "SEARCH_EARLY_LEXICAL")?.effective).toBe(true);
  });
});
