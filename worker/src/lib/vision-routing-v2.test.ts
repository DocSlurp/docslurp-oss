import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRun } from "../models.js";
import {
  parseVisionRoutingV2,
  resetVisionRoutingV2WarningsForTest,
  resolveRunRoutingV2,
  routingVersion,
  visionRoutingV2Enabled,
} from "./vision-routing-v2.js";

function run(workspaceId?: string): WorkspaceRun {
  return { id: "run-1", workspaceId } as WorkspaceRun;
}

describe("VISION_ROUTING_V2", () => {
  beforeEach(() => resetVisionRoutingV2WarningsForTest());

  it("is off when unset, empty or off", () => {
    for (const value of [undefined, "", "  ", "off", "OFF"]) {
      expect(resolveRunRoutingV2(run("ws-a"), { VISION_ROUTING_V2: value })).toBe(false);
    }
  });

  it("is on for every workspace with on", () => {
    expect(resolveRunRoutingV2(run("ws-a"), { VISION_ROUTING_V2: "on" })).toBe(true);
    expect(resolveRunRoutingV2(run(undefined), { VISION_ROUTING_V2: " On " })).toBe(true);
  });

  it("enables an allowlisted workspace and nobody else", () => {
    const env = { VISION_ROUTING_V2: "3f2c1b9e-0d4a-4b8e-9c71-5a6e2f1d0b3c, ws_canary" };
    expect(resolveRunRoutingV2(run("3f2c1b9e-0d4a-4b8e-9c71-5a6e2f1d0b3c"), env)).toBe(true);
    expect(resolveRunRoutingV2(run("ws_canary"), env)).toBe(true);
    expect(resolveRunRoutingV2(run("ws-other"), env)).toBe(false);
    expect(resolveRunRoutingV2(run(undefined), env)).toBe(false);
    // Ids are exact: no case folding or prefix match.
    expect(resolveRunRoutingV2(run("WS_CANARY"), env)).toBe(false);
    expect(resolveRunRoutingV2(run("ws_can"), env)).toBe(false);
  });

  it("reads malformed values as off with one warning per value", () => {
    const warn = vi.fn();
    for (const value of ["true", "1", "yes", "on,ws-a", "ws a", "ws-a;ws-b", ",", "ws-*"]) {
      expect(parseVisionRoutingV2(value, warn)).toEqual({ mode: "off" });
    }
    expect(warn).toHaveBeenCalledTimes(8);
    parseVisionRoutingV2("true", warn);
    expect(warn).toHaveBeenCalledTimes(8);
    expect(warn.mock.calls[0]![0]).toContain("VISION_ROUTING_V2");
  });

  it("resolves once per run", () => {
    const pinned = run("ws-a");
    expect(resolveRunRoutingV2(pinned, { VISION_ROUTING_V2: "ws-a" })).toBe(true);
    expect(resolveRunRoutingV2(pinned, { VISION_ROUTING_V2: "off" })).toBe(true);
  });

  it("labels the routing version for stage stats", () => {
    expect(routingVersion(true)).toBe("v2");
    expect(routingVersion(false)).toBe("v1");
    expect(visionRoutingV2Enabled({ mode: "workspaces", workspaceIds: new Set(["a1"]) }, "a1")).toBe(true);
  });
});
