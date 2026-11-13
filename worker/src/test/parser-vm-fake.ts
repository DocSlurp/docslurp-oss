import { readFile, writeFile } from "node:fs/promises";

import { inspectQuarantineBytes } from "../lib/quarantine-bytes.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
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
    // The host passes exactly GUEST_NODE_FLAGS before the script (sandbox/guest-node-flags.ts); anything else is refused.
    const flags = plan.args.slice(0, GUEST_NODE_FLAGS.length);
    const [script, input, optionsFile, output] = plan.args.slice(GUEST_NODE_FLAGS.length);
    commands.push(`${plan.binary} ${script ?? ""}`);
    const flagsMatch = flags.length === GUEST_NODE_FLAGS.length && flags.every((flag, index) => flag === GUEST_NODE_FLAGS[index]);
    if (plan.binary !== "node" || !flagsMatch || !script?.endsWith("quarantine-inspect.mjs")) throw new Error(`fake parser VM refused: ${plan.binary} ${plan.args.join(" ")}`);
    const options = JSON.parse(await readFile(optionsFile!, "utf8")) as { filename: string; policy: Parameters<typeof inspectQuarantineBytes>[2] };
    await writeFile(output!, JSON.stringify(inspectQuarantineBytes(await readFile(input!), options.filename, options.policy)));
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return Object.assign(Object.create(runner) as CommandRunner, { run, vmCommands: commands });
}

/** The commands the fake VM received (each production inspection is one). */
export function fakeVmCommands(runner: CommandRunner): string[] {
  return (runner as unknown as { vmCommands?: string[] }).vmCommands ?? [];
}
