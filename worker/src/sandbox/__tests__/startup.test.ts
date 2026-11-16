import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandRunner } from "../../tools/runner.js";
import {
  defaultParserSandbox,
  initializeParserSandbox,
  setDefaultParserSandbox,
  type InitializedParserSandbox,
} from "../startup.js";
import { probePidNamespace, spawnContained } from "../teardown.js";
import { resolveSandboxProviderId } from "../registry.js";
import { UNSAFE_OVERRIDES, UnsafeOverrideError } from "../../lib/unsafe-overrides.js";

describe("initializeParserSandbox", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses provider none in production without the override", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "none", NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" }, "linux"),
    ).rejects.toThrow(/DOCSLURP_PARSER_SANDBOX.*refusing to start/);
  });

  it("refuses explicitly unisolated production startup before reporting readiness", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "none", NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED: "true" }, "linux")).rejects.toBeInstanceOf(UnsafeOverrideError);
    expect(log).not.toHaveBeenCalled();
  });

  // #398: every development-only fail-open setting stops startup outside development, even with an audited provider.
  it.each(UNSAFE_OVERRIDES)("refuses %s in production before probing a provider", async (name) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: modal } = await import("../providers/modal/index.js");
    const probe = vi.spyOn(modal, "probe");
    await expect(initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "modal", NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", [name]: "true" }, "linux"))
      .rejects.toThrow(new RegExp(`${name}.*refusing to start`));
    expect(probe).not.toHaveBeenCalled();
  });

  // #398 council: disabling quarantine and the unisolated none provider stop startup outside development too.
  it.each([
    ["QUARANTINE_ENABLED", "false"],
    ["DOCSLURP_PARSER_SANDBOX", "none"],
  ])("refuses %s=%s outside development before probing a provider", async (name, value) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: modal } = await import("../providers/modal/index.js");
    const probe = vi.spyOn(modal, "probe");
    for (const nodeEnv of ["production", "staging", "\u00a0development"]) {
      await expect(initializeParserSandbox({ DOCSLURP_PARSER_SANDBOX: "modal", NODE_ENV: nodeEnv, DOCSLURP_PROFILE: "selfhost", [name]: value }, "linux"))
        .rejects.toThrow(new RegExp(`${name}.*refusing to start`));
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("defaults to the VM outside development and refuses an explicit none provider", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { default: none } = await import("../providers/none/index.js");
    vi.spyOn(none, "probe").mockResolvedValue({ ok: true, detail: "test", isolation: { filesystem: false, network: "none", processes: true, location: "local" } });
    expect(resolveSandboxProviderId({ NODE_ENV: "staging" }, "darwin")).toBe("modal");
    await expect(initializeParserSandbox({ NODE_ENV: "staging", DOCSLURP_PROFILE: "selfhost", DOCSLURP_PARSER_SANDBOX: "none" }, "darwin"))
      .rejects.toBeInstanceOf(UnsafeOverrideError);
    expect(none.probe).not.toHaveBeenCalled();
    await expect(initializeParserSandbox({ NODE_ENV: "development" }, "darwin")).resolves.toMatchObject({ provider: none });
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
      isolation: { filesystem: false, network: "none", processes: true, location: "local" },
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
            spawn: () =>
              spawnContained(process.execPath, ["-e", "process.stdout.write('registered')"], {
                env: process.env,
                containment: "pid-namespace",
              }),
            close: async () => {},
          };
        },
      },
    };
    return { sandbox, probe, opened };
  }

  it.skipIf(process.platform !== "linux" || !probePidNamespace().ok)("runs a runner without its own opener through the registered sandbox, without probing", async () => {
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
