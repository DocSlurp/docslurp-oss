import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dopplerHostPdfEnabled, sandboxedPdfConfigured } from "@docslurp/shared";

import { ExtractorAttemptLedger } from "../extractors/attempt-ledger.js";
import {
  VM_PDF_EXTRACTOR_ID, assertExtractorPluginConfiguration, loadExtractorPlugins, registerExtractorPlugin, resetExtractorPluginsForTest,
  type SandboxedPdfExtractorProvider,
} from "../extractors/plugins.js";
import { ExtractorRegistry, defaultDocumentExtractorOrder } from "../extractors/registry.js";
import { setNativePdfEngineForTesting } from "../native-pdf/loader.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * Council B High 5: doppler-md (Doppler's pdftomarkdown, a host parser in the parser sandbox) must not become reachable just because
 * the service profile is unset, and the service profile must run PDFs only in vm-pdf.
 */

/** A runner that records every method called on it; `run` (executing a command) always fails the test. */
function spyRunner() {
  const calls: string[] = [];
  const runner = new Proxy({}, {
    get: (_target, property) => {
      const name = String(property);
      if (name === "then") return undefined;
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

beforeEach(() => {
  setNativePdfEngineForTesting("absent");
  for (const name of ["DOCSLURP_SERVICE_PROFILE", "DOCSLURP_DOPPLER_HOST_PDF", "DOCSLURP_PDF_EXTRACTOR", "DOCSLURP_VM_PDF_INSTALLED"]) vi.stubEnv(name, "");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { setNativePdfEngineForTesting(null); resetExtractorPluginsForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("profile unset, no Doppler opt-in", () => {
  it("keeps the pre-existing host PDF order: native-pdf, then poppler-text, never doppler-md", () => {
    expect(defaultDocumentExtractorOrder.pdf).toEqual(["native-pdf", "poppler-text"]);
    expect(new ExtractorRegistry().resolve("pdf")).toEqual(["native-pdf", "poppler-text"]);
    expect(dopplerHostPdfEnabled()).toBe(false);
  });

  it("never plans, probes or runs pdftomarkdown, even when a workspace order names doppler-md", async () => {
    const { runner, calls } = spyRunner();
    const prepared = await new ExtractorRegistry().prepare("doppler-md", runner, "/tmp/tenant/input.pdf", undefined, { format: "pdf" });
    expect(prepared.plan.available).toBe(false);
    expect(calls).toEqual([]);

    const stage = new ExtractMarkdownStage(runner, {} as never, {} as never);
    const attemptLedger = new ExtractorAttemptLedger();
    const planned = await (stage as unknown as { planExtractors(args: unknown): Promise<{ primary: { label: string } }> }).planExtractors({
      tempFile: "/tmp/tenant/input.pdf", format: "pdf", order: { pdf: ["doppler-md", "poppler-text"] }, options: {}, multiStrategyVoting: false,
      secondaryId: "next-in-order", attemptLedger,
    });
    expect(planned.primary.label).toBe("poppler-text");
    expect(attemptLedger.snapshot().unavailable).toContain("doppler-md");
    expect(calls).not.toContain("dopplerMarkdown");
    expect(calls).not.toContain("run");
  });

  it("rejects a malformed opt-in instead of guessing", () => {
    vi.stubEnv("DOCSLURP_DOPPLER_HOST_PDF", "yes");
    expect(() => dopplerHostPdfEnabled()).toThrow("DOCSLURP_DOPPLER_HOST_PDF must be empty, 0 or 1");
    expect(() => assertExtractorPluginConfiguration(process.env)).toThrow("DOCSLURP_DOPPLER_HOST_PDF");
  });
});

describe("explicit Doppler opt-in (DOCSLURP_DOPPLER_HOST_PDF=1)", () => {
  it("puts doppler-md first, ahead of the built-in host order", () => {
    vi.stubEnv("DOCSLURP_DOPPLER_HOST_PDF", "1");
    expect(new ExtractorRegistry().resolve("pdf")).toEqual(["doppler-md", "native-pdf", "poppler-text"]);
    expect(() => assertExtractorPluginConfiguration(process.env)).not.toThrow();
  });

  it("is refused at startup where PDFs run only in the VM", () => {
    registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: provider() });
    for (const env of [{ DOCSLURP_SERVICE_PROFILE: "service" }, { DOCSLURP_PDF_EXTRACTOR: VM_PDF_EXTRACTOR_ID }, { DOCSLURP_VM_PDF_INSTALLED: "1" }]) {
      expect(() => assertExtractorPluginConfiguration({ ...env, DOCSLURP_DOPPLER_HOST_PDF: "1" }), JSON.stringify(env)).toThrow(/DOCSLURP_DOPPLER_HOST_PDF=1 parses PDFs on the worker host/);
    }
  });
});

describe("DOCSLURP_SERVICE_PROFILE=service runs PDFs only in vm-pdf", () => {
  it("selects the sandboxed PDF route and refuses every host PDF extractor a workspace names", () => {
    vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service");
    expect(sandboxedPdfConfigured()).toBe(true);
    const registry = new ExtractorRegistry();
    expect(registry.resolve("pdf")).toEqual([VM_PDF_EXTRACTOR_ID]);
    for (const id of ["doppler-md", "native-pdf", "poppler-text", "graph-local", "dolphin"]) {
      expect(() => registry.resolve("pdf", [id]), id).toThrow(new RegExp(`${id} refused for pdf`));
    }
    expect(registry.resolve("office-word")).toEqual(["pandoc"]);
  });

  it("refuses to start without a sandboxed PDF provider, and starts with one", async () => {
    const env = { DOCSLURP_SERVICE_PROFILE: "service" };
    expect(() => assertExtractorPluginConfiguration(env)).toThrow(/DOCSLURP_SERVICE_PROFILE=service needs a sandboxed PDF provider/);
    await expect(loadExtractorPlugins(env)).rejects.toThrow(/needs a sandboxed PDF provider/);
    resetExtractorPluginsForTest();
    registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: provider() });
    expect(() => assertExtractorPluginConfiguration(env)).not.toThrow();
  });

  it("does not treat the self-hosted profile as sandboxed", () => {
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe(false);
    expect(sandboxedPdfConfigured({})).toBe(false);
  });
});
