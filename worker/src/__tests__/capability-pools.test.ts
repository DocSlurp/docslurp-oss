import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activeCapabilityPools, resetActiveCapabilityPoolsForTests, VISION_GLM_HOSTS, VISION_LUNA_HOSTS, type CapabilityPoolServiceRegistration } from "@docslurp/shared";

import {
  EXTRACTOR_PLUGIN_API_VERSION, registerExtractorPlugin, resetExtractorPluginsForTest, sandboxedPdfProvider,
  type SandboxedPdfExtractorProvider, type SandboxedPdfJob, type SandboxedPdfResult,
} from "../extractors/plugins.js";
import { setTextPoolTelemetry, TEXT_POOL_UNAVAILABLE } from "../extractors/text-pool.js";
import { defaultVisionFallbackModel, initializeCapabilityPools, visionPageRouteRegionProblem } from "../lib/capability-pools.js";
import { VISION_MODEL_PROFILES, visionModelProfile } from "../tools/vision-model-profiles.js";

const US = { region: "US" as const, evidence: "provider-docs" as const, source: "https://example.com/privacy", checked: "2026-11-17" };
const textMember = (backend: string, engine: string, extra: Partial<CapabilityPoolServiceRegistration> = {}): CapabilityPoolServiceRegistration =>
  ({ capability: "text", backend, engine, regions: [US], automaticFailover: true, ...extra });

const ok = (output: string): SandboxedPdfResult => ({ exitCode: 0, stdout: "", stderr: "", output } as unknown as SandboxedPdfResult);

function pdfProvider(id: string, run: (job: SandboxedPdfJob) => Promise<SandboxedPdfResult>, extra: Partial<SandboxedPdfExtractorProvider> = {}): SandboxedPdfExtractorProvider {
  return { id, maxSourceBytes: 1_000_000, assertConfigured: () => undefined, run: vi.fn(run), timeoutMs: () => 60_000, ...extra };
}

const quiet = { log: () => undefined };
let events: string[];
beforeEach(() => {
  resetExtractorPluginsForTest();
  resetActiveCapabilityPoolsForTests();
  events = [];
  setTextPoolTelemetry({ served: (id, pages) => events.push(`served ${id} pages=${pages}`), failover: (from, to, reason) => events.push(`failover ${from}>${to ?? "none"} ${reason}`) });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  resetExtractorPluginsForTest();
  resetActiveCapabilityPoolsForTests();
  setTextPoolTelemetry(null);
  vi.restoreAllMocks();
});

describe("worker capability pools at startup", () => {
  it("resolves core's members with no plugins (the open default) and logs them", () => {
    const lines: string[] = [];
    const pools = initializeCapabilityPools({}, (line) => lines.push(line));
    expect(pools.text).toEqual([]);
    expect(pools.ocr.length).toBe(3);
    expect(lines[0]).toMatch(/^\[capability-pools\] text=none ocr=ocr\.llm\.glm-5\.3-flash\+wafer\.us\*/);
    expect(activeCapabilityPools()).toBe(pools);
  });

  it("adds built-in local services only where this deployment runs them", () => {
    const pools = initializeCapabilityPools({ DOCSLURP_PDF_MODE: "local", DOCSLURP_OCR_MODE: "local" }, quiet.log);
    expect(pools.text.map((member) => member.id)).toEqual(["text.service.local-pdf.local"]);
    expect(pools.ocr[0]!.id).toBe("ocr.service.local-ocr.local");
  });

  it("refuses to start when a plugin serves pages without registering its pool member (its region is unknown)", () => {
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "pdf-vm", sandboxedPdf: pdfProvider("pdf-vm", async () => ok("a")) });
    expect(() => initializeCapabilityPools({}, quiet.log)).toThrow(/registers no capability pool member/);
  });

  it("refuses a plugin member outside the US and EU, or one naming a service the plugin does not provide", () => {
    expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "pdf-vm", sandboxedPdf: pdfProvider("pdf-vm", async () => ok("a")),
      poolMembers: [textMember("pdf-vm", "vm-pdf", { regions: [{ ...US, region: "SG" as never }] })] })).toThrow(/not US or EU/);
    expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "pdf-vm", sandboxedPdf: pdfProvider("pdf-vm", async () => ok("a")),
      poolMembers: [textMember("someone-else", "vm-pdf")] })).toThrow(/does not provide/);
  });

  it("refuses an escalation or vision fallback model that is no pool member (no stated region)", () => {
    expect(() => initializeCapabilityPools({ DOCSLURP_OCR_ESCALATION_MODEL: "llm://openrouter/some/model" }, quiet.log)).toThrow(/not an ocr second-read pool member/);
    expect(() => initializeCapabilityPools({ DOCSLURP_VISION_FALLBACK_MODEL: "llm://openrouter/some/model" }, quiet.log)).toThrow(/not a vision pool member/);
    expect(() => initializeCapabilityPools({ DOCSLURP_OCR_ESCALATION_MODEL: "llm://openrouter/z-ai/glm-5.3-flash" }, quiet.log)).not.toThrow();
  });

  it("the default vision fallback is the pool's next automatic member, behind its flag; the operator key overrides or turns it off", () => {
    initializeCapabilityPools({}, quiet.log);
    const on = { DOCSLURP_VISION_POOL_FALLBACK: "on" };
    expect(defaultVisionFallbackModel("llm://openrouter/openai/gpt-6-luna", {})).toBeNull();
    expect(defaultVisionFallbackModel("llm://openrouter/openai/gpt-6-luna", on)).toBe("llm://openrouter/z-ai/glm-5.3-flash");
    expect(defaultVisionFallbackModel("llm://openrouter/z-ai/glm-5.3-flash", on)).toBeNull();
    expect(defaultVisionFallbackModel("llm://openrouter/other/model", on)).toBeNull();
    expect(defaultVisionFallbackModel("llm://openrouter/openai/gpt-6-luna", { ...on, DOCSLURP_VISION_FALLBACK_MODEL: "off" })).toBeNull();
  });

  it("refuses to start when any vision profile may route a page to a host with no stated US or EU region", () => {
    const profiles = VISION_MODEL_PROFILES as Record<string, unknown>;
    profiles["acme/unproven"] = { openRouterProvider: { only: ["fireworks", "parasail"], sort: "price", allow_fallbacks: true } };
    try {
      expect(() => initializeCapabilityPools({}, quiet.log)).toThrow(/acme\/unproven may route to parasail/);
      profiles["acme/unproven"] = { openRouterProvider: { order: ["fireworks"], allow_fallbacks: true } };
      expect(() => initializeCapabilityPools({}, quiet.log)).toThrow(/acme\/unproven has no host allowlist/);
    } finally {
      delete profiles["acme/unproven"];
    }
    expect(() => initializeCapabilityPools({}, quiet.log)).not.toThrow();
  });

  it("refuses at call time a project-chosen route that can reach an unproven host (primary or fallback)", () => {
    expect(visionPageRouteRegionProblem("llm://openrouter/openai/gpt-6-luna")).toBeNull();
    expect(visionPageRouteRegionProblem("llm://openrouter/deepseek/deepseek-v4.1-flash-1017")).toBeNull();
    expect(visionPageRouteRegionProblem("llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct")).toBeNull();
    // No allowlist (any host), a global direct provider: refused.
    // Haiku and Gemini 3.1 Flash Lite keep their stated-region endpoints only.
    expect(visionPageRouteRegionProblem("llm://openrouter/anthropic/claude-haiku-5.5")).toBeNull();
    expect(visionModelProfile("anthropic/claude-haiku-5.5")?.openRouterProvider).toMatchObject({ only: ["amazon-bedrock/us-east-1", "google-vertex/us"] });
    expect(visionPageRouteRegionProblem("llm://openrouter/google/gemini-3.1-flash-lite")).toBeNull();
    // Gemini 2.5 Flash Lite has only AI Studio endpoints (any Google facility): refused.
    expect(visionPageRouteRegionProblem("llm://openrouter/google/gemini-2.5-flash-lite")).toMatch(/no host allowlist/);
    expect(visionPageRouteRegionProblem("llm://openai/gpt-4.1-mini")).toMatch(/openai/);
    // The deployment's own operator route and local runtimes send pages to no third party.
    expect(visionPageRouteRegionProblem("llm://private/reader/model")).toBeNull();
  });

  it("refuses one backend id serving two registrations", () => {
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "pdf-vm", sandboxedPdf: pdfProvider("pdf-vm", async () => ok("a")),
      poolMembers: [textMember("pdf-vm", "vm-pdf")] });
    expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "other", sandboxedPdf: pdfProvider("pdf-vm", async () => ok("b")),
      poolMembers: [textMember("pdf-vm", "vm-pdf-b")] })).toThrow(/already registered|registered twice/);
  });

  it("keeps the vision profiles' host allowlists equal to the pool members' stated-region hosts", () => {
    expect(visionModelProfile("openai/gpt-6-luna")?.openRouterProvider).toMatchObject({ only: [...VISION_LUNA_HOSTS] });
    expect(visionModelProfile("z-ai/glm-5.3-flash")?.openRouterProvider).toMatchObject({ only: [...VISION_GLM_HOSTS] });
  });
});

describe("text capability pool: failover across sandboxed PDF providers", () => {
  function twoProviders(first: (job: SandboxedPdfJob) => Promise<SandboxedPdfResult>, second: (job: SandboxedPdfJob) => Promise<SandboxedPdfResult>, secondFailover = true) {
    const a = pdfProvider("pdf-a", first);
    const b = pdfProvider("pdf-b", second);
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-a", sandboxedPdf: a, poolMembers: [textMember("pdf-a", "vm-pdf-a", { priority: 1 })] });
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-b", sandboxedPdf: b, poolMembers: [textMember("pdf-b", "vm-pdf-b", { priority: 2, automaticFailover: secondFailover })] });
    initializeCapabilityPools({ DOCSLURP_PDF_MODE: "vm" }, quiet.log);
    // Startup binds the telemetry hooks to the meter; the test watches them instead.
    setTextPoolTelemetry({ served: (id, pages) => events.push(`served ${id} pages=${pages}`), failover: (from, to, reason) => events.push(`failover ${from}>${to ?? "none"} ${reason}`) });
    return { a, b, pool: sandboxedPdfProvider()! };
  }
  const job = (output: string): SandboxedPdfJob => ({ input: "/in.pdf", output });
  const context = { pages: 3, recordTiming: () => undefined, onProgress: () => undefined };

  it("refuses a second PDF provider that is not a text pool member", () => {
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-a", sandboxedPdf: pdfProvider("pdf-a", async () => ok("a")), poolMembers: [textMember("pdf-a", "vm-pdf-a")] });
    expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-b", sandboxedPdf: pdfProvider("pdf-b", async () => ok("b")) })).toThrow(/unless each is a text capability pool member/);
  });

  it("serves from the first member and stamps it", async () => {
    const { a, b, pool } = twoProviders(async () => ok("a"), async () => ok("b"));
    expect(await pool.run(job("/out-1"), context)).toMatchObject({ poolMemberId: "text.service.vm-pdf-a.us" });
    expect(a.run).toHaveBeenCalledTimes(1);
    expect(b.run).not.toHaveBeenCalled();
    expect(events).toEqual(["served text.service.vm-pdf-a.us pages=3"]);
  });

  it("fails over when the first member says it could not start the job, and records the failover", async () => {
    const { b, pool } = twoProviders(async () => { throw Object.assign(new Error("VM capacity"), { [TEXT_POOL_UNAVAILABLE]: true }); }, async () => ok("b"));
    expect(await pool.run(job("/out-2"), context)).toMatchObject({ poolMemberId: "text.service.vm-pdf-b.us" });
    expect(b.run).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["failover text.service.vm-pdf-a.us>text.service.vm-pdf-b.us unavailable", "served text.service.vm-pdf-b.us pages=3"]);
  });

  it("never resends a file after a VM crash, OOM or guest error the file could have caused (no unavailable marker)", async () => {
    for (const crash of [new Error("guest exited 137"), Object.assign(new Error("out of memory"), { name: "SandboxRunError" })]) {
      resetExtractorPluginsForTest();
      resetActiveCapabilityPoolsForTests();
      const { b, pool } = twoProviders(async () => { throw crash; }, async () => ok("b"));
      await expect(pool.run(job("/out-crash"), context)).rejects.toBe(crash);
      expect(b.run).not.toHaveBeenCalled();
    }
  });

  it("reports a member that cannot do the job as unsupported", async () => {
    const a = pdfProvider("pdf-a", async () => ok("a"));
    const b = pdfProvider("pdf-b", async () => ok("b"), { pageCount: async () => ({ pages: 7 }) });
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-a", sandboxedPdf: a, poolMembers: [textMember("pdf-a", "vm-pdf-a", { priority: 1 })] });
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-b", sandboxedPdf: b, poolMembers: [textMember("pdf-b", "vm-pdf-b", { priority: 2 })] });
    initializeCapabilityPools({}, quiet.log);
    setTextPoolTelemetry({ served: (id, pages) => events.push(`served ${id} pages=${pages}`), failover: (from, to, reason) => events.push(`failover ${from}>${to ?? "none"} ${reason}`) });
    expect(await sandboxedPdfProvider()!.pageCount!({ input: "/in.pdf" })).toEqual({ pages: 7 });
    expect(events[0]).toBe("failover text.service.vm-pdf-a.us>text.service.vm-pdf-b.us unsupported");
  });

  it("serves startup checks before the pools are resolved, then runs in pool order once they are", async () => {
    const a = pdfProvider("pdf-a", async () => ok("a"), { figures: { producerId: "figs" } });
    const b = pdfProvider("pdf-b", async () => ok("b"));
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-b", sandboxedPdf: b, poolMembers: [textMember("pdf-b", "vm-pdf-b", { priority: 2 })] });
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "plugin-a", sandboxedPdf: a, poolMembers: [textMember("pdf-a", "vm-pdf-a", { priority: 1 })] });
    // Before initialization (extractor plugin configuration checks): features read without throwing; a job is refused.
    const provider = sandboxedPdfProvider()!;
    expect(provider.id).toBe("pdf-b");
    await expect(provider.run(job("/early"), context)).rejects.toThrow(/before worker startup resolved/);
    initializeCapabilityPools({}, quiet.log);
    expect(provider.id).toBe("pdf-a");
    expect(provider.figures).toEqual({ producerId: "figs" });
    expect(await provider.run(job("/later"), context)).toMatchObject({ poolMemberId: "text.service.vm-pdf-a.us" });
  });

  it("never fails over a refusal of the input itself (it would only be refused and billed again)", async () => {
    const { b, pool } = twoProviders(async () => { throw Object.assign(new Error("encrypted"), { refused: true }); }, async () => ok("b"));
    await expect(pool.run(job("/out-3"), context)).rejects.toThrow("encrypted");
    expect(b.run).not.toHaveBeenCalled();
  });

  it("never fails over to a member without automatic failover", async () => {
    const { b, pool } = twoProviders(async () => { throw Object.assign(new Error("VM capacity"), { [TEXT_POOL_UNAVAILABLE]: true }); }, async () => ok("b"), false);
    await expect(pool.run(job("/out-4"), context)).rejects.toThrow("VM capacity");
    expect(b.run).not.toHaveBeenCalled();
  });

  it("isolates organizations: two organizations' identical documents each run, and nothing is reused between jobs", async () => {
    const { a, pool } = twoProviders(async (current) => ok(current.output), async () => ok("b"));
    const orgA = { input: "/same-bytes.pdf", output: "/org-a/out" };
    const orgB = { input: "/same-bytes.pdf", output: "/org-b/out" };
    await pool.run(orgA, context);
    await pool.run(orgB, context);
    // Each job ran on its own: no dedup by input, no shared result.
    expect(a.run).toHaveBeenCalledTimes(2);
    expect((a.run as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as SandboxedPdfJob).output)).toEqual(["/org-a/out", "/org-b/out"]);
  });
});
