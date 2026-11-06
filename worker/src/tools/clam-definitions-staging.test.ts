import { mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxOutputError } from "../sandbox/types.js";
import { buildSandboxCommand, CommandRunner, stageClamDefinitions } from "./runner.js";

// Real-Modal P1: the ClamAV definitions are staged once per content, not per document, and travel as a read-only asset.
describe("ClamAV definitions staging", () => {
  let source: string;
  beforeEach(async () => {
    source = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "clam-db-source-"));
    await writeFile(path.join(source, "daily.cvd"), "daily v1");
    await writeFile(path.join(source, "main.cvd"), "main v1");
    await writeFile(path.join(source, "freshclam.conf"), "never copied");
  });
  afterEach(async () => { await rm(source, { recursive: true, force: true }); });

  it("reuses one content-named, read-only copy until the definitions change, then replaces it", async () => {
    const first = await stageClamDefinitions(source);
    const again = await stageClamDefinitions(source);
    expect(again.dir).toBe(first.dir);
    expect(path.basename(first.dir)).toMatch(/^docslurp-clam-definitions-[0-9a-f]{32}$/);
    expect((await readdir(first.dir)).sort()).toEqual(["daily.cvd", "main.cvd"]);
    expect((await stat(first.files[0]!)).mode & 0o777).toBe(0o444);
    // The updater rewrites daily.cvd: a new directory, and the old one goes.
    await writeFile(path.join(source, "daily.cvd"), "daily v2");
    await utimes(path.join(source, "daily.cvd"), new Date(), new Date(Date.now() + 5_000));
    const next = await stageClamDefinitions(source);
    expect(next.dir).not.toBe(first.dir);
    expect(existsSync(first.dir)).toBe(false);
    await rm(next.dir, { recursive: true, force: true });
  });

  it("a command with read-only assets reads them but never uploads them into its job tree", async () => {
    const staged = await stageClamDefinitions(source);
    const command = buildSandboxCommand({
      plan: { binary: "/usr/bin/clamscan", args: ["--database", staged.files[0]!, "--no-summary"], available: true, readOnlyInputs: true, readOnlyAssetDir: staged.dir },
      venvBin: "/nonexistent/venv/bin", scriptsDir: path.resolve("scripts"), scratchRoot: path.join(tmpdir(), "docslurp-parser-sandbox"),
      configuredWritablePaths: [], limits: { timeoutMs: 1_000 },
    });
    expect(command.readOnlyAssetDir).toBe(staged.dir);
    expect(command.inputPaths.some((p) => p.startsWith(staged.dir))).toBe(false);
    expect(command.readablePaths).toContain(staged.dir);
    expect(command.writablePaths.some((p) => p.startsWith(staged.dir))).toBe(false);
    await rm(staged.dir, { recursive: true, force: true });
  });

  it("a broken job tree under the definitions check fails with the staging error, not a missing database (real-Modal S2c)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      const runner = new CommandRunner();
      const staging = new SandboxOutputError("parser VM job tree staging failed: mkdir: cannot create directory: File exists");
      const run = vi.spyOn(runner, "run").mockRejectedValue(staging);
      const scan = (runner as unknown as { scanForMalwareWithDefinitions(source: string, signal: AbortSignal | undefined, args: string[], dir: string): Promise<unknown> })
        .scanForMalwareWithDefinitions.bind(runner);
      await expect(scan("/job/in.pdf", undefined, ["--database", "/defs/daily.cvd"], "/defs")).rejects.toBe(staging);
      // A check that ran but could not read the definitions is still "missing", and blocks scanning.
      run.mockResolvedValue({ stdout: "not a version", stderr: "", exitCode: 0 } as never);
      const result = await scan("/job/in.pdf", undefined, ["--database", "/defs/daily.cvd"], "/defs") as { status: string; databaseStatus: string };
      expect(result.databaseStatus).toBe("missing");
      expect(result.status).not.toBe("clean");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
