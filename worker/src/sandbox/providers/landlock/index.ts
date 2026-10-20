import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { release } from "node:os";
import path from "node:path";

import { readSandboxConfig } from "../../config-schema.js";
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

/** Landlock TCP connect/bind rules arrived with ABI v4 in Linux 6.7/6.8; older kernels leave the network open. */
export function networkForKernel(kernelRelease: string): SandboxNetworkIsolation {
  const match = /^(\d+)\.(\d+)/.exec(kernelRelease);
  if (!match) return "none";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 6 || (major === 6 && minor >= 8) ? "tcp-only" : "none";
}

function isolationFor(kernelRelease: string): SandboxIsolation {
  return { filesystem: true, network: networkForKernel(kernelRelease), processes: false, location: "local" };
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

export function landrunArgs(
  command: Pick<SandboxCommand, "binary" | "args" | "env" | "readablePaths" | "writablePaths">,
): string[] {
  const executable = path.isAbsolute(command.binary) ? [command.binary] : [];
  // landrun clears the environment. Bare `--env KEY` forwards the value from landrun's own
  // environment (set from command.env at spawn), so values never appear in argv or /proc.
  const envFlags = Object.entries(command.env)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key]) => ["--env", key]);
  return [
    ...envFlags,
    ...pathFlags("--rox", existing([...RUNTIME_PATHS, ...executable])),
    ...pathFlags("--ro", existing([...READ_ONLY_RUNTIME_PATHS, ...command.readablePaths])),
    ...pathFlags("--rw", existing(command.writablePaths)),
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
      return { ok: true, isolation, detail: `landrun available (kernel ${kernel})` };
    }
    const reason =
      result.stderr?.trim() || result.error?.message || `landrun exited with status ${result.status}`;
    return { ok: false, isolation, detail: `${reason} (kernel ${kernel})` };
  },
  async openSession(config) {
    const isolation = isolationFor(release());
    return {
      providerId: "landlock",
      isolation,
      spawn: (command, signal) => {
        const scratch = createCommandScratch(config.scratchRoot);
        const cleanup = () => rmSync(scratch.dir, { recursive: true, force: true });
        try {
          const sandboxed = {
            ...command,
            env: { ...command.env, ...scratch.env },
            writablePaths: [...command.writablePaths, scratch.dir],
          };
          const child = spawn(config.binary, landrunArgs(sandboxed), {
            env: sandboxed.env,
            cwd: scratch.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            signal,
          });
          // 'close' follows a normal exit, a kill or abort, and a failed spawn alike.
          child.once("close", cleanup);
          return child;
        } catch (error) {
          cleanup();
          throw error;
        }
      },
      close: async () => {},
    };
  },
};

export default landlockProvider as unknown as ParserSandboxProvider;
