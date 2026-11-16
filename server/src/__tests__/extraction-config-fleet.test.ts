import { describe, expect, it, vi } from "vitest";

import {
  DISABLE_TOKENS,
  gatedFeatureStates,
  intersectFleetCapabilities,
  parseDisableList,
  parseWorkerAdvertisedConfig,
  WORKER_CAPABILITIES,
  WORKER_CAPABILITY_PROTOCOL,
  type WorkerCapabilityRecord,
} from "@docslurp/shared";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const fleet = await import("../services/worker-fleet.js");

// #502 mixed-fleet rollout (design 6, 8): the app applies its own switch lowering whatever the fleet says, and relies on
// worker-side enforcement of DOCSLURP_DISABLE only when every counted worker advertises extraction.config-v1.
const NOW = 1_800_000_000_000;
const R0 = [...WORKER_CAPABILITIES];
const PRE_R0 = WORKER_CAPABILITIES.filter((capability) => capability !== "extraction.config-v1");
const ENV = { NODE_ENV: "production", DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "ai,figures" };

function record(identity: string, capabilities: readonly string[], config: WorkerCapabilityRecord["config"] = null): WorkerCapabilityRecord {
  return {
    instanceId: identity, identity, taskQueue: "docslurp-pipeline", buildId: identity,
    protocol: WORKER_CAPABILITY_PROTOCOL, capabilities: [...capabilities], lastSeenAt: NOW - 5_000, stoppedAt: null, config,
  };
}

const AI = ["ai", "ai-rescue", "ai-escalation", "page-reader", "router", "charts-ai"];
const r0Config = (disabled: string[], digest = "sha256:aaaa") => ({ extractionConfig: 1, postureDigest: digest, profile: "service", disabled: disabled.length === 1 && disabled[0] === "ai" ? AI : disabled });

function snapshot(records: WorkerCapabilityRecord[]) {
  return intersectFleetCapabilities({
    now: NOW,
    records,
    pollers: records.map((r) => ({ identity: r.identity, lastAccessMs: NOW - 1_000, buildId: r.buildId })),
  });
}

describe("extraction config across a mixed fleet", () => {
  it("app first: an R0 app beside pre-R0 workers keeps the switches gated off for worker enforcement", () => {
    const view = snapshot([record("old-1", PRE_R0), record("old-2", PRE_R0)]);
    const states = gatedFeatureStates(fleet.configuredGatedFlags(ENV), new Set(view.capabilities));
    expect(states.find((state) => state.flag === "DOCSLURP_DISABLE")).toMatchObject({ configured: true, supported: false, effective: false });
    const report = fleet.extractionConfigFleetView(view, ENV);
    expect(report.fleetEnforcesSwitches).toBe(false);
    expect(report.app.disabled).toEqual(["ai", "ai-rescue", "ai-escalation", "page-reader", "router", "figures", "charts-ai"]);
    // Old rows advertise nothing, so there is nothing to compare: no skew is claimed.
    expect(report.switchSkew).toEqual([]);
  });

  it("app first, mid-roll: one R0 worker beside a pre-R0 worker is still not enough", () => {
    const view = snapshot([record("new-1", R0, r0Config(["ai"])), record("old-1", PRE_R0)]);
    expect(view.capabilities).not.toContain("extraction.config-v1");
    expect(fleet.extractionConfigFleetView(view, ENV).fleetEnforcesSwitches).toBe(false);
  });

  it("worker first: R0 workers under a pre-R0 app enforce their own switches; a fully rolled fleet is reported as enforcing", () => {
    const disabled = ["ai", "ai-rescue", "ai-escalation", "page-reader", "router", "figures", "charts-ai"];
    const view = snapshot([record("new-1", R0, r0Config(disabled)), record("new-2", R0, r0Config(disabled))]);
    expect(view.capabilities).toContain("extraction.config-v1");
    const report = fleet.extractionConfigFleetView(view, ENV);
    expect(report.fleetEnforcesSwitches).toBe(true);
    expect(report.workerPostureDigests).toEqual(["sha256:aaaa"]);
    expect(report.switchSkew).toEqual([]);
  });

  it("reports workers whose switches differ from the app's and mixed posture digests", () => {
    const view = snapshot([record("new-1", R0, r0Config([], "sha256:aaaa")), record("new-2", R0, r0Config(["ai"], "sha256:bbbb"))]);
    const report = fleet.extractionConfigFleetView(view, ENV);
    expect(report.switchSkew).toEqual(["new-1", "new-2"]);
    expect(report.workerPostureDigests).toEqual(["sha256:aaaa", "sha256:bbbb"]);
  });

  it("rollback R1 -> R0: an old worker reappearing turns worker enforcement back off for new runs, and R0 knows every token", () => {
    const rolled = snapshot([record("new-1", R0, r0Config([])), record("old-again", PRE_R0)]);
    expect(fleet.extractionConfigFleetView(rolled, ENV).fleetEnforcesSwitches).toBe(false);
    // Every token is known from R0, so an R1 env rolled back onto R0 never meets an unknown token.
    expect(parseDisableList(DISABLE_TOKENS.join(",")).unknown).toEqual([]);
  });

  it("ignores the stale config of a machine rolled back to a pre-R0 build (same instance id)", () => {
    const view = snapshot([record("new-1", R0, r0Config(["ai"], "sha256:aaaa")), record("rolled-back", PRE_R0, r0Config([], "sha256:stale"))]);
    const report = fleet.extractionConfigFleetView(view, { ...ENV, DOCSLURP_DISABLE: "ai" });
    expect(report.workerPostureDigests).toEqual(["sha256:aaaa"]);
    expect(report.switchSkew).toEqual([]);
    expect(report.fleetEnforcesSwitches).toBe(false);
  });

  it("an unknown fleet (Temporal or registry down) never counts as enforcing", () => {
    const unknown = intersectFleetCapabilities({ now: NOW, records: [record("new-1", R0, r0Config([]))], pollers: null });
    expect(fleet.extractionConfigFleetView(unknown, ENV).fleetEnforcesSwitches).toBe(false);
  });

  it("reports an app posture that would refuse instead of throwing from the ops route", () => {
    const view = snapshot([record("new-1", R0, r0Config([]))]);
    const report = fleet.extractionConfigFleetView(view, { ...ENV, DOCSLURP_DISABLE: "ocr,typo" });
    expect(report.app.error).toMatch(/unknown token/);
  });

  it("parses advertised config defensively", () => {
    expect(parseWorkerAdvertisedConfig(null)).toBeNull();
    expect(parseWorkerAdvertisedConfig("x")).toBeNull();
    expect(parseWorkerAdvertisedConfig({ extractionConfig: "1", postureDigest: 5, disabled: ["ai", 3, "x".repeat(50)] })).toEqual({ disabled: ["ai"] });
  });

  it("DOCSLURP_DISABLE counts as configured only with a known token", () => {
    expect(fleet.configuredGatedFlags({ NODE_ENV: "production" }).DOCSLURP_DISABLE).toBe(false);
    expect(fleet.configuredGatedFlags({ NODE_ENV: "production", DOCSLURP_DISABLE: " , " }).DOCSLURP_DISABLE).toBe(false);
    expect(fleet.configuredGatedFlags({ NODE_ENV: "production", DOCSLURP_DISABLE: "ocr" }).DOCSLURP_DISABLE).toBe(true);
  });
});
