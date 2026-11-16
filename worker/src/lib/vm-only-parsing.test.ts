import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectQuarantine } from "./quarantine.js";
import { assertServiceProfileRuntime, vmOnlyParsing } from "./vm-only-parsing.js";
import { detectHtmlEmbeds } from "../routing/html-embeds.js";
import { structuredJsonToMarkdown } from "../extractors/structured-json.js";
import { initializeParserSandbox } from "../sandbox/startup.js";
import { resolveSandboxProviderId } from "../sandbox/registry.js";
import { assertSandboxPolicy } from "../sandbox/policy.js";

// Council G L3: the VM-only gates key on the service profile too, and the service profile refuses to start without
// NODE_ENV=production, so a deployment that forgot NODE_ENV never parses customer bytes in process.
afterEach(() => vi.unstubAllEnvs());

describe("vmOnlyParsing", () => {
  it("is true under NODE_ENV=production or DOCSLURP_SERVICE_PROFILE=service, from the given or the process environment", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "");
    expect(vmOnlyParsing({})).toBe(false);
    expect(vmOnlyParsing({ NODE_ENV: "production" })).toBe(true);
    expect(vmOnlyParsing({ DOCSLURP_PROFILE: "service" })).toBe(true);
    expect(vmOnlyParsing({ DOCSLURP_PROFILE: "selfhost" })).toBe(false);
    vi.stubEnv("DOCSLURP_PROFILE", "service");
    expect(vmOnlyParsing({})).toBe(true);
  });

  it("refuses in-process parsing under the service profile without NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_PROFILE", "service");
    expect(() => detectHtmlEmbeds("<p>x</p>")).toThrow(/requires the parser VM/);
    expect(() => structuredJsonToMarkdown("{}")).toThrow(/requires the parser VM/);
    expect(resolveSandboxProviderId({ DOCSLURP_PROFILE: "service" }, "linux")).toBe("modal");
    // Quarantine inspection goes to the VM runner, never the in-process inspector.
    const run = vi.fn(async () => { throw new Error("vm runner reached"); });
    await expect(inspectQuarantine({ bytes: Buffer.from("PK\u0003\u0004"), filename: "a.zip", tempFile: "/nonexistent", runner: { run } as never, policy: {} as never })).rejects.toThrow();
    expect(run).toHaveBeenCalled();
  });
});

describe("assertServiceProfileRuntime", () => {
  it("refuses the service profile unless NODE_ENV=production", async () => {
    expect(() => assertServiceProfileRuntime({ DOCSLURP_PROFILE: "service" })).toThrow(/requires NODE_ENV=production \(got unset\)/);
    expect(() => assertServiceProfileRuntime({ DOCSLURP_PROFILE: "service", NODE_ENV: "development" })).toThrow(/got 'development'/);
    expect(() => assertServiceProfileRuntime({ DOCSLURP_PROFILE: "service", NODE_ENV: "production" })).not.toThrow();
    expect(() => assertServiceProfileRuntime({ DOCSLURP_PROFILE: "selfhost" })).not.toThrow();
    expect(() => assertServiceProfileRuntime({})).not.toThrow();
    await expect(initializeParserSandbox({ DOCSLURP_PROFILE: "service", DOCSLURP_PARSER_SANDBOX: "none" }, "linux")).rejects.toThrow(/refusing to start/);
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
    expect(() => assertServiceProfileRuntime({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toThrow(/retired environment variable/);
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
    // Council H1: planning the command (pdf-tooling's inventory does, for every document) must still work; the reader is
    // refused where it would run.
    const { CommandRunner } = await import("../tools/runner.js");
    await expect(new CommandRunner().florence2("/nonexistent.png", "/nonexistent.json", "<OCR>")).resolves.toBeDefined();
    const { assertLocalCliReaderAllowed } = await import("./vm-only-parsing.js");
    expect(() => assertLocalCliReaderAllowed(env)).toThrow(/local-cli vision reader is refused outside development/);
  });

  it("refuses the local-cli reader under DOCSLURP_DISABLE=ai even in development", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DOCSLURP_DISABLE", "ai");
    const { assertLocalCliReaderAllowed } = await import("./vm-only-parsing.js");
    expect(() => assertLocalCliReaderAllowed({ NODE_ENV: "test", DOCSLURP_DISABLE: "ai" })).toThrow(/DOCSLURP_DISABLE=ai/);
    expect(() => assertLocalCliReaderAllowed({ NODE_ENV: "test" })).not.toThrow();
  });

  it("a selfhost profile outside development cannot select a host sandbox", async () => {
    // The policy itself refuses, even for a host sandbox whose probe succeeded with full isolation.
    const isolation = { filesystem: true, network: "full", processes: true, location: "local" } as never;
    for (const providerId of ["bubblewrap", "landlock"]) {
      expect(() => assertSandboxPolicy({ providerId, isolation, env: { NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" } }), providerId).toThrow(/lacks the required production VM boundary/);
    }
    expect(() => assertSandboxPolicy({ providerId: "bubblewrap", isolation, env: { NODE_ENV: "test", DOCSLURP_PROFILE: "selfhost" } })).not.toThrow();
    await expect(initializeParserSandbox({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost", DOCSLURP_PARSER_SANDBOX: "none" }, "linux")).rejects.toThrow(/only in development or test/);
    expect(resolveSandboxProviderId({ NODE_ENV: "production", DOCSLURP_PROFILE: "selfhost" }, "linux")).toBe("modal");
    expect(resolveSandboxProviderId({ NODE_ENV: "test", DOCSLURP_PROFILE: "service" }, "linux")).toBe("modal");
  });
});

// Council (#502): DOCSLURP_DISABLE=ai reaches every extraction model-read site, not only the ones behind run settings.
describe("kill switch call sites", () => {
  it("each model-read site that quality alone would allow checks the switch", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(read("../deferred/materialize-pages.ts")).toMatch(/switchDisabled\(process\.env, "ai-rescue"\)[\s\S]*switchDisabled\(process\.env, "ai"\)/);
    expect(read("../stages/extract-markdown.ts")).toMatch(/runSelfCritique[\s\S]*switchDisabled\(process\.env, "ai-rescue"\)/);
    expect(read("../stages/document-map.ts").match(/switchDisabled\(process\.env, "ai"\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(read("../media/extract.ts")).toMatch(/visualEnabled[\s\S]{0,200}switchDisabled\(process\.env, "ai"\)/);
    expect(read("../tools/vision-runtime.ts")).toMatch(/runtime === "local-cli"\) \{\s*assertLocalCliReaderAllowed\(\)/);
    expect(read("../routing/executors/deps.ts")).toMatch(/assertLocalCliReaderAllowed\(\);\s*const plan = await input\.runner\.florence2/);
  });
});
