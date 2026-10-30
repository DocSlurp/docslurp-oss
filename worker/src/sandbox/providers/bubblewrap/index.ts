import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveScriptsDir } from "../../../tools/scripts-dir.js";
import { readSandboxConfig } from "../../config-schema.js";
import { spawnOwned, startSandboxScratchSweeper } from "../../scratch-sweep.js";
import { ensureSeccompFilterFile, seccompSupported } from "../../seccomp.js";
import { probePidNamespace, runContained, spawnContained } from "../../teardown.js";
import type {
  ParserSandboxProvider,
  SandboxCommand,
  SandboxConfigSchema,
  SandboxIsolation,
} from "../../types.js";

export interface BubblewrapConfig {
  scratchRoot: string;
  /** Extra private DocSlurp workspaces the runner merges into every command's writable paths. */
  writablePaths: string[];
}

const ISOLATION: SandboxIsolation = { filesystem: true, network: "full", processes: true, location: "local" };
const PROBE_TIMEOUT_MS = 10_000;

const configSchema: SandboxConfigSchema = {
  type: "object",
  properties: {
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

function launcherPath(): string {
  return path.join(resolveScriptsDir(), "parser-sandbox.sh");
}

function launcherEnv(config: BubblewrapConfig, command: Pick<SandboxCommand, "readablePaths" | "writablePaths">) {
  return {
    DOCSLURP_PARSER_SANDBOX_READABLE_PATHS: command.readablePaths.join(","),
    DOCSLURP_PARSER_SANDBOX_ROOT: config.scratchRoot,
    DOCSLURP_PARSER_SANDBOX_TMP_ROOT: path.resolve(tmpdir()),
    DOCSLURP_PARSER_SANDBOX_WRITABLE_PATHS: command.writablePaths.join(","),
  };
}

export const bubblewrapProvider: ParserSandboxProvider<BubblewrapConfig> = {
  id: "bubblewrap",
  name: "Bubblewrap",
  description: "Runs each parser in a bubblewrap namespace sandbox via worker/scripts/parser-sandbox.sh.",
  configSchema,
  readConfig(env) {
    const raw = readSandboxConfig<{ scratchRoot: string; writablePaths: string }>(configSchema, env);
    return {
      scratchRoot: raw.scratchRoot,
      writablePaths: raw.writablePaths
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  },
  async probe(config) {
    // Every command runs under a seccomp filter (sandbox/seccomp.ts); without one, refuse to start.
    if (!seccompSupported()) {
      return { ok: false, isolation: ISOLATION, detail: `no seccomp filter for architecture ${process.arch}` };
    }
    // bwrap's own PID namespace holds the parser; the outer one (see openSession) holds the launcher.
    const pidNamespace = probePidNamespace();
    if (!pidNamespace.ok) return { ok: false, isolation: { ...ISOLATION, processes: false }, detail: pidNamespace.detail };
    // Probe exactly as commands run: the launcher as init of its own PID namespace, under the
    // stricter filter, so a host that cannot nest bwrap's namespace inside it (or install the
    // filter) stops the worker here instead of failing every command.
    let detail: string;
    try {
      mkdirSync(config.scratchRoot, { recursive: true, mode: 0o700 });
      const seccomp = ensureSeccompFilterFile(config.scratchRoot, "deny-unix-sockets");
      const result = await runContained(launcherPath(), ["/usr/bin/true"], {
        env: {
          PATH: process.env.PATH ?? "",
          ...launcherEnv(config, { readablePaths: [], writablePaths: [] }),
          DOCSLURP_PARSER_SANDBOX_SECCOMP: seccomp,
        },
        containment: "pid-namespace",
        timeoutMs: PROBE_TIMEOUT_MS,
        label: "bubblewrap-probe",
      });
      if (result.code === 0 && !result.reason) return { ok: true, isolation: ISOLATION, detail: "bubblewrap available" };
      detail = result.reason?.message || result.stderr.trim() || `launcher exited with status ${result.code}`;
    } catch (error) {
      detail = (error as Error).message;
    }
    return { ok: false, isolation: ISOLATION, detail };
  },
  async openSession(config) {
    startSandboxScratchSweeper(config.scratchRoot);
    return {
      providerId: "bubblewrap",
      isolation: ISOLATION,
      filtersUnixSockets: true,
      // The launcher runs as init of its own PID namespace, so killing it (after its descendants,
      // giving its EXIT trap a chance to remove the instance directory) leaves nothing behind.
      spawn: (command) => {
        // The worker owns the instance directory: it is removed once teardown is verified, and a
        // poisoned command's is left to the sweep (its owner file names the command's root pid).
        mkdirSync(config.scratchRoot, { recursive: true, mode: 0o700 });
        // Every command gets a filter (io_uring denied); socketless ones also lose AF_UNIX. Throws on
        // an unsupported architecture: no command runs without its filter.
        const seccomp = ensureSeccompFilterFile(config.scratchRoot, command.denyUnixSockets ? "deny-unix-sockets" : "base");
        const instance = mkdtempSync(path.join(config.scratchRoot, "run-"));
        const cleanup = () => {
          rmSync(instance, { recursive: true, force: true });
          rmSync(`${instance}.owner`, { force: true });
        };
        return spawnOwned(
          instance,
          () =>
            spawnContained(launcherPath(), [command.binary, ...command.args], {
              env: {
                ...command.env,
                ...launcherEnv(config, command),
                DOCSLURP_PARSER_SANDBOX_INSTANCE: instance,
                DOCSLURP_PARSER_SANDBOX_SECCOMP: seccomp,
              },
              containment: "pid-namespace",
              // parser-sandbox.sh runs bwrap behind stdio-relay.pl (it refuses to run without it).
              stdioRelayed: true,
            }),
          cleanup,
        );
      },
      close: async () => {},
    };
  },
};

export default bubblewrapProvider as unknown as ParserSandboxProvider;
