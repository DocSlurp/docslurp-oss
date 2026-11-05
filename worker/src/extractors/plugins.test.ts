import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VM_PDF_EXTRACTOR_ID, assertExtractorPluginConfiguration, extractorPluginSpecifiers, loadExtractorPlugins, registerExtractorPlugin,
  requireSandboxedPdfProvider, resetExtractorPluginsForTest, sandboxedPdfProvider, type ExtractorPlugin, type SandboxedPdfExtractorProvider,
} from "./plugins.js";
import { ExtractorRegistry } from "./registry.js";
import { CommandRunner } from "../tools/runner.js";
import { SandboxRunError } from "../sandbox/types.js";
import { shardProfile } from "../temporal/page-shard-profiles.js";

const prior = { stage: "extract-markdown", executor: "test-vm", fixedMs: 1_000, perPageMs: 10, baseMiB: 100, perPageMiB: 0, memoryLimitMiB: 1_024,
  maxShardMs: 60_000, minShardPages: 8, maxShardPages: 1_000, pageAlign: 8, usdPerSecond: 0.0001 };
const provider = (over: Partial<SandboxedPdfExtractorProvider> = {}): SandboxedPdfExtractorProvider => ({
  id: "test-vm", maxSourceBytes: 1024, assertConfigured: () => undefined,
  run: vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" })), timeoutMs: (pages) => 1_000 + pages,
  ...over,
});
const plugin = (over: Partial<ExtractorPlugin> = {}): ExtractorPlugin => ({ apiVersion: 1, name: "test-plugin", sandboxedPdf: provider(), ...over });

afterEach(() => { resetExtractorPluginsForTest(); vi.unstubAllEnvs(); });

describe("extractor plugin registration", () => {
  it("serves vm-pdf only through a registered provider and refuses local fallback without one", async () => {
    const runner = new CommandRunner();
    await expect(runner.sandboxedPdfMarkdown("/job/input.pdf", "/job/output.md")).rejects.toThrow("refusing local fallback");
    await expect(new ExtractorRegistry().prepare(VM_PDF_EXTRACTOR_ID, runner, "/tenant-a/job/input.pdf")).rejects.toThrow("refusing local fallback");
    registerExtractorPlugin(plugin());
    const prepared = await new ExtractorRegistry().prepare(VM_PDF_EXTRACTOR_ID, runner, "/tenant-a/job/input.pdf");
    expect(prepared.plan).toMatchObject({ available: true, binary: "test-vm", sandboxedPdf: { input: "/tenant-a/job/input.pdf", output: "/tenant-a/job/input.pdf.vm-pdf.md" } });
    await expect(runner.sandboxedPdfMarkdown("relative.pdf", "/output")).rejects.toThrow("absolute");
    await expect(runner.sandboxedPdfMarkdown("/same", "/same")).rejects.toThrow("distinct");
  });

  it("puts vm-pdf first only when the deployment selects it, and keeps it PDF-only", () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", VM_PDF_EXTRACTOR_ID);
    const registry = new ExtractorRegistry();
    expect(registry.resolve("pdf")).toEqual([VM_PDF_EXTRACTOR_ID]);
    expect(() => registry.resolve("image", [VM_PDF_EXTRACTOR_ID])).toThrow("does not support");
  });

  it("refuses a provider that is not ready instead of running anything", async () => {
    registerExtractorPlugin(plugin({ sandboxedPdf: provider({ assertConfigured: () => { throw new Error("image is not digest-pinned"); } }) }));
    await expect(new CommandRunner().sandboxedPdfMarkdown("/a.pdf", "/a.md")).rejects.toThrow("digest-pinned");
  });

  it("dispatches the VM job to the provider with the page count, calibrated profile and budget", async () => {
    const run = vi.fn(async () => ({ exitCode: 0, stdout: "{}", stderr: "" }));
    registerExtractorPlugin(plugin({ sandboxedPdf: provider({ run, shardProfile: { key: "extract-markdown:test-vm", prior } }) }));
    expect(shardProfile("extract-markdown:test-vm")).toBe(prior);
    const profile = vi.fn(async () => prior);
    const runner = new CommandRunner({ shardCalibration: { profile } });
    const plan = { ...(await runner.sandboxedPdfMarkdown("/a.pdf", "/a.md")), pages: 40 };
    const launched = await runner.launch(plan);
    expect("remote" in launched && launched.timeoutMs).toBe(1_040);
    if ("remote" in launched) await launched.remote;
    const calls = run.mock.calls as unknown as Array<[unknown, { pages: number; profile?: () => Promise<unknown> }]>;
    expect(calls[0]![0]).toEqual({ input: "/a.pdf", output: "/a.md" });
    expect(calls[0]![1].pages).toBe(40);
    await calls[0]![1].profile!();
    expect(profile).toHaveBeenCalledWith("extract-markdown:test-vm");
  });

  it("allows one provider per capability and checks the plugin shape", () => {
    registerExtractorPlugin(plugin());
    expect(() => registerExtractorPlugin(plugin({ name: "second" }))).toThrow("Only one sandboxed PDF");
    resetExtractorPluginsForTest();
    expect(() => registerExtractorPlugin({ ...plugin(), apiVersion: 2 as 1 })).toThrow("API version");
    expect(() => registerExtractorPlugin(plugin({ name: "Bad Name" }))).toThrow("lowercase name");
    expect(() => registerExtractorPlugin(plugin({ sandboxedPdf: { ...provider(), run: undefined as never } }))).toThrow("run()");
    expect(() => registerExtractorPlugin(plugin({ sandboxedPdf: { ...provider(), embeddedImages: { producerId: "x y", optionsDigest: "", read: async () => { throw new Error(); } } } }))).toThrow("producerId");
    expect(sandboxedPdfProvider()).toBeNull();
  });
});

describe("loading plugins by configuration", () => {
  it("loads a module named by absolute path and gives it the worker's own classes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "extractor-plugin-"));
    try {
      const file = path.join(dir, "plugin.mjs");
      await writeFile(file, `export function register(host) {
        globalThis.__pluginHost = host;
        return { apiVersion: 1, name: "file-plugin", sandboxedPdf: { id: "file-vm", maxSourceBytes: 10, assertConfigured() {}, timeoutMs: () => 1,
          async run() { throw new host.SandboxRunError("refused in test"); } } };
      }\n`);
      vi.stubEnv("DOCSLURP_EXTRACTOR_PLUGINS", file);
      vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", VM_PDF_EXTRACTOR_ID);
      expect(await loadExtractorPlugins()).toEqual(["file-plugin"]);
      expect(await loadExtractorPlugins()).toEqual(["file-plugin"]);
      const host = (globalThis as { __pluginHost?: { SandboxRunError: unknown; apiVersion: number } }).__pluginHost!;
      expect(host.apiVersion).toBe(1);
      expect(host.SandboxRunError).toBe(SandboxRunError);
      await expect(requireSandboxedPdfProvider().run({ input: "/a", output: "/b" }, { pages: 1, recordTiming() {}, onProgress() {} })).rejects.toBeInstanceOf(SandboxRunError);
      vi.stubEnv("DOCSLURP_EXTRACTOR_PLUGINS", `${file},${file}`);
      await expect(loadExtractorPlugins()).rejects.toThrow("different");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed: unloadable modules, missing register and a VM selection without a provider stop startup", async () => {
    await expect(loadExtractorPlugins({ DOCSLURP_EXTRACTOR_PLUGINS: "/nonexistent/plugin.mjs" })).rejects.toThrow("failed to load");
    resetExtractorPluginsForTest();
    await expect(loadExtractorPlugins({ DOCSLURP_EXTRACTOR_PLUGINS: "/x.mjs" }, async () => ({}))).rejects.toThrow("no register");
    resetExtractorPluginsForTest();
    expect(() => extractorPluginSpecifiers({ DOCSLURP_EXTRACTOR_PLUGINS: "relative/plugin.mjs" })).toThrow("absolute");
    await expect(loadExtractorPlugins({ DOCSLURP_PDF_EXTRACTOR: VM_PDF_EXTRACTOR_ID })).rejects.toThrow("needs a sandboxed PDF provider");
    resetExtractorPluginsForTest();
    expect(() => assertExtractorPluginConfiguration({ DOCSLURP_VM_PDF_INSTALLED: "1" })).toThrow("needs a sandboxed PDF provider");
    expect(() => assertExtractorPluginConfiguration({})).not.toThrow();
    expect(await loadExtractorPlugins({})).toEqual([]);
  });
});
