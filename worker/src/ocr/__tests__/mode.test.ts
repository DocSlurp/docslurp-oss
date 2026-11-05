import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EXTRACTOR_PLUGIN_API_VERSION, registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedOcrProvider } from "../../extractors/plugins.js";
import { CommandRunner } from "../../tools/runner.js";
import { readWithOcr } from "../engine.js";
import { assertOcrConfiguration, localOcrRefusal, OcrRefusedError, resolveOcrMode, resolveServiceProfile } from "../mode.js";

function provider(overrides: Partial<SandboxedOcrProvider> = {}): SandboxedOcrProvider {
  return {
    id: "test-vm-ocr",
    maxSourceBytes: 1024 * 1024,
    assertConfigured: vi.fn(),
    run: vi.fn(async () => { throw new Error("the VM must not run in this test"); }),
    timeoutMs: () => 60_000,
    ...overrides,
  };
}

function register(ocr: SandboxedOcrProvider): void {
  registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-ocr-plugin", sandboxedOcr: ocr });
}

beforeEach(() => {
  resetExtractorPluginsForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  resetExtractorPluginsForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("resolveOcrMode", () => {
  it("defaults to vm in production and off elsewhere", () => {
    expect(resolveOcrMode({ NODE_ENV: "production" })).toBe("vm");
    expect(resolveOcrMode({ NODE_ENV: "development" })).toBe("off");
    expect(resolveOcrMode({ NODE_ENV: "test" })).toBe("off");
    expect(resolveOcrMode({})).toBe("off");
    expect(resolveOcrMode({ NODE_ENV: "production", DOCSLURP_OCR_MODE: "  " })).toBe("vm");
  });

  it("accepts each mode, case-insensitively", () => {
    for (const mode of ["vm", "local", "hosted", "off"] as const) {
      expect(resolveOcrMode({ DOCSLURP_OCR_MODE: mode })).toBe(mode);
      expect(resolveOcrMode({ DOCSLURP_OCR_MODE: ` ${mode.toUpperCase()} ` })).toBe(mode);
    }
  });

  it("throws on an unknown value instead of picking a default", () => {
    for (const value of ["tesseract", "on", "true", "vm,local", "sandbox"]) {
      expect(() => resolveOcrMode({ DOCSLURP_OCR_MODE: value, NODE_ENV: "production" }), value).toThrow(/DOCSLURP_OCR_MODE must be one of/);
    }
  });

  it("validates DOCSLURP_SERVICE_PROFILE", () => {
    expect(resolveServiceProfile({})).toBeNull();
    expect(resolveServiceProfile({ DOCSLURP_SERVICE_PROFILE: "Self-Hosted" })).toBe("self-hosted");
    expect(resolveServiceProfile({ DOCSLURP_SERVICE_PROFILE: "service" })).toBe("service");
    expect(() => resolveServiceProfile({ DOCSLURP_SERVICE_PROFILE: "selfhosted" })).toThrow(/DOCSLURP_SERVICE_PROFILE/);
  });
});

describe("assertOcrConfiguration", () => {
  it("refuses to start in vm mode without a provider", () => {
    expect(() => assertOcrConfiguration({ DOCSLURP_OCR_MODE: "vm" })).toThrow(/needs an OCR provider plugin.*refusing to start/);
  });

  it("calls the provider's assertConfigured when one is registered, and propagates its refusal", () => {
    const ready = provider();
    register(ready);
    expect(assertOcrConfiguration({ DOCSLURP_OCR_MODE: "vm" })).toBe("vm");
    expect(ready.assertConfigured).toHaveBeenCalledTimes(1);
    resetExtractorPluginsForTest();
    register(provider({ assertConfigured: () => { throw new Error("VM image is not pinned"); } }));
    expect(() => assertOcrConfiguration({ DOCSLURP_OCR_MODE: "vm" })).toThrow("VM image is not pinned");
  });

  it("refuses local mode under the service profile and with the profile unset", () => {
    expect(() => assertOcrConfiguration({ DOCSLURP_OCR_MODE: "local", DOCSLURP_SERVICE_PROFILE: "service" })).toThrow(/VM boundary.*refusing to start/);
    expect(() => assertOcrConfiguration({ DOCSLURP_OCR_MODE: "local" })).toThrow(/needs DOCSLURP_SERVICE_PROFILE=self-hosted; refusing to start/);
    expect(localOcrRefusal({ DOCSLURP_SERVICE_PROFILE: "service" })).toMatch(/service/);
  });

  it("allows local mode under the self-hosted profile", () => {
    expect(assertOcrConfiguration({ DOCSLURP_OCR_MODE: "local", DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe("local");
    expect(localOcrRefusal({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBeNull();
  });

  it("passes off and hosted without a provider, and rejects an unknown profile in any mode", () => {
    expect(assertOcrConfiguration({ DOCSLURP_OCR_MODE: "off" })).toBe("off");
    expect(assertOcrConfiguration({ DOCSLURP_OCR_MODE: "hosted" })).toBe("hosted");
    expect(() => assertOcrConfiguration({ DOCSLURP_OCR_MODE: "off", DOCSLURP_SERVICE_PROFILE: "whatever" })).toThrow(/DOCSLURP_SERVICE_PROFILE/);
  });
});

describe("production refusal reaches no local OCR command", () => {
  let scratch: string;
  let source: string;
  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-mode-"));
    source = path.join(scratch, "scan.png");
    await writeFile(source, "not decoded");
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function spiedRunner() {
    const runner = new CommandRunner();
    const spies = {
      plan: vi.spyOn(runner, "plan"),
      launch: vi.spyOn(runner, "launch"),
      run: vi.spyOn(runner, "run"),
      localOcrRead: vi.spyOn(runner, "localOcrRead"),
      sandboxedOcrRead: vi.spyOn(runner, "sandboxedOcrRead"),
    };
    return { runner, spies };
  }

  it("NODE_ENV=production with no mode and no provider: startup throws, and a read is refused without planning or spawning", async () => {
    const env = { NODE_ENV: "production", DOCSLURP_OCR_SCRATCH_DIR: scratch } as NodeJS.ProcessEnv;
    expect(() => assertOcrConfiguration(env)).toThrow(/refusing to start/);
    const { runner, spies } = spiedRunner();
    await expect(readWithOcr(runner, { source, kind: "image", escalation: false, env })).rejects.toThrow(/sandboxed OCR provider/);
    expect(spies.sandboxedOcrRead).toHaveBeenCalledTimes(1);
    expect(spies.localOcrRead).not.toHaveBeenCalled();
    expect(spies.plan).not.toHaveBeenCalled();
    expect(spies.launch).not.toHaveBeenCalled();
    expect(spies.run).not.toHaveBeenCalled();
  });

  it("local mode under DOCSLURP_SERVICE_PROFILE=service: localOcrRead refuses without planning a command", async () => {
    const env = { DOCSLURP_OCR_MODE: "local", DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_OCR_SCRATCH_DIR: scratch } as NodeJS.ProcessEnv;
    const { runner, spies } = spiedRunner();
    const read = readWithOcr(runner, { source, kind: "image", escalation: false, env });
    await expect(read).rejects.toBeInstanceOf(OcrRefusedError);
    await expect(read).rejects.toMatchObject({ reason: "profile" });
    expect(spies.localOcrRead).toHaveBeenCalledTimes(1);
    expect(spies.sandboxedOcrRead).not.toHaveBeenCalled();
    expect(spies.plan).not.toHaveBeenCalled();
    expect(spies.launch).not.toHaveBeenCalled();
    expect(spies.run).not.toHaveBeenCalled();
  });

  it("local mode with the profile unset is refused the same way", async () => {
    const { runner, spies } = spiedRunner();
    const job = { input: source, kind: "image" as const, output: path.join(scratch, "r.json"), imageDir: path.join(scratch, "img"), recognisers: ["multi"], maxAttempts: 1, retryBelow: 0.8, maxFrames: 1, maxLongEdge: 2000, escalation: null };
    await expect(runner.localOcrRead(job, { DOCSLURP_OCR_MODE: "local" })).rejects.toMatchObject({ name: "OcrRefusedError", reason: "profile" });
    // A runner asked for local OCR while the mode is vm refuses too: the mode, not the caller, decides.
    await expect(runner.localOcrRead(job, { DOCSLURP_OCR_MODE: "vm", DOCSLURP_SERVICE_PROFILE: "self-hosted" })).rejects.toMatchObject({ reason: "mode" });
    expect(spies.plan).not.toHaveBeenCalled();
  });

  it("off and hosted refuse before touching the runner", async () => {
    for (const mode of ["off", "hosted"]) {
      const { runner, spies } = spiedRunner();
      await expect(readWithOcr(runner, { source, kind: "image", escalation: false, env: { DOCSLURP_OCR_MODE: mode } })).rejects.toBeInstanceOf(OcrRefusedError);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    }
  });

  it("the launch dispatch of a VM plan without a provider refuses rather than spawning", async () => {
    const { runner } = spiedRunner();
    const job = { input: source, kind: "image" as const, output: path.join(scratch, "r.json"), imageDir: path.join(scratch, "img"), recognisers: ["multi"], maxAttempts: 1, retryBelow: 0.8, maxFrames: 1, maxLongEdge: 2000, escalation: null };
    await expect(runner.run({ binary: "forged", args: [], available: true, sandboxedOcr: job })).rejects.toThrow(/sandboxed OCR provider/);
  });
});
