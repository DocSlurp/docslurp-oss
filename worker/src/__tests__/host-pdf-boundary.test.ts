import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDF_EXTRACTION_UNCONFIGURED, resolvePdfMode, sandboxedPdfConfigured } from "@docslurp/shared";

import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import {
  VM_PDF_EXTRACTOR_ID, assertExtractorPluginConfiguration, loadExtractorPlugins, registerExtractorPlugin, resetExtractorPluginsForTest,
  type SandboxedPdfExtractorProvider,
} from "../extractors/plugins.js";
import { ExtractorRegistry } from "../extractors/registry.js";
import { setNativePdfEngineForTesting } from "../native-pdf/loader.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { dopplerConverterPath } from "../tools/doppler.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * PDFs are Doppler's: in a VM (vm-pdf) wherever a provider is configured, which production ships statically; on the worker
 * host (doppler-md) only in customer-owned local mode (DOCSLURP_PDF_MODE=local with DOCSLURP_SERVICE_PROFILE=self-hosted);
 * with neither, refused: no host parser runs, not even one a project names.
 */

/** A runner that records every method called on it; `run` (executing a command) always fails the test. */
function spyRunner(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const runner = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (name === "then") return undefined;
      if (name in overrides) return overrides[name];
      return vi.fn(async (...args: unknown[]) => {
        calls.push(name);
        if (name === "run") throw new Error(`a command ran: ${JSON.stringify(args[0])}`);
        return { binary: name, args: [], available: true };
      });
    },
  }) as unknown as CommandRunner;
  return { runner, calls };
}

const provider = (): SandboxedPdfExtractorProvider => ({
  id: "test-vm", maxSourceBytes: 1024, assertConfigured: () => undefined,
  run: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })), timeoutMs: (pages) => 1_000 + pages,
});
const doppler = { dopplerInstalled: () => true };

beforeEach(() => {
  setNativePdfEngineForTesting("absent");
  for (const name of ["DOCSLURP_SERVICE_PROFILE", "DOCSLURP_PDF_MODE", "DOCSLURP_PDF_EXTRACTOR", "DOCSLURP_VM_PDF_INSTALLED"]) vi.stubEnv(name, "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { setNativePdfEngineForTesting(null); resetExtractorPluginsForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("neither a VM nor local mode: PDF extraction fails closed", () => {
  it("resolves to off and refuses every PDF order, including host extractors a project names", () => {
    expect(resolvePdfMode()).toBe("off");
    const registry = new ExtractorRegistry();
    expect(() => registry.resolve("pdf")).toThrow(PDF_EXTRACTION_UNCONFIGURED);
    for (const id of ["doppler-md", "native-pdf", "poppler-text", "graph-local"]) {
      expect(() => registry.resolve("pdf", [id]), id).toThrow(PDF_EXTRACTION_UNCONFIGURED);
    }
    // Other formats are unaffected.
    expect(registry.resolve("office-word")).toEqual(["pandoc"]);
  });

  it("never plans, probes or runs a host PDF parser, however it is reached", async () => {
    const { runner, calls } = spyRunner();
    const registry = new ExtractorRegistry();
    for (const id of ["doppler-md", "native-pdf", "poppler-text"]) {
      await expect(registry.prepare(id, runner, "/tmp/tenant/input.pdf", undefined, { format: "pdf" }), id).rejects.toThrow(PDF_EXTRACTION_UNCONFIGURED);
    }
    const stage = new ExtractMarkdownStage(runner, {} as never, {} as never);
    await expect((stage as unknown as { planExtractors(args: unknown): Promise<unknown> }).planExtractors({
      tempFile: "/tmp/tenant/input.pdf", pageCount: 3, format: "pdf", order: { pdf: ["poppler-text"] }, options: {}, multiStrategyVoting: true,
      secondaryId: "poppler-text", attemptLedger: new ExtractorAttemptLedger(),
    })).rejects.toThrow(PDF_EXTRACTION_UNCONFIGURED);
    expect(calls).toEqual([]);
  });

  it("starts (other formats still run) and says loudly that PDFs are refused", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => assertExtractorPluginConfiguration({})).not.toThrow();
    expect(error.mock.calls.flat().join(" ")).toContain("[pdf] mode=off");
  });

  it("rejects a malformed mode instead of guessing", () => {
    expect(() => resolvePdfMode({ DOCSLURP_PDF_MODE: "host" })).toThrow("DOCSLURP_PDF_MODE must be empty or one of: vm, local");
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_PDF_MODE: "yes" })).toThrow("DOCSLURP_PDF_MODE");
  });
});

describe("customer-owned local mode (DOCSLURP_PDF_MODE=local)", () => {
  it("runs doppler-md first, at its absolute path off PATH; the native engine and Poppler text only after it failed", async () => {
    vi.stubEnv("DOCSLURP_PDF_MODE", "local");
    expect(resolvePdfMode()).toBe("local");
    expect(new ExtractorRegistry().resolve("pdf")).toEqual(["doppler-md", "native-pdf", "poppler-text"]);
    expect(dopplerConverterPath({})).toBe("/usr/lib/doppler/bin/pdftomarkdown");
    expect(dopplerConverterPath({ DOCSLURP_DOPPLER_BIN_DIR: "/opt/x/bin" })).toBe("/opt/x/bin/pdftomarkdown");
  });

  it("starts only for customer-owned execution, with Doppler installed, and never beside a VM", () => {
    const self = { DOCSLURP_PDF_MODE: "local", DOCSLURP_SERVICE_PROFILE: "self-hosted" };
    expect(() => assertExtractorPluginConfiguration(self, doppler)).not.toThrow();
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_PDF_MODE: "local" }, doppler)).toThrow(/customer-owned execution: it needs DOCSLURP_SERVICE_PROFILE=self-hosted/);
    expect(() => assertExtractorPluginConfiguration(self, { dopplerInstalled: () => false })).toThrow(/needs Doppler's pdftomarkdown/);
    // The real check (no stub): a bin dir with the converter but without pdfpagecount, or without prlimit on PATH, refuses.
    const bin = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "doppler-bin-"));
    writeFileSync(path.join(bin, "pdftomarkdown"), "#!/bin/sh\n", { mode: 0o755 });
    expect(() => assertExtractorPluginConfiguration({ ...self, DOCSLURP_DOPPLER_BIN_DIR: bin })).toThrow(/pdfpagecount/);
    writeFileSync(path.join(bin, "pdfpagecount"), "#!/bin/sh\n", { mode: 0o755 });
    expect(() => assertExtractorPluginConfiguration({ ...self, DOCSLURP_DOPPLER_BIN_DIR: bin, PATH: bin })).toThrow(/prlimit/);
    rmSync(bin, { recursive: true, force: true });
    // The service profile is a VM deployment: local mode beside it is refused (with a provider so the VM check passes).
    registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: provider() });
    for (const env of [{ DOCSLURP_SERVICE_PROFILE: "service" }, { DOCSLURP_PDF_EXTRACTOR: VM_PDF_EXTRACTOR_ID }, { DOCSLURP_PDF_MODE: "vm" }]) {
      expect(() => assertExtractorPluginConfiguration({ ...env, DOCSLURP_PDF_MODE: "local" }, doppler), JSON.stringify(env)).toThrow(/runs PDFs only in vm-pdf|vm-pdf is not selected/);
    }
  });
});

describe("which extractor runs a PDF through the stage", () => {
  const planFor = async (runner: CommandRunner) => {
    const stage = new ExtractMarkdownStage(runner, {} as never, {} as never);
    return await (stage as unknown as { planExtractors(args: unknown): Promise<{ primary: { label: string; plan: { binary: string; sandboxedPdf?: unknown } } }> }).planExtractors({
      tempFile: "/tmp/tenant/input.pdf", pageCount: 3, format: "pdf", order: {}, options: {}, multiStrategyVoting: false,
      secondaryId: "next-in-order", attemptLedger: new ExtractorAttemptLedger(),
    });
  };

  it("explicit local opt-in: doppler-md runs on the host at Doppler's path, and the choice is logged at startup", async () => {
    vi.stubEnv("DOCSLURP_PDF_MODE", "local");
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "self-hosted");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => assertExtractorPluginConfiguration(process.env, doppler)).not.toThrow();
    expect(warn.mock.calls.flat().join(" ")).toContain("[pdf] mode=local: Doppler (doppler-md) parses customer PDFs on the worker host");
    const dopplerMarkdown = vi.fn(async (source: string) => ({ binary: dopplerConverterPath(), args: ["--", source], available: true }));
    const extractText = vi.fn(async () => ({ binary: "pdftotext", args: [], available: true }));
    const planned = await planFor({ dopplerMarkdown, extractText } as unknown as CommandRunner);
    expect(planned.primary.label).toBe("doppler-md");
    expect(planned.primary.plan.binary).toBe("/usr/lib/doppler/bin/pdftomarkdown");
    // Bounded to the measured count (-f 1 -l N), never the file's own /Count.
    expect(dopplerMarkdown).toHaveBeenCalledWith("/tmp/tenant/input.pdf", 3);
  });

  it("VM configured: Doppler runs only through vm-pdf; no host extractor is planned or probed", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", VM_PDF_EXTRACTOR_ID);
    registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: provider() });
    expect(() => assertExtractorPluginConfiguration(process.env)).not.toThrow();
    // vm-pdf's plan comes from the runner's sandboxedPdfMarkdown; give it the real shape. Every other method is spied.
    const { runner, calls } = spyRunner({
      sandboxedPdfMarkdown: async (input: string, output: string) => ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }),
    });
    const planned = await planFor(runner);
    expect(planned.primary.label).toBe(VM_PDF_EXTRACTOR_ID);
    expect(planned.primary.plan.sandboxedPdf).toBeDefined();
    for (const host of ["dopplerMarkdown", "extractText", "run"]) expect(calls).not.toContain(host);
  });
});

describe("a VM deployment runs Doppler in vm-pdf only (production, statically configured)", () => {
  for (const env of [{ DOCSLURP_PDF_MODE: "vm" }, { DOCSLURP_SERVICE_PROFILE: "service" }, { DOCSLURP_PDF_EXTRACTOR: VM_PDF_EXTRACTOR_ID }, { DOCSLURP_VM_PDF_INSTALLED: "1" }]) {
    it(`${JSON.stringify(env)}: vm-pdf alone, every host PDF extractor refused`, async () => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      expect(sandboxedPdfConfigured()).toBe(true);
      expect(resolvePdfMode()).toBe("vm");
      const registry = new ExtractorRegistry();
      expect(registry.resolve("pdf")).toEqual([VM_PDF_EXTRACTOR_ID]);
      for (const id of ["doppler-md", "native-pdf", "poppler-text", "graph-local", "dolphin"]) {
        expect(() => registry.resolve("pdf", [id]), id).toThrow(new RegExp(`${id} refused for pdf`));
      }
      const { runner, calls } = spyRunner();
      await expect(registry.prepare("doppler-md", runner, "/tmp/tenant/input.pdf", undefined, { format: "pdf" })).rejects.toThrow(/refused for pdf/);
      expect(calls).toEqual([]);
    });
  }

  it("refuses to start without a provider, and with a provider loaded but vm-pdf unselected (preflight fails the same way)", async () => {
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_SERVICE_PROFILE: "service" })).toThrow(/needs a sandboxed PDF provider/);
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_PDF_MODE: "vm" })).toThrow(/needs a sandboxed PDF provider/);
    await expect(loadExtractorPlugins({ DOCSLURP_SERVICE_PROFILE: "service" })).rejects.toThrow(/needs a sandboxed PDF provider/);
    resetExtractorPluginsForTest();
    registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: provider() });
    expect(() => assertExtractorPluginConfiguration({})).toThrow(/vm-pdf is not selected/);
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_SERVICE_PROFILE: "service" })).not.toThrow();
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_PDF_MODE: "vm" })).not.toThrow();
  });

  it("does not treat the self-hosted profile as a VM deployment", () => {
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe(false);
    expect(resolvePdfMode({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe("off");
  });
});
