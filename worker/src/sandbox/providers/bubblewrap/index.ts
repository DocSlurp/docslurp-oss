import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveScriptsDir } from "../../../tools/scripts-dir.js";
import { readSandboxConfig } from "../../config-schema.js";
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
    DOCSLURP_PARSER_SANDBOX_MODE: "isolated",
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
    const result = spawnSync(launcherPath(), ["/usr/bin/true"], {
      env: {
        PATH: process.env.PATH ?? "",
        ...launcherEnv(config, { readablePaths: [], writablePaths: [] }),
      },
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.status === 0) return { ok: true, isolation: ISOLATION, detail: "bubblewrap available" };
    const detail =
      result.stderr?.trim() || result.error?.message || `launcher exited with status ${result.status}`;
    return { ok: false, isolation: ISOLATION, detail };
  },
  async openSession(config) {
    return {
      providerId: "bubblewrap",
      isolation: ISOLATION,
      spawn: (command, signal) =>
        spawn(launcherPath(), [command.binary, ...command.args], {
          env: { ...command.env, ...launcherEnv(config, command) },
          stdio: ["ignore", "pipe", "pipe"],
          signal,
        }),
      close: async () => {},
    };
  },
};

export default bubblewrapProvider as unknown as ParserSandboxProvider;
