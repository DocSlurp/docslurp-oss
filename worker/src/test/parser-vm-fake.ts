import { readFile, writeFile } from "node:fs/promises";

import { inspectQuarantineBytes } from "../lib/quarantine-bytes.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * Run quarantine tests under NODE_ENV=production. Production inspects the bytes in the parser VM (lib/quarantine.ts
 * inspectInVm, through runner.run), which a fake runner without `run` cannot do: the suites that stubbed NODE_ENV=test
 * never ran that branch. This fake VM runs what the guest's scripts/quarantine-inspect.mjs runs, and refuses any other
 * command, so nothing else is quietly parsed on the "host". Every other method comes from the given runner.
 */
export function withFakeParserVm(runner: CommandRunner): CommandRunner {
  const commands: string[] = [];
  const run = async (plan: { binary: string; args: string[] }) => {
    commands.push(`${plan.binary} ${plan.args[0] ?? ""}`);
    if (plan.binary !== "node" || !plan.args[0]?.endsWith("quarantine-inspect.mjs")) throw new Error(`fake parser VM refused: ${plan.binary} ${plan.args[0] ?? ""}`);
    const options = JSON.parse(await readFile(plan.args[2]!, "utf8")) as { filename: string; policy: Parameters<typeof inspectQuarantineBytes>[2] };
    await writeFile(plan.args[3]!, JSON.stringify(inspectQuarantineBytes(await readFile(plan.args[1]!), options.filename, options.policy)));
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return Object.assign(Object.create(runner) as CommandRunner, { run, vmCommands: commands });
}

/** The commands the fake VM received (each production inspection is one). */
export function fakeVmCommands(runner: CommandRunner): string[] {
  return (runner as unknown as { vmCommands?: string[] }).vmCommands ?? [];
}
