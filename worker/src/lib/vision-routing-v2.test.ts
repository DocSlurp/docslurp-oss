import { describe, expect, it, vi } from "vitest";

import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import {
  VISION_ROUTING_VERSION_SLOT,
  pinRunRoutingVersion,
  resolveRunRoutingV2,
  routingVersion,
} from "./vision-routing-v2.js";

const run = (projectId: string | undefined = "ws-a", stored?: string) => ({
  run: { id: "run-1", projectId },
  artifactLedger: DocumentArtifactLedger.create(stored === undefined ? {} : { [VISION_ROUTING_VERSION_SLOT]: stored }),
});

describe("per-run routing version", () => {
  it("pins every new run to evidence routing and persists the pin", () => {
    const state = run();
    expect(pinRunRoutingVersion(state)).toBe("v3");
    expect(state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT)).toBe("v3");
    expect(resolveRunRoutingV2(state)).toBe(true);
    expect(routingVersion(true)).toBe("v3");
    expect(routingVersion(false)).toBe("v1");
  });

  it("keeps the version a run already has, so a retried start never changes it", () => {
    const state = run("ws-a", "v1");
    expect(pinRunRoutingVersion(state)).toBe("v1");
    expect(resolveRunRoutingV2(state)).toBe(false);
    expect(pinRunRoutingVersion(run("ws-a", "v3"))).toBe("v3");
    expect(resolveRunRoutingV2(run("ws-a", "v3"))).toBe(true);
  });

  it("never reads the previous release's v2 pin as evidence routing", () => {
    // The previous release pinned v2 for its canary keyword rules; the meaning changed, so the value did.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = run("ws-a", "v2");
    expect(pinRunRoutingVersion(state)).toBe("v1");
    expect(resolveRunRoutingV2(state)).toBe(false);
    expect(state.artifactLedger.read(VISION_ROUTING_VERSION_SLOT)).toBe("v2");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("different v2 rules"));
    warn.mockRestore();
  });

  it("routes a run without a pin as v1 and never widens an unknown pin", () => {
    expect(resolveRunRoutingV2(run())).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(pinRunRoutingVersion(run("ws-a", "v9"))).toBe("v1");
    expect(resolveRunRoutingV2(run("ws-a", "v9"))).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
