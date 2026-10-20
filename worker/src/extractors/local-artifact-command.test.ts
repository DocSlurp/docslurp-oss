import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalArtifactCommand } from "./local-artifact-adapters.js";
import { setDefaultParserSandbox } from "../sandbox/startup.js";

describe("local artifact parser execution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    // Each case configures its own provider through the environment.
    setDefaultParserSandbox(undefined);
  });

  it("does not expose worker credentials to document parsers", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX", "none");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-storage-secret");
    vi.stubEnv("DATABASE_URL", "test-database-secret");
    vi.stubEnv("OPENAI_API_KEY", "test-provider-secret");
    const result = await runLocalArtifactCommand(process.execPath, ["-e",
      'process.stdout.write(JSON.stringify([process.env.AWS_SECRET_ACCESS_KEY, process.env.DATABASE_URL, process.env.OPENAI_API_KEY]))',
    ], 4096, 5000);
    expect(JSON.parse(result.toString())).toEqual([null, null, null]);
  });

  it("fails closed when the configured sandbox provider is unavailable", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX", "bubblewrap");
    vi.stubEnv("DOCSLURP_WORKER_SCRIPTS_DIR", "/nonexistent-parser-scripts");
    await expect(runLocalArtifactCommand(process.execPath, ["--version"], 4096, 5000))
      .rejects.toThrow("parser isolation unavailable");
  });

  it("terminates parser output that exceeds its budget", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX", "none");
    await expect(runLocalArtifactCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(65536))'], 1024, 5000))
      .rejects.toThrow("output exceeds 1024");
  });

  it("applies the worker output cap to remote parser output", async () => {
    vi.stubEnv("WORKER_COMMAND_MAX_OUTPUT_BYTES", "16");
    const isolation = { filesystem: true, network: "full", processes: true, location: "remote" } as const;
    setDefaultParserSandbox({
      config: {},
      isolation,
      provider: {
        id: "remote",
        name: "Remote",
        description: "test double",
        configSchema: { type: "object", properties: {} },
        readConfig: () => ({}),
        probe: async () => ({ ok: true, isolation, detail: "" }),
        openSession: async () => ({
          providerId: "remote",
          isolation,
          run: async () => ({ exitCode: 0, stdout: "x".repeat(64), stderr: "" }),
          close: async () => {},
        }),
      },
    });
    await expect(runLocalArtifactCommand("pdftotext", ["in.pdf", "-"], 4096, 5000)).rejects.toThrow("pdftotext stdout exceeded 16 bytes");
  });
});
