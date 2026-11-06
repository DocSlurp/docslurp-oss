import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KILL_PARSER_USER_ARGV, killArgv, launchArgv } from "../providers/modal/control.js";

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

describe("parser commands drop root in the VM (validation N10, council K #4/#5)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "docslurp-modal-uid-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Fake tools at absolute paths (as the VM's /usr/bin/id, setpriv, chown): `id` reports `uid`, chown and setpriv record
   * their arguments, setpriv then runs the command. Returns the tools for launchArgv.
   */
  function fakeTools(uid: string | null, withSetpriv = true) {
    const bin = path.join(dir, "abs");
    const log = path.join(dir, "calls");
    mkdirSync(bin);
    const write = (name: string, body: string) => { writeFileSync(path.join(bin, name), body); chmodSync(path.join(bin, name), 0o755); };
    write("id", uid === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\necho ${uid}\n`);
    write("chown", `#!/bin/sh\necho "chown $*" >> "${log}"\n`);
    if (withSetpriv) write("setpriv", `#!/bin/sh\necho "setpriv $*" >> "${log}"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n`);
    return { id: path.join(bin, "id"), setpriv: path.join(bin, "setpriv") };
  }
  /** A PATH whose `id` claims a non-root user and whose setpriv/chown do nothing: the launch must never use them. */
  function hostilePath(): string {
    const bin = path.join(dir, "hostile");
    mkdirSync(bin);
    for (const [name, body] of [["id", "#!/bin/sh\necho 1000\n"], ["setpriv", "#!/bin/sh\nexit 0\n"], ["chown", "#!/bin/sh\nexit 0\n"]]) {
      writeFileSync(path.join(bin, name!), body!); chmodSync(path.join(bin, name!), 0o755);
    }
    return bin;
  }
  const runWithPath = (argv: string[], PATH: string) => new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env: { PATH } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c)); child.stderr.on("data", (c) => (stderr += c));
    child.once("error", reject); child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });

  it.each([["an empty PATH", () => ""], ["a hostile PATH", () => ""]])("as root under %s, runs through the absolute setpriv and changes no ownership", async (label) => {
    const tools = fakeTools("0");
    const out = path.join(dir, "out with space"); mkdirSync(out);
    const PATH = label === "a hostile PATH" ? hostilePath() : "";
    const result = await runWithPath(launchArgv(path.join(dir, "1"), "/bin/echo", ["a b"], [out, path.join(dir, "missing")], tools), PATH);
    expect(result).toMatchObject({ exitCode: 0, stdout: "a b\n" });
    // Root changes no ownership in the job tree (staging creates it as uid 10001, council O #4): only setpriv runs.
    expect(readFileSync(path.join(dir, "calls"), "utf8").split("\n").filter(Boolean)).toEqual([
      "setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs -- /bin/echo a b",
    ]);
  });

  it("as root without setpriv at its absolute path, refuses even when PATH offers one", async () => {
    const tools = fakeTools("0", false);
    const marker = path.join(dir, "ran");
    const result = await runWithPath(launchArgv(path.join(dir, "1"), "/bin/sh", ["-c", `: > "${marker}"`], [], tools), hostilePath());
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/setpriv unavailable/);
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses when the uid cannot be read, instead of running as whoever it is", async () => {
    const tools = fakeTools(null);
    const marker = path.join(dir, "ran");
    const result = await runWithPath(launchArgv(path.join(dir, "1"), "/bin/sh", ["-c", `: > "${marker}"`], [], tools), "");
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toMatch(/cannot read the uid/);
    expect(existsSync(marker)).toBe(false);
  });

  it("a hostile PATH cannot make root look unprivileged: the real /usr/bin/id decides", async () => {
    const result = await runWithPath(launchArgv(path.join(dir, "1"), "/usr/bin/id", ["-u"], [dir]), hostilePath());
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(String(process.getuid!()));
  });
});

function spawnSyncShell(script: string): void { spawnSync("/bin/sh", ["-c", script], { stdio: "ignore" }); }

// The leftover kill against a process that keeps forking and exiting its parent (recheck Q #2), in a real (unprivileged)
// container as root: the /proc scan it replaced exited 0 with this process alive. Needs docker and the image below.
const dockerKillTest = process.env.DOCSLURP_DOCKER_TESTS === "1";
describe.skipIf(!dockerKillTest)("leftover kill in a container (recheck Q #2)", () => {
  it("kills a fork-hopping parser-user process and verifies it is gone", async () => {
    const hopper = [
      "import os, sys",
      "os.setgroups([]); os.setresgid(10001, 10001, 10001); os.setresuid(10001, 10001, 10001)",
      "if os.fork(): os._exit(0)",
      "os.setsid(); n = 0",
      "while True:",
      "    n += 1",
      "    if n % 50 == 0: open('/w/hb', 'w').write(str(n))",
      "    if os.fork(): os._exit(0)",
    ].join("\n");
    const script = [
      "mkdir -p /w && chmod 1777 /w",
      'python3 -c "$HOPPER"; python3 -c "$HOPPER"; sleep 0.5',
      'a=$(cat /w/hb); sleep 0.3; b=$(cat /w/hb); [ "$a" != "$b" ] || { echo not-started; exit 1; }',
      '"$@"; echo "kill=$?"; sleep 0.3',
      'a=$(cat /w/hb); sleep 0.5; b=$(cat /w/hb); [ "$a" = "$b" ] && echo dead || echo alive',
    ].join("\n");
    const run = spawnSync("docker", ["run", "--rm", "--network", "none", "-e", `HOPPER=${hopper}`, "python:3.11-slim-bookworm", "sh", "-c", script, "sh", ...KILL_PARSER_USER_ARGV], { encoding: "utf8", timeout: 120_000 });
    expect(run.stdout).toContain("kill=0");
    expect(run.stdout.trim().split("\n").at(-1)).toBe("dead");
  }, 150_000);
});

// Council V #4: the per-command cgroup path, end to end in a container with its own cgroup namespace (cgroup v2, writable
// as in a parser VM). The real launch script puts the command in /sys/fs/cgroup/docslurp-cmd-<n> as root before dropping to
// uid 10001; the real leftover kill must then report method=cgroup and beat both a process that SIGSTOPs everything it may
// and one that keeps forking. Without the cgroup path these assertions fail (method=kill-1, no cgroup).
describe.skipIf(!dockerKillTest)("leftover kill uses the command cgroup (council V #4)", () => {
  const stopper = "import os, signal, time\nwhile True:\n    try: os.kill(-1, signal.SIGSTOP)\n    except OSError: pass\n    time.sleep(0.001)";
  const hopper = "import os\nn = 0\nwhile True:\n    n += 1\n    if n % 50 == 0: open('/w/hb', 'w').write(str(n))\n    if os.fork(): os._exit(0)";
  const runInContainer = (attack: string) => {
    const argv = launchArgv("/tmp/.docslurp-modal-control/7", "python3", ["-c", attack]);
    const script = [
      "mount -o remount,rw /sys/fs/cgroup 2>/dev/null || true",
      "mkdir -p /w /tmp/.docslurp-modal-control && chmod 1777 /w",
      'count() { for d in /proc/[0-9]*; do awk \'/^Uid:/{print $2}\' "$d/status" 2>/dev/null; done | grep -c "^10001$"; }',
      '"$@" &',
      "sleep 0.7",
      'echo "cgroup=$(ls -d /sys/fs/cgroup/docslurp-cmd-7 2>/dev/null)"',
      'echo "before=$(count)"',
      'a=$(cat /w/hb 2>/dev/null); sleep 0.3; b=$(cat /w/hb 2>/dev/null); [ -n "$b" ] && [ "$a" != "$b" ] && echo hopper=running',
      'timeout 60 python3 -I -c "$KILL" 10001; echo "kill=$?"',
      "sleep 0.5",
      'echo "after=$(count)"',
      'a=$(cat /w/hb 2>/dev/null); sleep 0.5; b=$(cat /w/hb 2>/dev/null); [ "$a" = "$b" ] && echo hopper=still',
    ].join("\n");
    return spawnSync("docker", ["run", "--rm", "--network", "none", "--cgroupns", "private", "--cap-add", "SYS_ADMIN", "-e", `KILL=${KILL_PARSER_USER_ARGV[3]}`,
      "python:3.11-slim-bookworm", "sh", "-c", script, "sh", ...argv], { encoding: "utf8", timeout: 120_000 });
  };

  it("kills a process that SIGSTOPs everything it may, through cgroup.kill", () => {
    const run = runInContainer(stopper);
    expect(run.stdout).toContain("cgroup=/sys/fs/cgroup/docslurp-cmd-7");
    expect(run.stdout).toMatch(/before=[1-9]/);
    expect(run.stdout).toContain("[leftover-kill] method=cgroup cgroups=1");
    expect(run.stdout).toContain("kill=0");
    expect(run.stdout).toContain("after=0");
  }, 150_000);

  it("kills a fork-hopper, through cgroup.kill", () => {
    const run = runInContainer(hopper);
    expect(run.stdout).toContain("cgroup=/sys/fs/cgroup/docslurp-cmd-7");
    expect(run.stdout).toContain("hopper=running");
    expect(run.stdout).toContain("[leftover-kill] method=cgroup cgroups=1");
    expect(run.stdout).toContain("kill=0");
    expect(run.stdout).toContain("hopper=still");
    expect(run.stdout).toContain("after=0");
  }, 150_000);
});
