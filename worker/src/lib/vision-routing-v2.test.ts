import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import {
  VISION_ROUTING_VERSION_SLOT,
  parseVisionRoutingV2,
  pinRunRoutingVersion,
  resetVisionRoutingV2WarningsForTest,
  resolveRunRoutingV2,
  routingVersion,
  visionRoutingV2Enabled,
} from "./vision-routing-v2.js";

function run(workspaceId?: string, artifacts: Record<string, string> = {}) {
  return WorkflowState.create({ id: "run-1", workspaceId, artifacts, stats: {}, pipeline: {} } as unknown as WorkspaceRun, []);
}

/** What `startRun` pins for a new run under `env`. */
const startsV2 = (state: ReturnType<typeof run>, env: Record<string, string | undefined>) => pinRunRoutingVersion(state, env) === "v2";

describe("VISION_ROUTING_V2", () => {
  beforeEach(() => resetVisionRoutingV2WarningsForTest());

  it("is off when unset, empty or off", () => {
    for (const value of [undefined, "", "  ", "off", "OFF"]) {
      expect(startsV2(run("ws-a"), { VISION_ROUTING_V2: value })).toBe(false);
    }
  });

  it("is on for every workspace with on", () => {
    expect(startsV2(run("ws-a"), { VISION_ROUTING_V2: "on" })).toBe(true);
    expect(startsV2(run(undefined), { VISION_ROUTING_V2: " On " })).toBe(true);
  });

  it("enables an allowlisted workspace and nobody else", () => {
    const env = { VISION_ROUTING_V2: "3f2c1b9e-0d4a-4b8e-9c71-5a6e2f1d0b3c, ws_canary" };
    expect(startsV2(run("3f2c1b9e-0d4a-4b8e-9c71-5a6e2f1d0b3c"), env)).toBe(true);
    expect(startsV2(run("ws_canary"), env)).toBe(true);
    expect(startsV2(run("ws-other"), env)).toBe(false);
    expect(startsV2(run(undefined), env)).toBe(false);
    // Ids are exact: no case folding or prefix match.
    expect(startsV2(run("WS_CANARY"), env)).toBe(false);
    expect(startsV2(run("ws_can"), env)).toBe(false);
  });

  it("reads malformed values as off with one warning per value", () => {
    const warn = vi.fn();
    const malformed = ["true", "1", "yes", "on,ws-a", "ws a", "ws-a;ws-b", ",", "ws-*", "ws-a,,", ",ws-a", "ws-a,", "ws-a, ,ws-b"];
    for (const value of malformed) {
      expect(parseVisionRoutingV2(value, warn)).toEqual({ mode: "off" });
    }
    expect(warn).toHaveBeenCalledTimes(malformed.length);
    parseVisionRoutingV2("true", warn);
    parseVisionRoutingV2("ws-a,", warn);
    expect(warn).toHaveBeenCalledTimes(malformed.length);
    expect(warn.mock.calls[0]![0]).toContain("VISION_ROUTING_V2");
  });

  it("pins the version in the run's artifacts at run start", () => {
    const started = run("ws-a");
    expect(pinRunRoutingVersion(started, { VISION_ROUTING_V2: "ws-a" })).toBe("v2");
    expect(started.run.artifacts[VISION_ROUTING_VERSION_SLOT]).toBe("v2");
    // Later reads in the same process ignore a changed environment.
    expect(resolveRunRoutingV2(started)).toBe(true);
    // A retried start keeps the first value.
    expect(pinRunRoutingVersion(started, { VISION_ROUTING_V2: "off" })).toBe("v2");
  });

  it("rehydrated runs read the pinned version whatever this worker's environment says", () => {
    const started = run("ws-a");
    pinRunRoutingVersion(started, { VISION_ROUTING_V2: "on" });
    // A fresh run object built from the persisted artifacts (another activity or worker).
    const rehydrated = run("ws-a", { ...started.run.artifacts });
    expect(resolveRunRoutingV2(rehydrated)).toBe(true);

    const offRun = run("ws-a");
    pinRunRoutingVersion(offRun, { VISION_ROUTING_V2: "off" });
    const offRehydrated = run("ws-a", { ...offRun.run.artifacts });
    expect(resolveRunRoutingV2(offRehydrated)).toBe(false);
  });

  it("a run without a pin routes as v1 whatever the environment says, and records nothing", () => {
    vi.stubEnv("VISION_ROUTING_V2", "on");
    try {
      const unpinned = run("ws-a");
      expect(resolveRunRoutingV2(unpinned)).toBe(false);
      expect(unpinned.run.artifacts[VISION_ROUTING_VERSION_SLOT]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an unknown pinned version routes as v1", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(resolveRunRoutingV2(run("ws-a", { [VISION_ROUTING_VERSION_SLOT]: "v3" }))).toBe(false);
    warn.mockRestore();
  });

  it("labels the routing version for stage stats", () => {
    expect(routingVersion(true)).toBe("v2");
    expect(routingVersion(false)).toBe("v1");
    expect(visionRoutingV2Enabled({ mode: "workspaces", workspaceIds: new Set(["a1"]) }, "a1")).toBe(true);
  });
});
