import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { defineSandboxContract, execInSession } from "./contract.js";
import landlock, { landrunArgs, landrunScopesUnixSockets, networkForKernel } from "../providers/landlock/index.js";
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

// #234 round 7 (L1): landrun v0.1.17 scopes UNIX sockets, so landlock counts as socket-filtering.
describe("landlock scopes UNIX sockets (real landrun)", () => {
  const python = existsSync("/usr/bin/python3") ? realpathSync("/usr/bin/python3") : "";
  const CONNECT = String.raw`
import errno, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    s.connect(sys.argv[1].replace("@", "\0", 1)); print("connected")
except OSError as e:
    print(errno.errorcode.get(e.errno, e.errno))
`;
  const LISTEN = String.raw`
import socket, sys, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1].replace("@", "\0", 1)); s.listen(4); s.settimeout(float(sys.argv[2]))
print("listening", flush=True)
try:
    c, _ = s.accept(); print("accepted", flush=True)
except socket.timeout:
    print("no-connection", flush=True)
`;
  const command = (args: string[], writablePaths: string[] = []) => ({
    binary: python,
    args: ["-I", "-c", ...args],
    env: { PATH: "/usr/bin:/bin" },
    readablePaths: [],
    inputPaths: [],
    writablePaths,
    limits: { timeoutMs: 20_000 },
  });

  async function hostListener(address: string): Promise<{ stop(): void; accepted(): boolean }> {
    const child = spawn(python, ["-I", "-c", LISTEN, address, "8"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    await new Promise<void>((resolve) => child.stdout.on("data", (chunk) => ((out += chunk), out.includes("listening") && resolve())));
    return { stop: () => child.kill("SIGKILL"), accepted: () => out.includes("accepted") };
  }

  it("refuses an abstract connect to the host (EPERM) and a pathname connect without --unix (EACCES); the session filters", async (ctx) => {
    const config = landlock.readConfig(landlockEnv);
    const probe = await landlock.probe(config);
    if (!probe.ok || !python) ctx.skip(`landlock or python unavailable: ${probe.detail}`);
    const session = await landlock.openSession(config, { activityId: "scoping" });
    expect(session.filtersUnixSockets).toBe(true);
    // Positive control: the host itself connects to both.
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-landlock-sockets-"));
    try {
      const abstract = `@docslurp-landlock-${process.pid}-${Date.now()}`;
      const host = await hostListener(abstract);
      const sandboxed = await execInSession(session, command([CONNECT, abstract]));
      expect(sandboxed.stdout.trim(), sandboxed.stderr).toBe("EPERM");
      host.stop();
      const pathname = path.join(dir, "host.sock");
      const hostPath = await hostListener(pathname);
      const denied = await execInSession(session, command([CONNECT, pathname], [dir]));
      expect(denied.stdout.trim(), denied.stderr).toBe("EACCES");
      expect(hostPath.accepted()).toBe(false);
      hostPath.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two commands cannot meet: a pathname or abstract socket of one sandbox refuses the other", async (ctx) => {
    const config = landlock.readConfig(landlockEnv);
    const probe = await landlock.probe(config);
    if (!probe.ok || !python) ctx.skip(`landlock or python unavailable: ${probe.detail}`);
    const session = await landlock.openSession(config, { activityId: "between" });
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-landlock-shared-"));
    try {
      for (const address of [path.join(dir, "a.sock"), `@docslurp-landlock-between-${process.pid}-${Date.now()}`]) {
        const listener = execInSession(session, command([LISTEN, address, "4"], [dir]));
        // Wait until the listener is up (pathname: the socket file exists; abstract: a short delay).
        for (let i = 0; i < 100 && address.startsWith("/") && !existsSync(address); i += 1) await new Promise((r) => setTimeout(r, 25));
        if (!address.startsWith("/")) await new Promise((r) => setTimeout(r, 500));
        const other = await execInSession(session, command([CONNECT, address], [dir]));
        expect([address.startsWith("/") ? "pathname" : "abstract", other.stdout.trim()]).toEqual([
          address.startsWith("/") ? "pathname" : "abstract",
          address.startsWith("/") ? "EACCES" : "EPERM",
        ]);
        expect((await listener).stdout).toMatch(/listening\s+no-connection/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("only clamdscan gets --unix, and only for a socket among its readable paths", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "docslurp-landlock-clamd-"));
    try {
      const socketPath = path.join(dir, "clamd.ctl");
      const file = path.join(dir, "clamd.conf");
      writeFileSync(file, `LocalSocket ${socketPath}\n`);
      const server = spawn(python || "python3", ["-I", "-c", "import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); time.sleep(5)", socketPath]);
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!existsSync(socketPath)) return setTimeout(check, 20);
          try {
            const base = { args: [], env: {}, readablePaths: [file, socketPath], writablePaths: [] };
            const clamd = landrunArgs({ ...base, binary: "/usr/bin/clamdscan" });
            expect(clamd.slice(clamd.indexOf("--unix"), clamd.indexOf("--unix") + 2)).toEqual(["--unix", socketPath]);
            expect(clamd[clamd.indexOf("--ro") + 1]).not.toContain(socketPath);
            expect(landrunArgs({ ...base, binary: "/usr/bin/pdftotext" })).not.toContain("--unix");
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            server.kill("SIGKILL");
          }
        };
        check();
      });
    } finally {
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 100);
    }
  });

  it("an older landrun is not trusted to scope sockets", () => {
    expect(landrunScopesUnixSockets("landrun version 0.1.17")).toBe(true);
    expect(landrunScopesUnixSockets("landrun version 0.2.0")).toBe(true);
    expect(landrunScopesUnixSockets("landrun version 0.1.16")).toBe(false);
    expect(landrunScopesUnixSockets("landrun version 0.1.12")).toBe(false);
    expect(landrunScopesUnixSockets("garbage")).toBe(false);
  });

  it("the runner now runs a socketless tool under landlock, in production, without the opt-in", async (ctx) => {
    const config = landlock.readConfig(landlockEnv);
    const probe = await landlock.probe(config);
    if (!probe.ok) ctx.skip(`landlock unavailable: ${probe.detail}`);
    try {
      const session = await landlock.openSession(config, { activityId: "socket-filter" });
      const runner = new CommandRunner({ openSession: async () => session });
      vi.stubEnv("DOCSLURP_SANDBOX_ALLOW_UNFILTERED_SOCKETS", "");
      vi.stubEnv("NODE_ENV", "production");
      const result = await runner.run({ binary: "/usr/bin/pdftotext", args: ["-v"], available: true });
      expect(result.stderr).toMatch(/pdftotext version/);
      // A session without scoping (an older landrun) still refuses it.
      const unscoped = { ...session, filtersUnixSockets: false };
      const refusing = new CommandRunner({ openSession: async () => unscoped });
      await expect(refusing.run({ binary: "/usr/bin/pdftotext", args: ["-v"], available: true })).rejects.toBeInstanceOf(SandboxPolicyError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
