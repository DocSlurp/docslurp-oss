import type { SandboxCommand } from "../sandbox/types.js";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

import { execInSession } from "../sandbox/exec.js";
import { loadSandboxProvider, SANDBOX_PROVIDER_IDS, type SandboxProviderId } from "../sandbox/registry.js";
import { buildSandboxCommand, resolveVenvBin } from "../tools/runner.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";

const COMMAND_TIMEOUT_MS = 60_000;

interface ProviderMeasurement {
  provider: string;
  status: "measured" | "skipped";
  isolation: string;
  detail: string;
  sessionOpenMs?: number;
  commandMs?: Record<string, number>;
  medianCommandMs?: number;
  totalMs?: number;
}

function isolationSummary(isolation: { filesystem: boolean; network: string; processes: boolean; location: string }): string {
  return `fs=${isolation.filesystem} net=${isolation.network} proc=${isolation.processes} ${isolation.location}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildCommands(file: string, outputDir: string): Array<[string, SandboxCommand]> {
  const venvBin = resolveVenvBin(process.env.PYTHON_VENV);
  const scriptsDir = resolveScriptsDir();
  const make = (binary: string, args: string[]) =>
    buildSandboxCommand({
      plan: { binary, args, available: true },
      venvBin,
      scriptsDir,
      scratchRoot: outputDir,
      configuredWritablePaths: [],
      limits: { timeoutMs: COMMAND_TIMEOUT_MS },
    });
  return [
    ["pdfinfo", make("pdfinfo", [file])],
    ["pdftotext", make("pdftotext", [file, "-"])],
    ["pdftoppm", make("pdftoppm", ["-r", "72", "-f", "1", "-l", "1", "-png", file, path.join(outputDir, "page")])],
  ];
}

async function measureProvider(id: SandboxProviderId, file: string, repeat: number): Promise<ProviderMeasurement> {
  const provider = await loadSandboxProvider(id);
  const config = provider.readConfig(process.env);
  const probe = await provider.probe(config);
  const isolation = isolationSummary(probe.isolation);
  if (!probe.ok) return { provider: id, status: "skipped", isolation, detail: probe.detail };

  // The directory name prefix is what launchers accept as a private writable workspace.
  const outputDir = mkdtempSync(path.join(tmpdir(), "docslurp-sandbox-bench-"));
  try {
    const commands = buildCommands(file, outputDir);
    const opens: number[] = [];
    const perCommand: Record<string, number[]> = Object.fromEntries(commands.map(([name]) => [name, []]));
    for (let run = 0; run < repeat; run += 1) {
      const openStart = performance.now();
      const session = await provider.openSession(config, { activityId: `sandbox-bench-${run}` });
      opens.push(performance.now() - openStart);
      try {
        for (const [name, command] of commands) {
          const start = performance.now();
          const result = await execInSession(session, command);
          perCommand[name].push(performance.now() - start);
          if (result.exitCode !== 0) {
            throw new Error(`${name} exited with ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`);
          }
        }
      } finally {
        await session.close();
      }
    }
    const commandMs = Object.fromEntries(Object.entries(perCommand).map(([name, times]) => [name, median(times)]));
    const sessionOpenMs = median(opens);
    const medianCommandMs = median(Object.values(commandMs));
    return {
      provider: id,
      status: "measured",
      isolation,
      detail: probe.detail,
      sessionOpenMs,
      commandMs,
      medianCommandMs,
      totalMs: sessionOpenMs + Object.values(commandMs).reduce((sum, ms) => sum + ms, 0),
    };
  } catch (error) {
    return { provider: id, status: "skipped", isolation, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

function formatTable(results: ProviderMeasurement[]): string {
  const rows = ["| provider | isolation | session open ms | median command ms | total ms (sum of medians) |", "| --- | --- | ---: | ---: | ---: |"];
  for (const r of results) {
    rows.push(
      r.status === "measured"
        ? `| ${r.provider} | ${r.isolation} | ${r.isolation.endsWith("remote") ? r.sessionOpenMs!.toFixed(1) : "-"} | ${r.medianCommandMs!.toFixed(1)} | ${r.totalMs!.toFixed(1)} |`
        : `| ${r.provider} | ${r.isolation} | skipped | skipped | skipped |`,
    );
  }
  const skipped = results.filter((r) => r.status === "skipped");
  const note = "\nSession open is only meaningful for remote providers; local providers spawn per command (shown as -). Total is the session open median plus the sum of per-command medians.";
  return [rows.join("\n"), note, ...skipped.map((r) => `\n${r.provider} skipped: ${r.detail}`)].join("\n");
}

async function main(): Promise<void> {
  // pnpm forwards the literal `--` separator; drop it so the flags stay options.
  const argv = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: "string" },
      providers: { type: "string", default: "bubblewrap,landlock,none" },
      repeat: { type: "string", default: "3" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (!values.file) throw new Error("--file <pdf> is required");
  const repeat = Number.parseInt(values.repeat ?? "3", 10);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a positive integer");
  const ids = (values.providers ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  for (const id of ids) {
    if (!(SANDBOX_PROVIDER_IDS as readonly string[]).includes(id)) {
      throw new Error(`Unknown provider '${id}'; expected one of: ${SANDBOX_PROVIDER_IDS.join(", ")}`);
    }
  }
  const file = path.resolve(values.file);
  const results: ProviderMeasurement[] = [];
  for (const id of ids as SandboxProviderId[]) results.push(await measureProvider(id, file, repeat));
  console.log(values.json ? JSON.stringify({ file, repeat, results }, null, 2) : formatTable(results));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
