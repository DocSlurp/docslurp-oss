import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalArtifactCommand } from "./local-artifact-adapters.js";

describe("local artifact parser execution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not expose worker credentials to document parsers", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ENABLED", "false");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-storage-secret");
    vi.stubEnv("DATABASE_URL", "test-database-secret");
    vi.stubEnv("OPENAI_API_KEY", "test-provider-secret");
    const result = await runLocalArtifactCommand(process.execPath, ["-e",
      'process.stdout.write(JSON.stringify([process.env.AWS_SECRET_ACCESS_KEY, process.env.DATABASE_URL, process.env.OPENAI_API_KEY]))',
    ], 4096, 5000);
    expect(JSON.parse(result.toString())).toEqual([null, null, null]);
  });

  it("refuses to bypass an enabled sandbox with a missing launcher", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ENABLED", "true");
    vi.stubEnv("DOCSLURP_WORKER_SCRIPTS_DIR", "/nonexistent-parser-scripts");
    await expect(runLocalArtifactCommand(process.execPath, ["--version"], 4096, 5000))
      .rejects.toThrow("no sandbox launcher");
  });

  it("terminates parser output that exceeds its budget", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ENABLED", "false");
    await expect(runLocalArtifactCommand(process.execPath, ["-e", 'process.stdout.write("x".repeat(65536))'], 1024, 5000))
      .rejects.toThrow("output exceeds 1024");
  });
});
