import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectQuarantine } from "./quarantine.js";
import { assertServiceProfileRuntime, vmOnlyParsing } from "./vm-only-parsing.js";
import { detectHtmlEmbeds } from "../routing/html-embeds.js";
import { structuredJsonToMarkdown } from "../extractors/structured-json.js";
import { initializeParserSandbox } from "../sandbox/startup.js";
import { resolveSandboxProviderId } from "../sandbox/registry.js";

// Council G L3: the VM-only gates key on the service profile too, and the service profile refuses to start without
// NODE_ENV=production, so a deployment that forgot NODE_ENV never parses customer bytes in process.
afterEach(() => vi.unstubAllEnvs());

describe("vmOnlyParsing", () => {
  it("is true under NODE_ENV=production or DOCSLURP_SERVICE_PROFILE=service, from the given or the process environment", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "");
    expect(vmOnlyParsing({})).toBe(false);
    expect(vmOnlyParsing({ NODE_ENV: "production" })).toBe(true);
    expect(vmOnlyParsing({ DOCSLURP_SERVICE_PROFILE: "service" })).toBe(true);
    expect(vmOnlyParsing({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe(false);
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(vmOnlyParsing({})).toBe(true);
  });

  it("refuses in-process parsing under the service profile without NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(() => detectHtmlEmbeds("<p>x</p>")).toThrow(/requires the parser VM/);
    expect(() => structuredJsonToMarkdown("{}")).toThrow(/requires the parser VM/);
    expect(resolveSandboxProviderId({ DOCSLURP_SERVICE_PROFILE: "service" }, "linux")).toBe("modal");
    // Quarantine inspection goes to the VM runner, never the in-process inspector.
    const run = vi.fn(async () => { throw new Error("vm runner reached"); });
    await expect(inspectQuarantine({ bytes: Buffer.from("PK\u0003\u0004"), filename: "a.zip", tempFile: "/nonexistent", runner: { run } as never, policy: {} as never })).rejects.toThrow();
    expect(run).toHaveBeenCalled();
  });
});

describe("assertServiceProfileRuntime", () => {
  it("refuses the service profile unless NODE_ENV=production", async () => {
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "service" })).toThrow(/requires NODE_ENV=production \(got unset\)/);
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "service", NODE_ENV: "development" })).toThrow(/got 'development'/);
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "service", NODE_ENV: "production" })).not.toThrow();
    expect(() => assertServiceProfileRuntime({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).not.toThrow();
    expect(() => assertServiceProfileRuntime({})).not.toThrow();
    await expect(initializeParserSandbox({ DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_PARSER_SANDBOX: "none" }, "linux")).rejects.toThrow(/refusing to start/);
  });
});

// #502: DOCSLURP_PROFILE never lowers the floor. Under a non-development NODE_ENV every in-process reader is refused
// whatever the profile says, and the startup check refuses the profiles that would contradict it.
describe("deployment profile (DOCSLURP_PROFILE) and the VM-only floor", () => {
  it("refuses dev outside development, service outside production and an unset profile outside development", () => {
    expect(() => assertServiceProfileRuntime({ NODE_ENV: "production", DOCSLURP_PROFILE: "dev" })).toThrow(/only for development/);
    expect(() => assertServiceProfileRuntime({ NODE_ENV: "development", DOCSLURP_PROFILE: "service" })).toThrow(/requires NODE_ENV=production/);
    expect(() => assertServiceProfileRuntime({ NODE_ENV: "production" })).toThrow(/DOCSLURP_PROFILE is required outside development/);
    expect(() => assertServiceProfileRuntime({ NODE_ENV: "production", DOCSLURP_PROFILE: "service", DOCSLURP_DISABLE: "ocr,figuers" })).toThrow(/unknown token/);
    expect(() => assertServiceProfileRuntime({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", DOCSLURP_SERVICE_PROFILE: "service" })).toThrow(/conflicts/);
    expect(assertServiceProfileRuntime({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" }).vmOnlyParsing).toBe(true);
  });

  it.each([
    { NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" },
    { NODE_ENV: "production", DOCSLURP_PROFILE: "dev" },
    { NODE_ENV: "staging", DOCSLURP_PROFILE: "selfhost" },
    { NODE_ENV: "development", DOCSLURP_PROFILE: "service" },
  ])("refuses the in-process probe, native engine and local-cli reader under %j", async (env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    expect(vmOnlyParsing(env)).toBe(true);
    const { loadProbeBinding, setProbeBindingForTesting } = await import("../routing/probe/binding.js");
    // Even a test override of the binding is never reached under VM-only.
    setProbeBindingForTesting({ version: () => ({ version: "x", gitSha: "x", features: [] }), openPath: () => { throw new Error("opened"); } } as never);
    try {
      expect(loadProbeBinding(env)).toEqual({ ok: false, reason: expect.stringMatching(/VM boundary/) });
    } finally {
      setProbeBindingForTesting(null);
    }
    const { loadNativePdfEngine, loadNativePdfModule } = await import("../native-pdf/loader.js");
    expect(loadNativePdfModule(env)).toMatchObject({ ok: false });
    expect(await loadNativePdfEngine(env)).toMatchObject({ ok: false });
    const { CommandRunner } = await import("../tools/runner.js");
    await expect(new CommandRunner().florence2("/nonexistent.png", "/nonexistent.json", "<OCR>")).rejects.toThrow(/local-cli vision reader is refused outside development/);
  });

  it("refuses the local-cli reader under DOCSLURP_DISABLE=ai even in development", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_DISABLE", "ai");
    const { CommandRunner } = await import("../tools/runner.js");
    await expect(new CommandRunner().florence2("/nonexistent.png", "/nonexistent.json", "<OCR>")).rejects.toThrow(/DOCSLURP_DISABLE=ai/);
  });

  it("a selfhost profile outside development cannot select a host sandbox", async () => {
    await expect(initializeParserSandbox({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", DOCSLURP_PARSER_SANDBOX: "bubblewrap" }, "linux")).rejects.toThrow();
    await expect(initializeParserSandbox({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", DOCSLURP_PARSER_SANDBOX: "none" }, "linux")).rejects.toThrow(/only in development or test/);
    expect(resolveSandboxProviderId({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" }, "linux")).toBe("modal");
    expect(resolveSandboxProviderId({ NODE_ENV: "test", DOCSLURP_PROFILE: "service" }, "linux")).toBe("modal");
  });
});
