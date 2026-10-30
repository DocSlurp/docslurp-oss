import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import { teardownBreakerState } from "../sandbox/teardown-breaker.js";
import {
  CommandTeardownError,
  probePidNamespace,
  resetUnverifiedTeardownsForTests,
  spawnContained,
  superviseChild,
  unverifiedTeardownCount,
} from "../sandbox/teardown.js";
import { CommandRunner, resolveScriptsDir } from "../tools/runner.js";

// Reproduces the #234 round-7 council findings. Real processes and real bwrap where they matter.
const linux = process.platform === "linux";
const pidNamespace = linux && probePidNamespace().ok;
const bwrapAvailable = linux && spawnSync("bwrap", ["--version"]).status === 0;
const python = linux && existsSync("/usr/bin/python3") ? realpathSync("/usr/bin/python3") : "python3";
const pythonAvailable = spawnSync(python, ["-c", "pass"]).status === 0;
const filterArch = ["x64", "arm64"].includes(process.arch);

const roots: string[] = [];
const strays: number[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

beforeEach(() => resetUnverifiedTeardownsForTests());

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetUnverifiedTeardownsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function silence(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

/**
 * The reviewer's attack: park stdout and stderr in a self-referential SCM_RIGHTS cycle of socketpairs
 * and exit. Nothing in the sandbox references the cycle any more, but the descriptors stay open
 * until the kernel's next UNIX-socket garbage collection, which on a quiet host is seconds away.
 */
const CHAIN = String.raw`
import array, os, socket, sys
def send(sock, fds):
    sock.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))])
n = 64
sys.stdout.write("chain-start\n"); sys.stdout.flush()
pairs = [socket.socketpair() for _ in range(n)]
send(pairs[0][0], [1, 2])
for i in range(n):
    a, b = pairs[i]
    nxt = pairs[(i + 1) % n]
    send(a, [nxt[0].fileno(), nxt[1].fileno()])
for a, b in pairs:
    a.close(); b.close()
os._exit(0)
`;

/**
 * Holds every descriptor sent to `socketPath` for `seconds`: a stand-in, outside every namespace, for
 * the kernel holding a parked descriptor. Deterministic where the garbage collector's timing is not.
 */
const HOLDER = String.raw`
import array, os, socket, sys, time
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(sys.argv[1]); srv.listen(8)
print("ready", flush=True)
held = []
srv.settimeout(float(sys.argv[2]))
end = time.time() + float(sys.argv[2])
while time.time() < end:
    try:
        conn, _ = srv.accept()
    except socket.timeout:
        break
    msg, anc, _, _ = conn.recvmsg(16, socket.CMSG_SPACE(16 * 4))
    for level, kind, data in anc:
        fds = array.array("i"); fds.frombytes(data[: len(data) - len(data) % 4]); held.extend(fds)
    held.append(conn)
time.sleep(max(0, end - time.time()))
`;

/** A `bwrap` that hands its stdout and stderr to the holder, writes a line, and exits 0. */
const FAKE_BWRAP = String.raw`#!PYTHON
import array, os, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect(os.environ.get("DOCSLURP_TEST_HOLDER") or "HOLDER_SOCKET")
s.sendmsg([b"x"], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [1, 2]))])
sys.stdout.write("parked\n"); sys.stdout.flush()
os._exit(0)
`;

async function startHolder(dir: string, seconds: number): Promise<string> {
  const socketPath = path.join(dir, "holder.sock");
  const holder = spawn(python, ["-I", "-c", HOLDER, socketPath, String(seconds)], { stdio: ["ignore", "pipe", "inherit"] });
  strays.push(holder.pid!);
  await new Promise<void>((resolve, reject) => {
    holder.stdout.once("data", () => resolve());
    holder.once("exit", (code) => reject(new Error(`holder exited ${code}`)));
  });
  return socketPath;
}

describe("H1: the sandbox never holds the worker's stdio", () => {
  it.skipIf(!linux || !pythonAvailable)(
    "control: a command that parks its own stdout outside its namespace is an attributable teardown",
    async () => {
      silence();
      const dir = scratch("docslurp-h1-control-");
      const socketPath = await startHolder(dir, 20);
      const script = path.join(dir, "park.py");
      writeFileSync(script, FAKE_BWRAP.replace("#!PYTHON", `#!${python}`));
      const child = spawnContained(python, ["-I", script], {
        env: { PATH: process.env.PATH ?? "", DOCSLURP_TEST_HOLDER: socketPath },
        containment: pidNamespace ? "pid-namespace" : "process-group",
      });
      const supervised = superviseChild(child, {
        label: "park",
        timings: { graceMs: 200, launcherGraceMs: 200, verifyMs: 500, drainCapMs: 2_000 },
      });
      const error = await supervised.done.then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(CommandTeardownError);
      expect((error as CommandTeardownError).attributable).toBe(true);
    },
    30_000,
  );

  it.skipIf(!bwrapAvailable || !pidNamespace || !pythonAvailable || !filterArch)(
    "behind the launcher's relay, a parked descriptor holds only the relay's pipe: no teardown failure",
    async () => {
      const dir = scratch("docslurp-h1-relay-");
      const socketPath = await startHolder(dir, 20);
      // A fake bwrap first on PATH: the launcher and the relay run it in bwrap's place.
      const bin = path.join(dir, "bin");
      mkdirSync(bin);
      // The runner passes the command a filtered environment: bake the holder's path in.
      writeFileSync(path.join(bin, "bwrap"), FAKE_BWRAP.replace("#!PYTHON", `#!${python}`).replace("HOLDER_SOCKET", socketPath));
      chmodSync(path.join(bin, "bwrap"), 0o755);
      vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("WORKER_COMMAND_TEARDOWN_VERIFY_MS", "500");
      const config = { scratchRoot: path.join(dir, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "h1-relay" });
      const runner = new CommandRunner({ openSession: async () => session });
      const started = Date.now();
      const result = await runner.run({ binary: "/usr/bin/true", args: [], available: true });
      expect(result.stdout).toBe("parked\n");
      // It ended when the fake bwrap exited, not when the holder let go 20 s later.
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(unverifiedTeardownCount()).toBe(0);
      expect(teardownBreakerState().open).toBe(false);
    },
    30_000,
  );

  it.skipIf(!bwrapAvailable || !pidNamespace || !pythonAvailable || !filterArch)(
    "the SCM_RIGHTS chain under real bwrap ends cleanly, every time, without tripping the breaker",
    async () => {
      const root = scratch("docslurp-h1-chain-");
      const config = { scratchRoot: path.join(root, "sandbox"), writablePaths: [] };
      vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ROOT", config.scratchRoot);
      const session = await bubblewrap.openSession(config, { activityId: "h1-chain" });
      const runner = new CommandRunner({ openSession: async () => session });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await runner.run({ binary: python, args: ["-I", "-c", CHAIN], available: true });
        expect(result.stdout).toBe("chain-start\n");
      }
      expect(unverifiedTeardownCount()).toBe(0);
      expect(teardownBreakerState().open).toBe(false);
    },
    60_000,
  );

  it.skipIf(!linux)("the relay copies all output, keeps the exit status, and exits even while a descendant holds its pipe", () => {
    const relay = path.join(resolveScriptsDir(), "stdio-relay.pl");
    const big = spawnSync("perl", [relay, "sh", "-c", "head -c 3000000 /dev/zero; echo err >&2; exit 3"], { maxBuffer: 8e6 });
    expect(big.status).toBe(3);
    expect(big.stdout.length).toBe(3_000_000);
    expect(big.stderr.toString()).toBe("err\n");
    expect(spawnSync("perl", [relay, "sh", "-c", "kill -9 $$"]).status).toBe(137);
    expect(spawnSync("perl", [relay, "/nonexistent/binary"]).status).toBe(127);
    const started = Date.now();
    // The background sleep keeps the relay's inner pipe open for 10 s; the relay must not wait on it.
    const held = spawnSync("perl", [relay, "sh", "-c", "echo before; sleep 10 & exit 0"], { encoding: "utf8", timeout: 8_000 });
    expect(held.stdout).toBe("before\n");
    expect(held.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
