import { probePidNamespace, spawnContained } from "../../teardown.js";
import type { ParserSandboxProvider, SandboxIsolation } from "../../types.js";

/** No filesystem or network isolation. Commands still get a PID namespace where the host allows it,
 * so their processes die with them; without one, untrusted work needs DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED. */
function isolation(): SandboxIsolation {
  return { filesystem: false, network: "none", processes: probePidNamespace().ok, location: "local" };
}

const provider: ParserSandboxProvider<Record<string, never>> = {
  id: "none",
  name: "None",
  description: "Runs parsers directly on the host with no isolation. Development only.",
  configSchema: { type: "object", properties: {} },
  readConfig: () => ({}),
  probe: async () => ({ ok: true, isolation: isolation(), detail: `no isolation; ${probePidNamespace().detail}` }),
  openSession: async () => {
    const current = isolation();
    return {
      providerId: "none",
      isolation: current,
      spawn: (command) =>
        spawnContained(command.binary, command.args, {
          env: command.env,
          containment: current.processes ? "pid-namespace" : "process-group",
          // The parser is not PID 1 of its namespace: a minimal init forwards signals to it.
          init: true,
        }),
      close: async () => {},
    };
  },
};

export default provider as ParserSandboxProvider;
