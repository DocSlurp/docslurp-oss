import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRunner } from "../../tools/runner.js";
import {
  defaultParserSandbox,
  initializeParserSandbox,
  setDefaultParserSandbox,
  type InitializedParserSandbox,
} from "../startup.js";
import { SandboxPolicyError } from "../types.js";

describe("initializeParserSandbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses provider none in production without the override", async () => {
    await expect(
      initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "none", NODE_ENV: "production" }, "linux"),
    ).rejects.toBeInstanceOf(SandboxPolicyError);
  });

  it("warns and logs the startup line for an explicitly unisolated production run", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await initializeParserSandbox(
      { DOCSLURP_PARSER_SANDBOX: "none", NODE_ENV: "production", DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" },
      "linux",
    );
    expect(result.provider.id).toBe("none");
    expect(warn).toHaveBeenCalledWith("[parser-sandbox] status=unisolated");
    expect(log).toHaveBeenCalledWith(
      "[parser-sandbox] provider=none filesystem=false network=none processes=false location=local",
    );
  });

  it("fails with the probe detail when isolation is unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { default: bubblewrap } = await import("../providers/bubblewrap/index.js");
    vi.spyOn(bubblewrap, "probe").mockResolvedValue({
      ok: false,
      isolation: { filesystem: true, network: "full", processes: true, location: "local" },
      detail: "bwrap: no user namespaces",
    });
    await expect(initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "bubblewrap" }, "linux")).rejects.toThrow(
      "parser isolation unavailable: bwrap: no user namespaces",
    );
  });
});

describe("process default parser sandbox", () => {
  afterEach(() => {
    setDefaultParserSandbox(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function recordingSandbox(): { sandbox: InitializedParserSandbox; probe: ReturnType<typeof vi.fn>; opened: string[] } {
    const opened: string[] = [];
    const probe = vi.fn();
    const sandbox: InitializedParserSandbox = {
      config: {},
      isolation: { filesystem: false, network: "none", processes: false, location: "local" },
      provider: {
        id: "registered",
        name: "Registered",
        description: "test double",
        configSchema: { type: "object", properties: {} },
        readConfig: () => ({}),
        probe,
        openSession: async (_config, { activityId }) => {
          opened.push(activityId);
          return {
            providerId: "registered",
            isolation: sandbox.isolation,
            spawn: () => spawn(process.execPath, ["-e", "process.stdout.write('registered')"], { stdio: ["ignore", "pipe", "pipe"] }),
            close: async () => {},
          };
        },
      },
    };
    return { sandbox, probe, opened };
  }

  it("runs a runner without its own opener through the registered sandbox, without probing", async () => {
    // A provider the environment selects but that could never initialize here.
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX", "bubblewrap");
    vi.stubEnv("DOCSLURP_WORKER_SCRIPTS_DIR", "/nonexistent-parser-scripts");
    const { sandbox, probe, opened } = recordingSandbox();
    setDefaultParserSandbox(sandbox);
    const result = await new CommandRunner().run({ binary: process.execPath, args: ["-e", ""], available: true });
    expect(result.stdout).toBe("registered");
    expect(opened).toEqual(["command"]);
    expect(probe).not.toHaveBeenCalled();
    expect(await defaultParserSandbox()).toBe(sandbox);
  });

  it("retries a failed lazy initialization on the next call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX", "bubblewrap");
    vi.stubEnv("DOCSLURP_WORKER_SCRIPTS_DIR", "/nonexistent-parser-scripts");
    await expect(defaultParserSandbox()).rejects.toThrow("parser isolation unavailable");
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX", "none");
    await expect(defaultParserSandbox()).resolves.toMatchObject({ provider: { id: "none" } });
  });
});
