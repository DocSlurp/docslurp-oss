import { spawn } from "node:child_process";

import type { ParserSandboxProvider, SandboxIsolation } from "../../types.js";

const ISOLATION: SandboxIsolation = { filesystem: false, network: "none", processes: false, location: "local" };

const provider: ParserSandboxProvider<Record<string, never>> = {
  id: "none",
  name: "None",
  description: "Runs parsers directly on the host with no isolation. Development only.",
  configSchema: { type: "object", properties: {} },
  readConfig: () => ({}),
  probe: async () => ({ ok: true, isolation: ISOLATION, detail: "no isolation" }),
  openSession: async () => ({
    providerId: "none",
    isolation: ISOLATION,
    spawn: (command, signal) =>
      spawn(command.binary, command.args, { env: command.env, stdio: ["ignore", "pipe", "pipe"], signal }),
    close: async () => {},
  }),
};

export default provider as ParserSandboxProvider;
