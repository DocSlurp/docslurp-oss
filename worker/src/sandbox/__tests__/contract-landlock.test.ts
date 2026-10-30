import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { defineSandboxContract, execInSession } from "./contract.js";
import landlock, { networkForKernel } from "../providers/landlock/index.js";
import { SandboxPolicyError } from "../types.js";
import { CommandRunner } from "../../tools/runner.js";

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

describe("landlock refuses commands that need the UNIX-socket filter", () => {
  it("the runner refuses a socketless tool under landlock unless the development opt-in is set", async (ctx) => {
    const config = landlock.readConfig(landlockEnv);
    const probe = await landlock.probe(config);
    if (!probe.ok) ctx.skip(`landlock unavailable: ${probe.detail}`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const session = await landlock.openSession(config, { activityId: "socket-filter" });
      const spawned = vi.spyOn(session, "spawn");
      const runner = new CommandRunner({ openSession: async () => session });
      // pdftotext is not an audited socket client: it asks for the filter, which landrun cannot apply.
      const plan = { binary: "/usr/bin/pdftotext", args: ["-v"], available: true };
      vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "");
      await expect(runner.run(plan)).rejects.toBeInstanceOf(SandboxPolicyError);
      vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "1");
      vi.stubEnv("NODE_ENV", "production");
      await expect(runner.run(plan)).rejects.toBeInstanceOf(SandboxPolicyError);
      expect(spawned).not.toHaveBeenCalled();
      // Development opt-in: it runs (pdftotext -v exits 0 and prints its version on stderr).
      vi.stubEnv("NODE_ENV", "development");
      const result = await runner.run(plan);
      expect(result.stderr).toMatch(/pdftotext version/);
      expect(spawned).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    }
  });
});
