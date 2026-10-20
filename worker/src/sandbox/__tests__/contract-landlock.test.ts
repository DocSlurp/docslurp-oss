import { describe, expect, it } from "vitest";

import { defineSandboxContract } from "./contract.js";
import landlock, { networkForKernel } from "../providers/landlock/index.js";

describe("landlock kernel network mapping", () => {
  it.each([
    ["6.7.12", "none"],
    ["6.8.0", "tcp-only"],
    ["7.2.5-3-omarchy", "tcp-only"],
    ["5.15.0-91-generic", "none"],
    ["garbage", "none"],
  ])("maps kernel %s to network %s", (release, expected) => {
    expect(networkForKernel(release)).toBe(expected);
  });
});

defineSandboxContract("landlock", async () => {
  const config = landlock.readConfig(process.env);
  const probe = await landlock.probe(config);
  if (!probe.ok) {
    console.warn(`[contract] landlock unavailable, skipping: ${probe.detail}`);
    return { skip: probe.detail };
  }
  return landlock.openSession(config, { activityId: "contract-landlock" });
});
