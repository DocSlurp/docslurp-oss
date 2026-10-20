import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { defineSandboxContract, execInSession } from "./contract.js";
import landlock, { networkForKernel } from "../providers/landlock/index.js";

// Per-command scratch lives here, not under the default /tmp root.
const scratchRoot = mkdtempSync(path.join(tmpdir(), "docslurp-landlock-scratch-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const landlockEnv = { ...process.env, DOCSLURP_PARSER_SANDBOX_ROOT: scratchRoot };

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
  const config = landlock.readConfig(landlockEnv);
  const probe = await landlock.probe(config);
  if (!probe.ok) {
    console.warn(`[contract] landlock unavailable, skipping: ${probe.detail}`);
    return { skip: probe.detail };
  }
  return landlock.openSession(config, { activityId: "contract-landlock" });
});

describe("landlock per-command scratch", () => {
  it("removes the command's scratch directory after it exits", async (ctx) => {
    const config = landlock.readConfig(landlockEnv);
    const probe = await landlock.probe(config);
    if (!probe.ok) ctx.skip(`landlock unavailable: ${probe.detail}`);
    mkdirSync(scratchRoot, { recursive: true });
    const session = await landlock.openSession(config, { activityId: "scratch" });
    const result = await execInSession(session, {
      binary: "/usr/bin/bash",
      args: ["-c", 'echo x > "$TMPDIR/file"'],
      env: { PATH: "/usr/bin:/bin" },
      readablePaths: [],
      inputPaths: [],
      writablePaths: [],
      limits: { timeoutMs: 10_000 },
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});
