import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";

import { readSandboxConfig } from "../../config-schema.js";
import { spawnOwned, startSandboxScratchSweeper } from "../../scratch-sweep.js";
import { probePidNamespace, spawnContained, stdioRelay } from "../../teardown.js";
import type {
  ParserSandboxProvider,
  SandboxCommand,
  SandboxConfigSchema,
  SandboxIsolation,
  SandboxNetworkIsolation,
} from "../../types.js";

export interface LandlockConfig {
  /**
   * landrun executable (a release >= v0.1.12, MIT; pinned in worker/sandbox-tools.json),
   * resolved against the worker's PATH once so the probe and every command run the same file.
   */
  binary: string;
  scratchRoot: string;
  /** Extra private DocSlurp workspaces the runner merges into every command's writable paths. */
  writablePaths: string[];
}

const PROBE_TIMEOUT_MS = 10_000;
// System locations a dynamically linked parser needs to start; missing ones are skipped.
const RUNTIME_PATHS = ["/usr", "/lib", "/lib64", "/bin", "/etc"];
// Read-only caches. Without the fontconfig cache, every poppler run rescans the system fonts.
const READ_ONLY_RUNTIME_PATHS = ["/var/cache/fontconfig"];

const configSchema: SandboxConfigSchema = {
  type: "object",
  properties: {
    binary: {
      type: "string",
      description: "Path or name of the landrun executable.",
      default: "landrun",
      env: "DOCSLURP_LANDRUN_BINARY",
    },
    scratchRoot: {
      type: "string",
      description: "Host directory for per-command sandbox scratch space.",
      default: "/tmp/docslurp-parser-sandbox",
      env: "DOCSLURP_PARSER_SANDBOX_ROOT",
    },
    writablePaths: {
      type: "string",
      description: "Comma-separated private DocSlurp temporary workspaces every parser command may write.",
      default: "",
      env: "DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS",
    },
  },
};

/** Landlock TCP connect/bind rules arrived with ABI v4 in Linux 6.7/6.8; older kernels leave the network open.
 * In practice the "none" branch is unreachable with landrun v0.1.17: it needs Landlock ABI v9, so
 * the probe fails on any kernel below that and this function is never reached. Kept as a guard. */
export function networkForKernel(kernelRelease: string): SandboxNetworkIsolation {
  const match = /^(\d+)\.(\d+)/.exec(kernelRelease);
  if (!match) return "none";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 6 || (major === 6 && minor >= 8) ? "tcp-only" : "none";
}

/**
 * Landlock confines files and TCP but not processes; each command also runs in its own PID namespace.
 * UNIX sockets: landrun v0.1.17 (which needs Landlock ABI v9) scopes every command by default. A
 * connect() to an abstract socket created outside the command's own domain fails with EPERM (the
 * host's, another command's), and a connect() to a pathname socket fails with EACCES unless it is
 * granted with `--unix` (granted only to clamdscan, for clamd's socket). So two commands cannot
 * meet on a socket, and a parser cannot reach a host service (a session bus, a systemd user
 * manager). These are LSM checks on connect and sendmsg, so io_uring's socket operations meet them
 * too. Proven against the real binary in sandbox/__tests__/contract-landlock.test.ts; an older
 * landrun is not trusted to do it (MIN_SCOPED_LANDRUN).
 */
function isolationFor(kernelRelease: string): SandboxIsolation {
  return { filesystem: true, network: networkForKernel(kernelRelease), processes: probePidNamespace().ok, location: "local" };
}

/** Grantable paths that exist. landrun splits a grant list on commas, so a comma in a path fails closed. */
function existing(paths: string[]): string[] {
  for (const candidate of paths) {
    if (candidate.includes(",")) throw new Error(`landrun cannot grant a path containing a comma: ${candidate}`);
  }
  return paths.filter((candidate) => existsSync(candidate));
}

function pathFlags(flag: string, paths: string[]): string[] {
  return paths.length > 0 ? [flag, paths.join(",")] : [];
}

/** Resolve a bare executable name against `searchPath`; paths are made absolute. Unresolved names are returned as is. */
export function resolveExecutable(binary: string, searchPath: string): string {
  if (binary.includes(path.sep)) return path.resolve(binary);
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.resolve(directory, binary);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next directory */
    }
  }
  return binary;
}

/**
 * Per-command private scratch, the same layout and variables as the bubblewrap launcher
 * (worker/scripts/parser-sandbox.sh): parsers such as soffice need a writable $HOME, and
 * Python's tempfile a writable $TMPDIR. Landlock otherwise grants no write access to them.
 */
export function createCommandScratch(scratchRoot: string): { dir: string; cwd: string; env: Record<string, string> } {
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(path.join(scratchRoot, "run-"));
  const tmp = path.join(dir, "tmp");
  const env = {
    HOME: path.join(dir, "home"),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: path.join(dir, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
    XDG_DATA_HOME: path.join(dir, "xdg-data"),
  };
  const cwd = path.join(dir, "work");
  for (const directory of [...new Set(Object.values(env)), cwd]) mkdirSync(directory, { recursive: true });
  return { dir, cwd, env };
}

/** The first landrun release that scopes pathname UNIX-socket connects (Landlock ABI v9). */
export const MIN_SCOPED_LANDRUN = [0, 1, 17] as const;

/** Whether `landrun --version` output names a release that scopes UNIX sockets. */
export function landrunScopesUnixSockets(versionOutput: string): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput);
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (version[index]! !== MIN_SCOPED_LANDRUN[index]) return version[index]! > MIN_SCOPED_LANDRUN[index]!;
  }
  return true;
}

function isSocket(candidate: string): boolean {
  try {
    return statSync(candidate).isSocket();
  } catch {
    return false;
  }
}

export function landrunArgs(
  command: Pick<SandboxCommand, "binary" | "args" | "env" | "readablePaths" | "writablePaths">,
): string[] {
  const executable = path.isAbsolute(command.binary) ? [command.binary] : [];
  // landrun clears the environment. Bare `--env KEY` forwards the value from landrun's own
  // environment (set from command.env at spawn), so values never appear in argv or /proc.
  const envFlags = Object.entries(command.env)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key]) => ["--env", key]);
  // Only clamdscan may connect to a pathname socket: clamd's, which paths.ts makes readable for it.
  const sockets = path.basename(command.binary) === "clamdscan" ? existing(command.readablePaths).filter(isSocket) : [];
  return [
    ...envFlags,
    ...pathFlags("--rox", existing([...RUNTIME_PATHS, ...executable])),
    ...pathFlags("--ro", existing([...READ_ONLY_RUNTIME_PATHS, ...command.readablePaths]).filter((candidate) => !sockets.includes(candidate))),
    ...pathFlags("--rw", existing(command.writablePaths)),
    ...sockets.flatMap((socket) => ["--unix", socket]),
    "--",
    command.binary,
    ...command.args,
  ];
}

export const landlockProvider: ParserSandboxProvider<LandlockConfig> = {
  id: "landlock",
  name: "Landlock (landrun)",
  description: "Runs each parser under a Landlock LSM filesystem and TCP policy applied by landrun.",
  configSchema,
  readConfig(env) {
    const raw = readSandboxConfig<{ binary: string; scratchRoot: string; writablePaths: string }>(configSchema, env);
    return {
      binary: resolveExecutable(raw.binary, env.PATH ?? ""),
      scratchRoot: raw.scratchRoot,
      writablePaths: raw.writablePaths
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  },
  async probe(config) {
    const kernel = release();
    const isolation = isolationFor(kernel);
    const result = spawnSync(
      config.binary,
      ["--rox", existing(["/usr", "/lib", "/lib64"]).join(","), "--", "/usr/bin/true"],
      { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: PROBE_TIMEOUT_MS },
    );
    if (result.status === 0) {
      // Without a PID namespace a parser's descendants could outlive it: fail closed.
      if (!isolation.processes) return { ok: false, isolation, detail: `${probePidNamespace().detail} (kernel ${kernel})` };
      // Every command runs behind the stdio relay; without perl or the script, refuse to start.
      try {
        stdioRelay();
      } catch (error) {
        return { ok: false, isolation, detail: (error as Error).message };
      }
      return { ok: true, isolation, detail: `landrun available (kernel ${kernel})` };
    }
    const reason =
      result.stderr?.trim() || result.error?.message || `landrun exited with status ${result.status}`;
    return { ok: false, isolation, detail: `${reason} (kernel ${kernel})` };
  },
  async openSession(config) {
    const isolation = isolationFor(release());
    startSandboxScratchSweeper(config.scratchRoot);
    // Socket scoping (see isolationFor) only from a landrun that does it; otherwise the runner refuses
    // commands that ask for the filter (tools/runner.ts assertUnixSocketFilter).
    const version = spawnSync(config.binary, ["--version"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: { PATH: process.env.PATH ?? "" } });
    const filtersUnixSockets = version.status === 0 && landrunScopesUnixSockets(version.stdout);
    return {
      providerId: "landlock",
      isolation,
      filtersUnixSockets,
      spawn: (command) => {
        const scratch = createCommandScratch(config.scratchRoot);
        const cleanup = () => {
          rmSync(scratch.dir, { recursive: true, force: true });
          rmSync(`${scratch.dir}.owner`, { force: true });
        };
        const sandboxed = {
          ...command,
          env: { ...command.env, ...scratch.env },
          writablePaths: [...command.writablePaths, scratch.dir],
        };
        // The stdio relay is the namespace's PID 1 (outside the Landlock domain, which cannot
        // ptrace out of it): it forwards TERM, reaps orphans, gives landrun pipes of its own, and on
        // exit kills what the command left before closing ours. The parser landrun execs keeps
        // default SIGTERM and SIGPIPE handling. Scratch is removed only once every process of the
        // command is gone; a poisoned command keeps it for the sweep.
        const [relay, ...relayArgs] = stdioRelay();
        return spawnOwned(
          scratch.dir,
          () =>
            spawnContained(relay!, [...relayArgs, config.binary, ...landrunArgs(sandboxed)], {
              env: sandboxed.env,
              cwd: scratch.cwd,
              containment: "pid-namespace",
              stdioRelayed: true,
            }),
          cleanup,
        );
      },
      close: async () => {},
    };
  },
};

export default landlockProvider as unknown as ParserSandboxProvider;
