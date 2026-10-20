import { constants, accessSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkSandboxParserBinaries } from "./binary-check.js";
import { initializeParserSandbox } from "./startup.js";
import { buildSandboxCommand, resolveVenvBin } from "../tools/runner.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";

const BINARY_TIMEOUT_MS = 30_000;
const PROBE_PREFIX = "parser isolation unavailable: ";

function findOnPath(name: string, venvBin: string): string | undefined {
  for (const directory of [venvBin, ...(process.env.PATH ?? "").split(path.delimiter)]) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next directory */
    }
  }
  return undefined;
}

/**
 * `node dist/sandbox/probe-cli.js`: probes the selected provider, then runs the real
 * parser binaries inside one session. Stdout carries the result; stderr carries the
 * startup log line.
 * Exit 0: prints `ok <provider>`. Exit 1: prints the probe failure detail.
 * Exit 2: prints one `<name> fails inside the parser sandbox (...)` line per broken binary.
 */
async function main(): Promise<number> {
  // Startup logging is for the worker's log; keep stdout to the result.
  console.log = console.error;
  console.warn = console.error;

  let initialized;
  try {
    initialized = await initializeParserSandbox(process.env, process.platform);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${message.startsWith(PROBE_PREFIX) ? message.slice(PROBE_PREFIX.length) : message}\n`);
    return 1;
  }
  const venvBin = resolveVenvBin(process.env.PYTHON_VENV);
  const scriptsDir = resolveScriptsDir();
  const result = await checkSandboxParserBinaries({
    sandbox: initialized,
    activityId: "sandbox-probe-cli",
    resolveBinary: (name) => findOnPath(name, venvBin),
    buildCommand: (binary, args) =>
      buildSandboxCommand({
        plan: { binary, args, available: true },
        venvBin,
        scriptsDir,
        scratchRoot: path.join(tmpdir(), "docslurp-sandbox-probe"),
        configuredWritablePaths: [],
        limits: { timeoutMs: BINARY_TIMEOUT_MS },
      }),
  });
  if (result.failures.length > 0) {
    process.stdout.write(`${result.failures.join("\n")}\n`);
    return 2;
  }
  if (result.remote) process.stdout.write("parser binary checks skipped: remote provider\n");
  process.stdout.write(`ok ${initialized.provider.id}\n`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
