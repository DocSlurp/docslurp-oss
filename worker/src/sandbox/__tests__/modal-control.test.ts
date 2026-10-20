import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { killArgv, launchArgv } from "../providers/modal/control.js";

/** Run an argv locally, the way Modal runs it remotely, and collect its exit status and output. */
function run(argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("modal remote control scripts (run locally with /bin/sh)", () => {
  let dir: string;
  let control: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-control-"));
    control = path.join(dir, "1");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes the command's exit code, output and arguments through", async () => {
    const result = await run(launchArgv(control, "/bin/sh", ["-c", 'printf "%s|" "$@"; echo err >&2; exit 3', "sh", "a b", "$c"]));
    expect(result).toEqual({ exitCode: 3, stdout: "a b|$c|", stderr: "err\n" });
  });

  it("reports a death by signal as 128+N with nothing extra on stderr", async () => {
    const result = await run(launchArgv(control, "/bin/sh", ["-c", "kill -s SEGV $$"]));
    expect(result.exitCode).toBe(139);
    expect(result.stderr).toBe("");
  });

  it("kills the command's whole process group, children included", async () => {
    const childPidFile = path.join(dir, "child.pid");
    const launched = run(launchArgv(control, "/bin/sh", ["-c", `sleep 30 & echo $! > "${childPidFile}"; wait`]));
    await vi.waitFor(() => expect(existsSync(childPidFile) && readFileSync(childPidFile, "utf8").trim()).toBeTruthy());
    const childPid = Number(readFileSync(childPidFile, "utf8"));
    const started = Date.now();
    expect((await run(killArgv(control))).exitCode).toBe(0);
    const result = await launched;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.exitCode).toBe(137);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false));
  });

  it("stops a command from starting when the kill lands first", async () => {
    const marker = path.join(dir, "ran");
    expect((await run(killArgv(control))).exitCode).toBe(0);
    const result = await run(launchArgv(control, "/bin/sh", ["-c", `: > "${marker}"`]));
    expect(result.exitCode).toBe(137);
    expect(existsSync(marker)).toBe(false);
  });

  it("is a no-op for a command that already finished", async () => {
    await run(launchArgv(control, "/bin/sh", ["-c", "exit 0"]));
    expect((await run(killArgv(control))).exitCode).toBe(0);
  });
});
