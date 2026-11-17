import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLABLE_UNIT_METRICS, setPrivateModelEndpointRegistryForTests, UNIT_CHARGE_PROVIDER } from "@docslurp/shared";

import {
  EXTRACTOR_PLUGIN_API_VERSION, loadedPluginCapabilities, PAGE_READER_NO_COMPUTE_PROPERTY, PAGE_READER_USAGE_PROPERTY, pageReaderUsageOf, registerExtractorPlugin, resetExtractorPluginsForTest,
  type PageImageReadJob, type PageImageReaderProvider, type SandboxedOcrProvider,
} from "../../extractors/plugins.js";
import type { ProjectRun, UsageEvent } from "../../models.js";
import { WorkflowState } from "../../pipeline/pipeline.js";
import { fakeOcrRunner, pngHeader } from "../../test/fake-ocr.js";
import type { OcrPageRead, OcrReadOutcome } from "../engine.js";
import type { HostedOcrReader } from "../hosted-reader.js";
import { assertOcrConfiguration } from "../mode.js";
import {
  assertOcrPageReaderConfiguration, DEFAULT_OCR_PAGE_READER_MAX_PAGES, ocrPageReaderMaxPages, ocrPageReaderMode, readPagesWithProvider, validatePageReadResults,
  readOcrPagesWithConfiguredReader, MAX_PAGE_READER_TOKENS_PER_PAGE, pageReaderPagesRemaining, type PageReaderContext,
} from "../page-reader.js";
import { InMemoryPageReaderOrgBudget } from "../page-reader-budget.js";
import { ocrPageReaderOrgDailyMaxCostCents, pageReaderAllowedForPrivacy } from "../page-reader-mode.js";
import { ocrDocument } from "../read-document.js";

let scratch: string;
beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-page-reader-"));
  resetExtractorPluginsForTest();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  resetExtractorPluginsForTest();
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

function runState(run: Record<string, unknown> = {}): WorkflowState {
  const state = WorkflowState.create({
    id: "run-1", orgId: "org-1", projectId: "proj-1", userId: "user-1", artifacts: {}, stats: {}, stage: "extract-markdown", spentCents: 0,
    pipeline: { privacyMode: "standard" },
    ...run,
  } as unknown as ProjectRun, []);
  state.usageLedger.runId = String(run.id ?? "run-1");
  // Each test has its own org daily ledger (the process ledger would carry spend between tests).
  state.pageReaderBudget = new InMemoryPageReaderOrgBudget();
  return state;
}

type ReadImpl = PageImageReaderProvider["read"];

function reader(read: ReadImpl, overrides: Partial<PageImageReaderProvider> = {}): PageImageReaderProvider & { read: ReturnType<typeof vi.fn> } {
  return { id: "test-page-reader", model: "test-reader-model", maxPagesPerJob: 8, maxImageBytes: 1 << 20, maxMarkdownBytes: 4096, assertConfigured: vi.fn(), read: vi.fn(read), ...overrides } as never;
}

/** Answers every page with Markdown naming its image file, and one usage event for the job. */
const echo: ReadImpl = async (job) => ({
  results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: `# Read ${path.basename(page.imagePath)}`, inputTokens: 10, outputTokens: 5 })),
  usage: [{ provider: "test-vm", model: "x", metric: "anything", amount: job.pages.length, unit: "page", costCents: 0.3, inputTokens: 10 * job.pages.length, outputTokens: 5 * job.pages.length }],
});

async function png(name: string, width = 100, height = 50): Promise<string> {
  const file = path.join(scratch, name);
  await writeFile(file, pngHeader(width, height));
  return file;
}

/** An outcome with a kept boundary PNG on each page marked `image`; `escalate` also makes it a hosted escalation candidate. */
async function outcomeWith(pages: Array<{ pageNumber: number; text?: string; image?: boolean; escalate?: boolean }>): Promise<OcrReadOutcome> {
  const reads: OcrPageRead[] = [];
  for (const page of pages) {
    const text = page.text ?? `recogniser ${page.pageNumber}`;
    const read: OcrPageRead = { pageNumber: page.pageNumber, text, meanConfidence: 0.5, recogniser: "multi", chars: text.length, elapsedMs: 1, escalation: null };
    if (page.image !== false) {
      const imagePath = await png(`frame-${String(page.pageNumber).padStart(4, "0")}.png`);
      read.image = { imagePath, width: 100, height: 50 };
      if (page.escalate) read.escalation = { reason: "low-confidence", imagePath, width: 100, height: 50 };
    }
    reads.push(read);
  }
  return {
    mode: "vm", engine: "test-vm-ocr", language: { recognisers: ["multi"], unsupportedScript: false, setting: "auto" },
    pages: reads, truncatedFrames: false, unreadPages: [], wallMs: 1, cpuMs: 1, peakRssKb: 1, dispose: async () => undefined,
  };
}

function ctx(state: WorkflowState, overrides: Partial<PageReaderContext> = {}): PageReaderContext {
  return { state, documentId: "doc-1", mode: "escalation", maxPages: 100, ...overrides };
}

const readerEvents = (state: WorkflowState) => state.usageLedger.snapshot().filter((event) => event.metric === "ocr-page-reader");

describe("configuration", () => {
  it("defaults to off and accepts each mode", () => {
    expect(ocrPageReaderMode({})).toBe("off");
    expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: " " })).toBe("off");
    for (const mode of ["off", "escalation", "all"]) expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: mode.toUpperCase() })).toBe(mode);
  });

  it("resolves a tier word through the reviewed OCR route options and the registered reader's measured score", () => {
    const register = (extra: Partial<PageImageReaderProvider>) => {
      resetExtractorPluginsForTest();
      registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "tier-reader", pageImageReader: reader(echo, extra) });
    };
    // No reader registered: every tier keeps the recogniser route.
    for (const tier of ["fastest", "balanced", "smart"]) expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: tier })).toBe("off");
    register({ evalScore: 0.95, evalRef: "tier-benchmark-v1/page-ocr/development/run" });
    expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: "fastest" })).toBe("off");
    expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: "balanced" })).toBe("escalation");
    expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: "smart", DOCSLURP_OCR_ESCALATION: "on" })).toBe("all");
    // A reader measured under the hosted escalation reader is not smart while escalation is on.
    register({ evalScore: 0.5, evalRef: "tier-benchmark-v1/page-ocr/development/run" });
    expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: "smart", DOCSLURP_OCR_ESCALATION: "on" })).toBe("off");
    // An unmeasured reader is never chosen by a tier.
    register({});
    expect(ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: "smart" })).toBe("off");
  });

  it("refuses a reader whose eval score is out of range or lacks its run", () => {
    for (const extra of [{ evalScore: 1.5, evalRef: "r" }, { evalScore: 0.9 }, { evalRef: "r" }, { evalScore: 0.9, evalRef: " " }]) {
      resetExtractorPluginsForTest();
      expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "bad-reader", pageImageReader: reader(echo, extra as never) })).toThrow(/evalScore|evalRef/);
    }
  });

  it("refuses an unknown mode", () => {
    for (const value of ["on", "true", "1", "fast", "escalation,all"]) {
      expect(() => ocrPageReaderMode({ DOCSLURP_OCR_PAGE_READER: value }), value).toThrow(/DOCSLURP_OCR_PAGE_READER must be one of/);
      expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: value }, "vm"), value).toThrow(/must be one of/);
    }
  });

  it("bounds the per-document budget to 0..20000, default 2000, refusing anything else", () => {
    expect(ocrPageReaderMaxPages({})).toBe(DEFAULT_OCR_PAGE_READER_MAX_PAGES);
    expect(ocrPageReaderMaxPages({ DOCSLURP_OCR_PAGE_READER_MAX_PAGES: "0" })).toBe(0);
    expect(ocrPageReaderMaxPages({ DOCSLURP_OCR_PAGE_READER_MAX_PAGES: "20000" })).toBe(20_000);
    for (const bad of ["20001", "-1", "1.5", "many", "1e3"]) expect(() => ocrPageReaderMaxPages({ DOCSLURP_OCR_PAGE_READER_MAX_PAGES: bad }), bad).toThrow(/MAX_PAGES/);
  });

  it("refuses to start with the flag on and no provider", () => {
    expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "escalation" }, "vm")).toThrow(/needs a page image reader plugin/);
    expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "all" }, "local")).toThrow(/refusing to start/);
    expect(assertOcrPageReaderConfiguration({}, "vm")).toBe("off");
  });

  it("refuses to start when the provider is not ready, or outside the vm and local OCR modes", () => {
    const provider = reader(echo, { assertConfigured: () => { throw new Error("reader image is not pinned"); } });
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: provider });
    expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "escalation" }, "vm")).toThrow(/not pinned/);
    resetExtractorPluginsForTest();
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: reader(echo) });
    for (const mode of ["hosted", "off"] as const) {
      expect(() => assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "all" }, mode), mode).toThrow(/needs DOCSLURP_OCR_MODE=vm or local/);
    }
    expect(assertOcrPageReaderConfiguration({ DOCSLURP_OCR_PAGE_READER: "all" }, "vm")).toBe("all");
    expect(loadedPluginCapabilities()).toContain("page-reader");
  });

  it("runs from the OCR startup check", () => {
    const ocr: SandboxedOcrProvider = { id: "test-vm-ocr", maxSourceBytes: 1024, assertConfigured: vi.fn(), run: vi.fn(), timeoutMs: () => 1 };
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-ocr-plugin", sandboxedOcr: ocr });
    expect(() => assertOcrConfiguration({ DOCSLURP_OCR_MODE: "vm", DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_OCR_PAGE_READER: "escalation" })).toThrow(/page image reader plugin/);
    expect(assertOcrConfiguration({ DOCSLURP_OCR_MODE: "vm", DOCSLURP_SERVICE_PROFILE: "service" })).toBe("vm");
  });

  it("registers exactly one well-formed provider", () => {
    const register = (overrides: Partial<PageImageReaderProvider>) => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: reader(echo, overrides) });
    expect(() => register({ id: "Bad Id" })).toThrow(/lowercase id/);
    expect(() => register({ model: "has spaces\n" })).toThrow(/model id/);
    expect(() => register({ maxPagesPerJob: 0 })).toThrow(/maxPagesPerJob/);
    expect(() => register({ maxMarkdownBytes: 1.5 })).toThrow(/maxMarkdownBytes/);
    register({});
    expect(() => register({})).toThrow(/Only one page image reader/);
  });

  it("reads usage off a rejection", () => {
    const event = { provider: "p", model: "m", metric: "x", amount: 1, unit: "page", costCents: 1 };
    expect(pageReaderUsageOf(Object.assign(new Error("x"), { [PAGE_READER_USAGE_PROPERTY]: [event, null, { nope: 1 }] }))).toEqual([event]);
    expect(pageReaderUsageOf(Object.assign(new Error("x"), { usage: event }))).toEqual([event]);
    expect(pageReaderUsageOf(null)).toEqual([]);
  });
});

describe("validatePageReadResults", () => {
  const keys = new Set(["a", "b"]);
  it("accepts read and failed results", () => {
    const map = validatePageReadResults([{ key: "a", status: "read", markdown: "x", inputTokens: 1, outputTokens: 2 }, { key: "b", status: "failed", reason: "timeout" }], keys, 10);
    expect(map.get("a")).toMatchObject({ status: "read", markdown: "x" });
    expect(map.get("b")).toMatchObject({ status: "failed", reason: "timeout" });
  });
  it.each([
    ["not an array", { results: [] }],
    ["unknown key", [{ key: "zzz", status: "read", markdown: "x" }]],
    ["duplicate key", [{ key: "a", status: "read", markdown: "x" }, { key: "a", status: "read", markdown: "y" }]],
    ["oversized markdown", [{ key: "a", status: "read", markdown: "é".repeat(6) }]],
    ["non-string markdown", [{ key: "a", status: "read", markdown: { html: "<p>" } }]],
    ["bad reason", [{ key: "a", status: "failed", reason: "exploded" }]],
    ["bad status", [{ key: "a", status: "maybe" }]],
    ["negative tokens", [{ key: "a", status: "read", markdown: "x", inputTokens: -1 }]],
    ["fractional tokens", [{ key: "a", status: "read", markdown: "x", outputTokens: 1.5 }]],
    ["too many results", [{ key: "a", status: "read", markdown: "x" }, { key: "b", status: "read", markdown: "x" }, { key: "a", status: "read", markdown: "x" }]],
  ])("rejects %s", (_name, raw) => {
    expect(() => validatePageReadResults(raw, keys, 10)).toThrow();
  });
});

describe("InMemoryPageReaderOrgBudget.releaseUnused", () => {
  it("releases only the organization's own unsettled, cost-free ticket", async () => {
    const budget = new InMemoryPageReaderOrgBudget();
    const mine = await budget.admit({ orgId: "org-a", reserveCents: 40, capCents: 100 });
    const theirs = await budget.admit({ orgId: "org-b", reserveCents: 40, capCents: 100 });
    const settled = await budget.admit({ orgId: "org-a", reserveCents: 30, capCents: 100 });
    if (!mine.admitted || !theirs.admitted || !settled.admitted) throw new Error("not admitted");
    expect(await budget.releaseUnused(theirs.ticket, "org-a")).toBe(false);
    expect(await budget.releaseUnused("no-such-ticket", "org-a")).toBe(false);
    expect(await budget.committedCents("org-b")).toBe(40);
    await budget.settle(settled.ticket, 12);
    expect(await budget.releaseUnused(settled.ticket, "org-a")).toBe(false);
    expect(await budget.releaseUnused(mine.ticket, "org-a")).toBe(true);
    expect(await budget.releaseUnused(mine.ticket, "org-a")).toBe(false);
    expect(await budget.committedCents("org-a")).toBe(12);
  });
});

describe("readPagesWithProvider", () => {
  it("replaces read pages, clears their escalation, records usage at 0 credits and logs ai-usage", async () => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1, escalate: true }, { pageNumber: 2, escalate: true }]);
    const provider = reader(echo);
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(summary).toMatchObject({ attempted: 2, replaced: 2, jobs: 1, inputTokens: 20, outputTokens: 10 });
    expect(outcome.pages.map((page) => [page.text, page.recogniser, page.escalation])).toEqual([
      ["# Read frame-0001.png", "page-reader:test-page-reader", null],
      ["# Read frame-0002.png", "page-reader:test-page-reader", null],
    ]);
    const job = provider.read.mock.calls[0]![0] as PageImageReadJob;
    expect(job.scope).toEqual({ orgId: "org-1", runId: "run-1" });
    // Keys are opaque: never the document id or a page number.
    for (const page of job.pages) expect(page.key).not.toMatch(/doc-1|^\d+$/);
    const events = readerEvents(state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metric: "ocr-page-reader", model: "test-reader-model", costCents: 0, inputTokens: 20, outputTokens: 10,
      metadata: { providerCostCents: 0.3, billable: false, orgId: "org-1", runId: "run-1", projectId: "proj-1", documentId: "doc-1" } });
    expect(console.log).toHaveBeenCalledWith("[ai-usage] ocr-page-reader model=test-reader-model input_tokens=20 output_tokens=10");
    // Charged as one OCR page each, at most once (no extra unit for the reader), never Rich.
    expect(state.usageLedger.pageChargeClass("doc-1", 1)).toBe("ocr");
    expect(state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-ocr" && event.metadata?.pageNumber === 1).map((event) => event.id)).toEqual(["ocr:run-1:doc-1:1"]);
    expect(state.usageLedger.richPagesCharged("doc-1", 1)).toBe(0);
  });

  it("never lets a provider event become a billable unit charge", async () => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    const sneaky: ReadImpl = async (job) => ({
      results: [{ key: job.pages[0]!.key, status: "read", markdown: "x" }],
      usage: [{ provider: UNIT_CHARGE_PROVIDER, model: UNIT_CHARGE_PROVIDER, metric: BILLABLE_UNIT_METRICS.richPage, amount: 1, unit: "page", costCents: 999, metadata: { unitCharge: true, orgId: "org-2" } }],
    });
    await readPagesWithProvider(outcome, reader(sneaky), ctx(state));
    const events = readerEvents(state);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metric: "ocr-page-reader", costCents: 0, metadata: { orgId: "org-1", billable: false } });
    expect(events[0]!.metadata?.unitCharge).toBeUndefined();
    expect(state.usageLedger.snapshot().some((event) => event.costCents === 999 || event.metadata?.orgId === "org-2")).toBe(false);
  });

  it.each([
    ["unknown key", (job: PageImageReadJob) => [{ key: "not-sent", status: "read", markdown: "x" }, ...job.pages.slice(1).map((page) => ({ key: page.key, status: "read", markdown: "x" }))]],
    ["duplicate key", (job: PageImageReadJob) => [{ key: job.pages[0]!.key, status: "read", markdown: "x" }, { key: job.pages[0]!.key, status: "read", markdown: "y" }]],
    ["oversized markdown", (job: PageImageReadJob) => [{ key: job.pages[0]!.key, status: "read", markdown: "x".repeat(5000) }]],
    ["bad reason", (job: PageImageReadJob) => [{ key: job.pages[0]!.key, status: "failed", reason: "melted" }]],
    ["non-string markdown", (job: PageImageReadJob) => [{ key: job.pages[0]!.key, status: "read", markdown: 42 }]],
  ])("rejects a malformed response (%s) whole: pages keep the recogniser text and stay escalation candidates", async (_name, results) => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1, escalate: true }, { pageNumber: 2, escalate: true }]);
    const provider = reader(async (job) => ({ results: results(job) as never, usage: [{ provider: "test-vm", model: "x", metric: "m", amount: 2, unit: "page", costCents: 0.2 }] }));
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(summary).toMatchObject({ attempted: 2, replaced: 0, failed: { "invalid-response": 2 } });
    expect(outcome.pages.map((page) => [page.text, page.recogniser, page.escalation?.reason])).toEqual([
      ["recogniser 1", "multi", "low-confidence"],
      ["recogniser 2", "multi", "low-confidence"],
    ]);
    // The spent compute is still recorded.
    expect(readerEvents(state)).toHaveLength(1);
    expect(readerEvents(state)[0]!.metadata).toMatchObject({ providerCostCents: 0.2, outcome: "failed" });
  });

  it("records the usage of a failed job and leaves its pages to hosted escalation", async () => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1, escalate: true }]);
    const usage: UsageEvent[] = [{ provider: "test-vm", model: "x", metric: "vm", amount: 1, unit: "second", costCents: 0.05 }];
    const provider = reader(async () => { throw Object.assign(new Error("VM lost"), { [PAGE_READER_USAGE_PROPERTY]: usage }); });
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(summary).toMatchObject({ attempted: 1, replaced: 0, failed: { "job-failed": 1 } });
    expect(outcome.pages[0]).toMatchObject({ text: "recogniser 1", recogniser: "multi", escalation: { reason: "low-confidence" } });
    expect(readerEvents(state)).toHaveLength(1);
    expect(readerEvents(state)[0]!.metadata).toMatchObject({ providerCostCents: 0.05, outcome: "failed" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("page-reader job failed document=doc-1 pages=1 reason=job-failed"));
  });

  it("counts a refused job apart and never fails the document", async () => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    const summary = await readPagesWithProvider(outcome, reader(async () => { throw Object.assign(new Error("input refused"), { ocrRefused: true }); }), ctx(state));
    expect(summary.failed).toEqual({ "job-refused": 1 });
    expect(outcome.pages[0]!.text).toBe("recogniser 1");
  });

  it("counts per-page failures and empty reads, keeping those pages as they were", async () => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1, escalate: true }, { pageNumber: 2, escalate: true }, { pageNumber: 3, escalate: true }]);
    const provider = reader(async (job) => ({
      results: [{ key: job.pages[0]!.key, status: "failed", reason: "timeout" }, { key: job.pages[1]!.key, status: "read", markdown: "   " }],
      usage: [],
    }));
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(summary).toMatchObject({ attempted: 3, replaced: 0, empty: 1, failed: { timeout: 1, missing: 1 } });
    expect(outcome.pages.every((page) => page.recogniser === "multi" && page.escalation)).toBe(true);
  });

  it("never calls the provider without an organization scope", async () => {
    const state = runState({ orgId: null });
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    const provider = reader(echo);
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(provider.read).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual({ "no-scope": 1 });
    const noRun = await readPagesWithProvider(outcome, provider, { documentId: "doc-1", mode: "all", maxPages: 10, state: { usageLedger: state.usageLedger } });
    expect(noRun.skipped).toEqual({ "no-scope": 1 });
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("scopes every job to the run's own organization and run", async () => {
    const provider = reader(echo);
    for (const [org, run] of [["org-a", "run-a"], ["org-b", "run-b"]]) {
      const state = runState({ id: run, orgId: org });
      await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state));
    }
    expect(provider.read.mock.calls.map((call) => (call[0] as PageImageReadJob).scope)).toEqual([{ orgId: "org-a", runId: "run-a" }, { orgId: "org-b", runId: "run-b" }]);
  });

  it("never sends a PNG with a bad signature, a changed size or over the provider's byte cap", async () => {
    const state = runState();
    const outcome = await outcomeWith([{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }, { pageNumber: 4 }]);
    await writeFile(outcome.pages[0]!.image!.imagePath, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)]));
    await writeFile(outcome.pages[1]!.image!.imagePath, pngHeader(4000, 50));
    await writeFile(outcome.pages[2]!.image!.imagePath, Buffer.concat([pngHeader(100, 50), Buffer.alloc(200)]));
    const provider = reader(echo, { maxImageBytes: 100 });
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(summary.skipped).toEqual({ "image-refused": 3 });
    const sent = (provider.read.mock.calls[0]![0] as PageImageReadJob).pages.map((page) => path.basename(page.imagePath));
    expect(sent).toEqual(["frame-0004.png"]);
  });

  it("honours the per-document budget across calls and chunks jobs by maxPagesPerJob", async () => {
    const state = runState();
    const provider = reader(echo, { maxPagesPerJob: 2 });
    const first = await readPagesWithProvider(await outcomeWith([1, 2, 3].map((pageNumber) => ({ pageNumber }))), provider, ctx(state, { maxPages: 4 }));
    expect(first).toMatchObject({ attempted: 3, jobs: 2 });
    expect(provider.read.mock.calls.map((call) => (call[0] as PageImageReadJob).pages.length)).toEqual([2, 1]);
    const second = await readPagesWithProvider(await outcomeWith([4, 5, 6].map((pageNumber) => ({ pageNumber }))), provider, ctx(state, { maxPages: 4 }));
    expect(second).toMatchObject({ attempted: 1, skipped: { budget: 2 } });
    // Another document has its own budget.
    const other = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state, { maxPages: 4, documentId: "doc-2" }));
    expect(other.attempted).toBe(1);
    const zero = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(runState(), { maxPages: 0 }));
    expect(zero).toMatchObject({ attempted: 0, skipped: { budget: 1 } });
  });

  it("stops at the run cost cap", async () => {
    const state = runState({ spentCents: 500, pipeline: { privacyMode: "standard", maxCostCents: 100 } });
    const provider = reader(echo);
    const summary = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state));
    expect(provider.read).not.toHaveBeenCalled();
    expect(summary.skipped).toEqual({ "cost-cap": 1 });
  });

  it("stops at the organization's daily provider-cost cap, which the run cost cap does not see", async () => {
    const state = runState();
    const provider = reader(echo, { maxPagesPerJob: 1 });
    const outcome = await outcomeWith([{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }]);
    const summary = await readPagesWithProvider(outcome, provider, ctx(state, { orgDailyMaxCostCents: 0.5 } as never));
    // 0.3 cents per job: the second job reaches 0.6, so the third is not sent.
    expect(provider.read).toHaveBeenCalledTimes(2);
    expect(summary.skipped).toEqual({ "org-daily-cost-cap": 1 });
    expect(outcome.pages[2]!.text).toBe("recogniser 3");
    // The cap is the organization's for the day, not the document's: another document of the org is refused too.
    const other = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state, { orgDailyMaxCostCents: 0.5, documentId: "doc-2" } as never));
    expect(other.skipped).toEqual({ "org-daily-cost-cap": 1 });
    // Another organization has its own budget.
    const otherOrg = runState({ id: "run-2", orgId: "org-2" });
    otherOrg.pageReaderBudget = state.pageReaderBudget;
    const fresh = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(otherOrg, { orgDailyMaxCostCents: 0.5 } as never));
    expect(fresh.attempted).toBe(1);
  });

  it("reserves the provider's job estimate so concurrent jobs of one organization cannot pass the cap together", async () => {
    const budget = new InMemoryPageReaderOrgBudget();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = reader(async (job) => { await gate; return echo(job); }, { estimateJobCostCents: () => 0.4 });
    const states = [runState({ id: "run-a" }), runState({ id: "run-b" }), runState({ id: "run-c" })];
    for (const state of states) state.pageReaderBudget = budget;
    const runs = states.map(async (state, index) =>
      readPagesWithProvider(await outcomeWith([{ pageNumber: index + 1 }]), provider, ctx(state, { orgDailyMaxCostCents: 1, documentId: `doc-${index}` } as never)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const summaries = await Promise.all(runs);
    // 0.4 reserved each: two fit under 1 cent, the third is refused before it is sent.
    expect(provider.read).toHaveBeenCalledTimes(2);
    expect(summaries.filter((summary) => summary.skipped["org-daily-cost-cap"] === 1)).toHaveLength(1);
  });

  it("sends nothing when the organization ledger is missing or fails (fail closed)", async () => {
    const provider = reader(echo);
    const missing = runState();
    missing.pageReaderBudget = null;
    expect((await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(missing))).skipped).toEqual({ "budget-ledger-unavailable": 1 });
    const broken = runState();
    broken.pageReaderBudget = {
      admit: async () => { throw new Error("database down"); }, settle: async () => undefined, releaseUnused: async () => false, committedCents: async () => { throw new Error("database down"); },
    };
    expect((await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(broken))).skipped).toEqual({ "budget-ledger-unavailable": 1 });
    expect(provider.read).not.toHaveBeenCalled();
  });

  it("settles a failed job at no less than its reservation (a VM it could not report still ran)", async () => {
    const state = runState();
    const budget = state.pageReaderBudget as InMemoryPageReaderOrgBudget;
    const settle = vi.spyOn(budget, "settle");
    const provider = reader(async () => { throw new Error("lease failed while booting"); }, { estimateJobCostCents: () => 4 });
    await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state));
    expect(settle).toHaveBeenCalledWith(expect.any(String), 4);
    // A completed job settles at what it recorded, below its reservation.
    const ok = reader(echo, { estimateJobCostCents: () => 4 });
    await readPagesWithProvider(await outcomeWith([{ pageNumber: 2 }]), ok, ctx(state));
    expect(settle).toHaveBeenLastCalledWith(expect.any(String), 0.3);
  });

  it("settles a failed job with the cost it carried", async () => {
    const state = runState();
    const budget = state.pageReaderBudget as InMemoryPageReaderOrgBudget;
    const settle = vi.spyOn(budget, "settle");
    const provider = reader(async () => { throw Object.assign(new Error("vm lost"), { pageReaderUsage: [{ provider: "x", model: "x", metric: "x", amount: 1, unit: "page", costCents: 0.7 }] }); });
    await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state));
    expect(settle).toHaveBeenCalledWith(expect.any(String), 0.7);
  });

  describe("a capacity give-way", () => {
    /** A rejection like a reader at its caps: job-level reason `capacity`, optionally asserting no compute ran. */
    const capacityError = (extra: Record<string, unknown> = {}) => Object.assign(new Error("reader at its capacity"), { reason: "capacity", ...extra });

    it("releases the reservation when the reader gave way before any compute ran: no charge, the day's budget unchanged", async () => {
      const state = runState();
      const budget = state.pageReaderBudget as InMemoryPageReaderOrgBudget;
      const settle = vi.spyOn(budget, "settle");
      const release = vi.spyOn(budget, "releaseUnused");
      const provider = reader(async () => { throw capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: true }); }, { estimateJobCostCents: () => 4 });
      const outcome = await outcomeWith([{ pageNumber: 1, escalate: true }]);
      const summary = await readPagesWithProvider(outcome, provider, ctx(state, { orgDailyMaxCostCents: 10 } as never));
      expect(summary.failed).toEqual({ capacity: 1 });
      expect(release).toHaveBeenCalledWith(expect.any(String), "org-1");
      expect(settle).not.toHaveBeenCalled();
      expect(await budget.committedCents("org-1")).toBe(0);
      expect(readerEvents(state)).toHaveLength(0);
      // The page keeps the recogniser's text and stays a hosted escalation candidate.
      expect(outcome.pages[0]!.text).toBe("recogniser 1");
      expect(outcome.pages[0]!.escalation).not.toBeNull();
    });

    it("charges a capacity failure after compute started: usage carried, or no assertion that nothing ran", async () => {
      const state = runState();
      const budget = state.pageReaderBudget as InMemoryPageReaderOrgBudget;
      const settle = vi.spyOn(budget, "settle");
      const release = vi.spyOn(budget, "releaseUnused");
      const usage = [{ provider: "x", model: "x", metric: "x", amount: 1, unit: "page", costCents: 0.7 }];
      // Claims nothing ran but carries a VM's cost: conflicting, so charged at no less than the reservation.
      await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]),
        reader(async () => { throw capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: true, pageReaderUsage: usage }); }, { estimateJobCostCents: () => 4 }), ctx(state, { documentId: "doc-a" }));
      expect(settle).toHaveBeenLastCalledWith(expect.any(String), 4);
      // Partial compute, then a capacity failure (a VM that failed to start): its cost is charged in full.
      await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]),
        reader(async () => { throw capacityError({ pageReaderUsage: [{ ...usage[0]!, costCents: 6 }] }); }, { estimateJobCostCents: () => 4 }), ctx(state, { documentId: "doc-b" }));
      expect(settle).toHaveBeenLastCalledWith(expect.any(String), 6);
      // Capacity without the assertion: unclear whether compute ran, so the reservation is charged.
      await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]),
        reader(async () => { throw capacityError(); }, { estimateJobCostCents: () => 4 }), ctx(state, { documentId: "doc-c" }));
      expect(settle).toHaveBeenLastCalledWith(expect.any(String), 4);
      // The assertion on anything but a capacity give-way, or a loose truthy value, is not trusted either.
      for (const [index, error] of [
        Object.assign(new Error("vm lost"), { reason: "vm-lost", [PAGE_READER_NO_COMPUTE_PROPERTY]: true }),
        capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: "true" }),
        capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: true, ocrRefused: true }),
      ].entries()) {
        await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), reader(async () => { throw error; }, { estimateJobCostCents: () => 4 }), ctx(state, { documentId: `doc-x${index}` }));
        expect(settle).toHaveBeenLastCalledWith(expect.any(String), 4);
      }
      expect(release).not.toHaveBeenCalled();
      expect(await budget.committedCents("org-1")).toBeCloseTo(4 + 6 + 4 + 12, 4);
    });

    it("charges an aborted give-way and settles at the reservation when the ledger refuses or fails the release", async () => {
      const state = runState();
      const budget = state.pageReaderBudget as InMemoryPageReaderOrgBudget;
      const settle = vi.spyOn(budget, "settle");
      const giveWay = reader(async () => { throw capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: true }); }, { estimateJobCostCents: () => 4 });
      vi.spyOn(budget, "releaseUnused").mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("database down"));
      await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), giveWay, ctx(state, { documentId: "doc-a" }));
      expect(settle).toHaveBeenLastCalledWith(expect.any(String), 4);
      await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), giveWay, ctx(state, { documentId: "doc-b" }));
      expect(settle).toHaveBeenLastCalledWith(expect.any(String), 4);
      const abort = new AbortController();
      const aborting = reader(async () => { abort.abort(); throw capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: true }); }, { estimateJobCostCents: () => 4 });
      await expect(readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), aborting, ctx(state, { documentId: "doc-c", signal: abort.signal }))).rejects.toThrow();
      expect(settle).toHaveBeenLastCalledWith(expect.any(String), 4);
      expect(await budget.committedCents("org-1")).toBeCloseTo(12, 4);
    });

    it("sends none of the document's later batches to the reader in this run; other documents and runs still go", async () => {
      const state = runState();
      let calls = 0;
      const provider = reader(async (job) => {
        calls += 1;
        if (calls === 1) throw capacityError({ [PAGE_READER_NO_COMPUTE_PROPERTY]: true });
        return echo(job);
      }, { maxPagesPerJob: 1 });
      const first = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }, { pageNumber: 2 }, { pageNumber: 3 }]), provider, ctx(state));
      expect(provider.read).toHaveBeenCalledTimes(1);
      expect(first.failed).toEqual({ capacity: 1 });
      expect(first.skipped).toEqual({ "reader-capacity": 2 });
      // The document's next OCR batch goes straight to its fallback, without a job.
      const later = await outcomeWith([{ pageNumber: 4 }, { pageNumber: 5 }]);
      const second = await readPagesWithProvider(later, provider, ctx(state));
      expect(provider.read).toHaveBeenCalledTimes(1);
      expect(second.skipped).toEqual({ "reader-capacity": 2 });
      expect(later.pages.map((page) => page.text)).toEqual(["recogniser 4", "recogniser 5"]);
      // Pages never sent went back to the document's page budget.
      expect(pageReaderPagesRemaining(state.usageLedger, "doc-1", 100)).toBe(99);
      // Another document of the run, and the same document in another run, still use the reader.
      expect((await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state, { documentId: "doc-2" }))).replaced).toBe(1);
      expect((await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(runState({ id: "run-2" })))).replaced).toBe(1);
    });

    it("stops the document after a capacity failure even when the reader may have run compute", async () => {
      const state = runState();
      const provider = reader(async () => { throw capacityError({ pageReaderUsage: [{ provider: "x", model: "x", metric: "x", amount: 1, unit: "page", costCents: 1 }] }); }, { maxPagesPerJob: 1 });
      const summary = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }, { pageNumber: 2 }]), provider, ctx(state));
      expect(provider.read).toHaveBeenCalledTimes(1);
      expect(summary.skipped).toEqual({ "reader-capacity": 1 });
    });
  });

  it("parses the org daily provider-cost cap, refusing anything outside 0..10000000", () => {
    expect(ocrPageReaderOrgDailyMaxCostCents({})).toBe(2000);
    expect(ocrPageReaderOrgDailyMaxCostCents({ DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "0" })).toBe(0);
    expect(() => ocrPageReaderOrgDailyMaxCostCents({ DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "-1" })).toThrow();
    expect(() => ocrPageReaderOrgDailyMaxCostCents({ DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS: "20000000" })).toThrow();
  });

  it("rejects a job whose per-page token counts are implausible and clamps usage tokens to the job's pages", async () => {
    const state = runState();
    const huge = MAX_PAGE_READER_TOKENS_PER_PAGE + 1;
    const provider = reader(async (job) => ({
      results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: "# x", inputTokens: huge })),
      usage: [{ provider: "vm", model: "x", metric: "m", amount: 1, unit: "page", costCents: 0.1, inputTokens: 1e12, outputTokens: 1e12 }],
    }));
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    const summary = await readPagesWithProvider(outcome, provider, ctx(state));
    expect(summary.failed).toEqual({ "invalid-response": 1 });
    expect(outcome.pages[0]!.text).toBe("recogniser 1");
    const event = readerEvents(state)[0]!;
    expect(event.inputTokens).toBe(MAX_PAGE_READER_TOKENS_PER_PAGE);
    expect(event.outputTokens).toBe(MAX_PAGE_READER_TOKENS_PER_PAGE);
  });

  it("strips NUL and other control characters from returned Markdown", async () => {
    const provider = reader(async (job) => ({ results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: "a\u0000b\u001bc\td\ne" })), usage: [] }));
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    await readPagesWithProvider(outcome, provider, ctx(runState()));
    expect(outcome.pages[0]!.text).toBe("abc\td\ne");
  });

  it("never fails the document when the reader path itself throws; only an abort propagates", async () => {
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: reader(echo) } as never);
    const state = runState();
    vi.spyOn(state.usageLedger, "enqueue").mockImplementation(() => { throw new Error("ledger down"); });
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    const result = await readOcrPagesWithConfiguredReader(outcome, { state, documentId: "doc-1" }, { DOCSLURP_OCR_PAGE_READER: "escalation" });
    expect(result).toBeNull();
    expect(outcome.pages[0]!.text).toBe("recogniser 1");
  });

  it("propagates an abort", async () => {
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    const provider = reader(echo);
    await expect(readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(runState(), { signal: abort.signal }))).rejects.toThrow(/cancelled/);
    expect(provider.read).not.toHaveBeenCalled();
  });
});

describe("ocrDocument with the page reader", () => {
  let source: string;
  beforeEach(async () => {
    source = path.join(scratch, "scan.pdf");
    await writeFile(source, "stored bytes, never decoded here");
  });

  const hostedReader = (): HostedOcrReader & { read: ReturnType<typeof vi.fn> } => ({
    read: vi.fn(async () => ({ text: "hosted text", model: "hosted-model", inputTokens: 1, outputTokens: 1, costCents: 0 })),
  });

  it("is off by default: no frames kept for it and no reader call", async () => {
    const provider = reader(echo);
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: provider });
    const { runner, jobs } = fakeOcrRunner((job) => job.pages!.map((frame) => ({ frame, text: "low", meanConfidence: 0.3, image: true })));
    const result = await ocrDocument({ runner, state: runState(), documentId: "doc-1", source, kind: "pdf", pages: [1], stage: "s",
      env: { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch } });
    expect(jobs[0]!.escalation).toBeNull();
    expect(provider.read).not.toHaveBeenCalled();
    expect(result.pageReader).toBeUndefined();
  });

  it("escalation mode reads the candidates first; the hosted reader only gets what it did not replace", async () => {
    const provider = reader(async (job) => ({
      // Reads the first page sent, fails the second.
      results: [{ key: job.pages[0]!.key, status: "read", markdown: "reader text" }, { key: job.pages[1]!.key, status: "failed", reason: "capacity" }],
      usage: [],
    }));
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: provider });
    const { runner, jobs } = fakeOcrRunner(() => [
      { frame: 1, text: "low one", meanConfidence: 0.3, image: true },
      { frame: 2, text: "low two", meanConfidence: 0.3, image: true },
      { frame: 3, text: "good", meanConfidence: 0.99 },
    ]);
    const hosted = hostedReader();
    const result = await ocrDocument({ runner, state: runState(), documentId: "doc-1", source, kind: "pdf", pages: [1, 2, 3], stage: "s", hostedReader: hosted,
      env: { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch, DOCSLURP_OCR_PAGE_READER: "escalation", DOCSLURP_OCR_ESCALATION: "on" } });
    expect(jobs[0]!.escalation).toEqual({ belowConfidence: 0.8, recognisers: ["arabic", "devanagari"] });
    expect(result.pages.map((page) => [page.pageNumber, page.text, page.reader])).toEqual([
      [1, "reader text", "page-reader:test-page-reader"],
      [2, "hosted text", "escalated:hosted-model"],
      [3, "good", "multi"],
    ]);
    expect(hosted.read).toHaveBeenCalledTimes(1);
    expect(hosted.read.mock.calls[0]![0]).toMatchObject({ pageNumber: 2 });
    expect(result.pageReader).toMatchObject({ mode: "escalation", attempted: 2, replaced: 1, failed: { capacity: 1 } });
  });

  it("still rebuilds tables of pages the reader replaced when a later step in the reader path throws", async () => {
    const provider = reader(async (job) => ({ results: job.pages.map((page) => ({ key: page.key, status: "read" as const, markdown: "<table><tr><td>a</td></tr></table>" })), usage: [] }));
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: provider });
    const { runner } = fakeOcrRunner(() => [{ frame: 1, text: "low", meanConfidence: 0.3, image: true }]);
    const state = runState();
    // The reader's own charge (made after its text is applied) throws; the recogniser's charges go through.
    const original = state.usageLedger.chargeOcrPage.bind(state.usageLedger);
    vi.spyOn(state.usageLedger, "chargeOcrPage").mockImplementation((charge) => {
      if (charge.readBy === "ocr-page-reader") throw new Error("ledger down");
      return original(charge);
    });
    const tables = await import("../../pipeline/vision-tables-vm.js");
    const sanitize = vi.spyOn(tables, "sanitizeVisionPageTables");
    const result = await ocrDocument({ runner, state, documentId: "doc-1", source, kind: "pdf", pages: [1], stage: "s",
      env: { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch, DOCSLURP_OCR_PAGE_READER: "escalation" } });
    expect(result.pageReader).toBeUndefined();
    expect(result.pages[0]!.reader).toBe("page-reader:test-page-reader");
    expect(sanitize).toHaveBeenCalledTimes(1);
  });

  it("keeps candidate frames for the reader even when hosted escalation is off, and never calls the hosted reader", async () => {
    const provider = reader(echo);
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: provider });
    const { runner, jobs } = fakeOcrRunner(() => [{ frame: 1, text: "low", meanConfidence: 0.3, image: true }]);
    const hosted = hostedReader();
    const result = await ocrDocument({ runner, state: runState(), documentId: "doc-1", source, kind: "pdf", pages: [1], stage: "s", hostedReader: hosted,
      env: { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch, DOCSLURP_OCR_PAGE_READER: "escalation" } });
    expect(jobs[0]!.escalation).not.toBeNull();
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(hosted.read).not.toHaveBeenCalled();
    expect(result.pages[0]).toMatchObject({ text: "# Read frame-0001.png", reader: "page-reader:test-page-reader" });
    expect(result.escalation).toBeNull();
  });

  it("all mode asks the boundary for a PNG of every frame and reads every page", async () => {
    const provider = reader(echo);
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "test-reader-plugin", pageImageReader: provider });
    const { runner, jobs } = fakeOcrRunner((job) => job.pages!.map((frame) => ({ frame, text: `good ${frame}`, meanConfidence: 0.99, image: true })));
    const hosted = hostedReader();
    const result = await ocrDocument({ runner, state: runState(), documentId: "doc-1", source, kind: "pdf", pages: [1, 2], stage: "s", hostedReader: hosted,
      env: { DOCSLURP_OCR_MODE: "vm", DOCSLURP_OCR_SCRATCH_DIR: scratch, DOCSLURP_OCR_PAGE_READER: "all", DOCSLURP_OCR_ESCALATION: "on" } });
    expect(jobs[0]!.escalation!.belowConfidence).toBe(1);
    expect(jobs[0]!.escalation!.recognisers).toEqual(expect.arrayContaining([...jobs[0]!.recognisers, "arabic", "devanagari"]));
    expect((provider.read.mock.calls[0]![0] as PageImageReadJob).pages).toHaveLength(2);
    expect(result.pages.map((page) => page.reader)).toEqual(["page-reader:test-page-reader", "page-reader:test-page-reader"]);
    // Confident pages were never hosted escalation candidates.
    expect(hosted.read).not.toHaveBeenCalled();
  });
});

describe("privacy mode (design Q14): only a registered private reader reads restricted projects", () => {
  const privateEndpoint = {
    alias: "reader1",
    baseUrl: "https://reader1.example.com/v1",
    auth: { tokenEnv: "TEST_PRIVATE_READER1_TOKEN" },
    models: [{ id: "example/page-reader", capability: "vision" }],
    attestation: { tenancy: "single-tenant", hostProvider: "example", region: "us-east", note: "test" },
    pricing: { usdPerHour: 1 },
  };
  const registered = { modelUri: "llm://private/reader1/example/page-reader", capability: "vision" as const };
  afterEach(() => setPrivateModelEndpointRegistryForTests(undefined));

  it("the helper fails closed for restricted modes and passes standard", () => {
    setPrivateModelEndpointRegistryForTests([privateEndpoint]);
    const plain = reader(echo);
    expect(pageReaderAllowedForPrivacy(plain, "standard")).toBe(true);
    expect(pageReaderAllowedForPrivacy(plain, undefined)).toBe(true);
    for (const mode of ["local-only", "strict-privacy", "unknown"]) {
      expect(pageReaderAllowedForPrivacy(plain, mode)).toBe(false);
      expect(pageReaderAllowedForPrivacy(reader(echo, { privateRoute: { modelUri: "llm://private/other/example/page-reader", capability: "vision" } }), mode)).toBe(false);
      expect(pageReaderAllowedForPrivacy(reader(echo, { privateRoute: { modelUri: "https://reader1.example.com/v1", capability: "vision" } }), mode)).toBe(false);
      expect(pageReaderAllowedForPrivacy(reader(echo, { privateRoute: { ...registered, capability: "text" } }), mode)).toBe(false);
      expect(pageReaderAllowedForPrivacy(reader(echo, { privateRoute: registered }), mode === "unknown" ? "local-only" : mode)).toBe(true);
    }
    setPrivateModelEndpointRegistryForTests([]);
    expect(pageReaderAllowedForPrivacy(reader(echo, { privateRoute: registered }), "strict-privacy")).toBe(false);
  });

  it.each(["local-only", "strict-privacy"])("%s: an undeclared reader is sent no pages and the recogniser text stands", async (privacyMode) => {
    const provider = reader(echo);
    const state = runState({ pipeline: { privacyMode } });
    const outcome = await outcomeWith([{ pageNumber: 1, escalate: true }, { pageNumber: 2, escalate: true }]);
    const summary = await readPagesWithProvider(outcome, provider, ctx(state, { mode: "all" }));
    expect(provider.read).not.toHaveBeenCalled();
    expect(summary.skipped.privacy).toBe(2);
    expect(outcome.pages.map((page) => page.text)).toEqual(["recogniser 1", "recogniser 2"]);
    expect(outcome.pages.every((page) => page.escalation)).toBe(true);
    expect(readerEvents(state)).toEqual([]);
  });

  it("a run without a known pipeline is treated as restricted", async () => {
    const provider = reader(echo);
    const state = runState();
    (state.run as { pipeline?: unknown }).pipeline = undefined;
    const summary = await readPagesWithProvider(await outcomeWith([{ pageNumber: 1 }]), provider, ctx(state, { mode: "all" }));
    expect(provider.read).not.toHaveBeenCalled();
    expect(summary.skipped.privacy).toBe(1);
  });

  it("the configured OCR entry point refuses before any warm gate or VM start", async () => {
    const warmStart = vi.fn();
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "privacy-reader", pageImageReader: reader(echo, { warm: { start: warmStart, status: vi.fn(() => "cold") } as never }) });
    const state = runState({ pipeline: { privacyMode: "strict-privacy" } });
    const result = await readOcrPagesWithConfiguredReader(await outcomeWith([{ pageNumber: 1, escalate: true }]), { state, documentId: "doc-1" }, { DOCSLURP_OCR_PAGE_READER: "all" });
    expect(result).toBeNull();
    expect(warmStart).not.toHaveBeenCalled();
  });

  it("a registered private reader reads restricted projects", async () => {
    setPrivateModelEndpointRegistryForTests([privateEndpoint]);
    const provider = reader(echo, { privateRoute: registered });
    const state = runState({ pipeline: { privacyMode: "local-only" } });
    const outcome = await outcomeWith([{ pageNumber: 1 }]);
    const summary = await readPagesWithProvider(outcome, provider, ctx(state, { mode: "all" }));
    expect(provider.read).toHaveBeenCalledTimes(1);
    expect(summary.replaced).toBe(1);
  });
});
