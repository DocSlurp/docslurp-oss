import { createServer } from "node:net";
import { buildSandboxCommand } from "../tools/runner.js";
import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { SandboxCommand } from "../sandbox/types.js";

const sandboxInputs = {
  scriptsDir: path.resolve("scripts"),
  scratchRoot: "/tmp/docslurp-parser-sandbox",
  configuredWritablePaths: [],
  limits: { timeoutMs: 10_000 },
};

/** Run a command through the real bubblewrap provider, as the runner does for local sessions. */
async function runThroughBubblewrap(command: SandboxCommand) {
  const session = await bubblewrap.openSession(bubblewrap.readConfig({}), { activityId: "test" });
  try {
    const child = session.spawn!(command);
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.stdout?.resume();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
    clearTimeout(timer);
    return { status, stderr };
  } finally {
    await session.close();
  }
}

it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))("isolates neighboring jobs and host process environments with real bubblewrap", () => {
  const root = mkdtempSync(path.join(tmpdir(), "docslurp-isolation-test-"));
  try {
    mkdirSync(path.join(root, "job"));
    mkdirSync(path.join(root, "other"));
    writeFileSync(path.join(root, "other", "secret"), "private");
    writeFileSync(path.join(root, "job", "input"), "input");
    const result = spawnSync("bash", [path.resolve("scripts/parser-sandbox.sh"), "/bin/bash", "-c",
      'test -r "$1/job/input" && test ! -e "$1/other/secret" && test ! -e "/proc/$2/environ" && printf output > "$1/job/output"',
      "probe", root, String(process.pid)], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, DOCSLURP_PARSER_SANDBOX_MODE: "isolated", DOCSLURP_PARSER_SANDBOX_TMP_ROOT: tmpdir(), DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS: path.join(root, "job") },
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    expect(readFileSync(path.join(root, "job", "output"), "utf8")).toBe("output");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))("preserves the antivirus daemon socket without exposing its neighboring files", async () => {
  const scannerRoot = mkdtempSync(path.join(tmpdir(), "docslurp-scanner-runtime-"));
  const job = mkdtempSync(path.join(tmpdir(), "docslurp-scanner-job-"));
  const socketPath = path.join(scannerRoot, "daemon.sock");
  const config = path.join(scannerRoot, "clamd.conf");
  const binary = path.join(scannerRoot, "clamdscan");
  const secret = path.join(scannerRoot, "neighbor-secret");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    writeFileSync(config, `LocalSocket ${socketPath}\n`);
    writeFileSync(secret, "private");
    writeFileSync(path.join(job, "input"), "input");
    writeFileSync(binary, `#!${process.execPath}\nconst fs = require('fs'); const net = require('net');
if (fs.existsSync(${JSON.stringify(secret)})) process.exit(2);
const conf = fs.readFileSync(process.argv[2].slice('--config-file='.length), 'utf8');
const socket = net.createConnection(conf.trim().split(/\\s+/)[1]);
socket.on('connect', () => { socket.destroy(); }); socket.on('error', () => process.exit(3));
`, { mode: 0o700 });
    const result = await runThroughBubblewrap(buildSandboxCommand({ plan: { binary, args: [`--config-file=${config}`, path.join(job, "input")], available: true }, venvBin: "/tmp/nonexistent-venv/bin", ...sandboxInputs }));
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(scannerRoot, { recursive: true, force: true });
    rmSync(job, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))("runs a venv interpreter whose bin/python3 is a symlink", async () => {
  const { symlinkSync } = await import("node:fs");
  const venv = mkdtempSync(path.join(tmpdir(), "docslurp-venv-test-"));
  const job = mkdtempSync(path.join(tmpdir(), "docslurp-venv-job-"));
  try {
    mkdirSync(path.join(venv, "bin"));
    // Same shape as `python3 -m venv`: bin/python3 -> python -> /usr/bin/...
    symlinkSync("/bin/sh", path.join(venv, "bin", "python"));
    symlinkSync("python", path.join(venv, "bin", "python3"));
    writeFileSync(path.join(job, "input"), "input");
    const plan = { binary: path.join(venv, "bin", "python3"), args: ["-c", 'test -r "$0"', path.join(job, "input")], available: true };
    const command = buildSandboxCommand({ plan, venvBin: path.join(venv, "bin"), ...sandboxInputs });
    expect(command.readablePaths).not.toContain(path.join(venv, "bin", "python3"));
    const result = await runThroughBubblewrap(command);
    expect(result.status, result.stderr).toBe(0);
  } finally {
    rmSync(venv, { recursive: true, force: true });
    rmSync(job, { recursive: true, force: true });
  }
});

// Debian and Ubuntu resolve some shared libraries and tools through
// /etc/alternatives (libblas.so.3 -> /etc/alternatives/... for ffmpeg on
// trixie). Without that directory in the sandbox, ffprobe exits 127 and
// every audio and video upload fails.
const alternativesLink = existsSync("/etc/alternatives")
  ? spawnSync("find", ["/usr/bin", "/usr/lib", "-maxdepth", "3", "-type", "l", "-lname", "/etc/alternatives/*", "-print", "-quit"], { encoding: "utf8" }).stdout.trim()
  : "";
it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !alternativesLink)("resolves /etc/alternatives symlinks inside the sandbox", () => {
  const result = spawnSync("bash", [path.resolve("scripts/parser-sandbox.sh"), "/bin/bash", "-c", 'test -e "$(readlink -f "$1")"', "probe", alternativesLink], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, DOCSLURP_PARSER_SANDBOX_MODE: "isolated", DOCSLURP_PARSER_SANDBOX_TMP_ROOT: tmpdir() },
  });
  expect(result.status, `${alternativesLink}: ${result.stderr || result.error?.message}`).toBe(0);
});

it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap") || !existsSync("/usr/bin/ffprobe"))("runs ffprobe inside the sandbox", () => {
  const result = spawnSync("bash", [path.resolve("scripts/parser-sandbox.sh"), "/usr/bin/ffprobe", "-version"], {
    encoding: "utf8", timeout: 10_000,
    env: { PATH: process.env.PATH, DOCSLURP_PARSER_SANDBOX_MODE: "isolated", DOCSLURP_PARSER_SANDBOX_TMP_ROOT: tmpdir() },
  });
  expect(result.status, result.stderr || result.error?.message).toBe(0);
});
