import { afterEach, describe, expect, it } from "vitest";
import {
  acceptSandboxedPdfResult, registerExtractorPlugin, resetExtractorPluginsForTest, EXTRACTOR_PLUGIN_API_VERSION, type SandboxedPdfExtractorProvider,
} from "../extractors/plugins.js";
import {
  acceptSandboxedPdfBatchEvent, assertSingleScopeBatch, batchFileJob, batchUsageOf, sandboxedPdfBatchProvider, unfinishedBatchFiles,
  type SandboxedPdfBatchJob,
} from "../extractors/sandboxed-pdf-batch.js";
import { pageFactsForResend, sandboxedPdfPageFacts } from "../extractors/sandboxed-pdf-page-facts.js";
import { docLine, jsonl, runLine, textPage } from "../test/doppler-page-facts-fixture.js";

function job(files = 3, figures = false): SandboxedPdfBatchJob {
  return {
    scope: { orgId: "org-a", runId: "run-1" },
    options: { math: false, figures },
    files: Array.from({ length: files }, (_, index) => ({
      index, documentId: `doc-${index}`, input: `/w/in/${index}.pdf`, output: `/w/out/${index}.md`, bytes: 100, estimatedPages: 2,
      ...(figures ? { figures: { dir: `/w/fig/${index}` } } : {}),
    })),
  };
}

const owners = (entries: Array<[string, string, string]>) => new Map(entries.map(([id, orgId, runId]) => [id, { orgId, runId }]));
const text = (index: number, pages = 2, extra: Record<string, unknown> = {}) =>
  ({ index, phase: "text", pages, result: { exitCode: 0, stdout: "", stderr: "", ...extra } });

function provider(batch?: unknown): SandboxedPdfExtractorProvider {
  return {
    id: "fake-vm", maxSourceBytes: 1 << 20, assertConfigured() {}, timeoutMs: () => 1000,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    ...(batch ? { batch: batch as SandboxedPdfExtractorProvider["batch"] } : {}),
  };
}

afterEach(() => resetExtractorPluginsForTest());

describe("assertSingleScopeBatch", () => {
  it("accepts a batch whose documents all belong to the job's run and organization", () => {
    expect(() => assertSingleScopeBatch(job(), owners([["doc-0", "org-a", "run-1"], ["doc-1", "org-a", "run-1"], ["doc-2", "org-a", "run-1"]]))).not.toThrow();
  });

  it("refuses a batch with a document of another organization (cross-tenant)", () => {
    expect(() => assertSingleScopeBatch(job(), owners([["doc-0", "org-a", "run-1"], ["doc-1", "org-b", "run-1"], ["doc-2", "org-a", "run-1"]])))
      .toThrow("Batch mixes organizations or runs");
  });

  it("refuses a batch with a document of another run of the same organization", () => {
    expect(() => assertSingleScopeBatch(job(), owners([["doc-0", "org-a", "run-1"], ["doc-1", "org-a", "run-2"], ["doc-2", "org-a", "run-1"]])))
      .toThrow("Batch mixes organizations or runs");
  });

  it("refuses a document the database does not know, or with no organization", () => {
    expect(() => assertSingleScopeBatch(job(2), owners([["doc-0", "org-a", "run-1"]]))).toThrow("Batch mixes organizations or runs");
    const nullOrg = new Map([["doc-0", { orgId: null, runId: "run-1" }], ["doc-1", { orgId: "org-a", runId: "run-1" }]]);
    expect(() => assertSingleScopeBatch(job(2), nullOrg)).toThrow("Batch mixes organizations or runs");
  });

  it("refuses duplicate documents, shared paths, out-of-order indexes and an empty batch", () => {
    const all = owners([["doc-0", "org-a", "run-1"], ["doc-1", "org-a", "run-1"]]);
    const dup = job(2); dup.files[1]!.documentId = "doc-0";
    expect(() => assertSingleScopeBatch(dup, all)).toThrow("twice");
    const shared = job(2); shared.files[1]!.output = shared.files[0]!.output;
    expect(() => assertSingleScopeBatch(shared, all)).toThrow("distinct");
    const order = job(2); order.files[1]!.index = 5;
    expect(() => assertSingleScopeBatch(order, all)).toThrow("indexes");
    expect(() => assertSingleScopeBatch({ ...job(0) }, all)).toThrow("no files");
  });
});

describe("acceptSandboxedPdfBatchEvent", () => {
  it("keeps the structural count and the processed slots apart (council #340 L2)", () => {
    expect(acceptSandboxedPdfBatchEvent(job(), { ...text(0, 3), processedPages: 2 })).toMatchObject({ pages: 3, processedPages: 2 });
    expect(acceptSandboxedPdfBatchEvent(job(), text(0, 3))).not.toHaveProperty("processedPages");
    for (const bad of [0, 3, 4, 1.5, "2"]) expect(() => acceptSandboxedPdfBatchEvent(job(), { ...text(0, 3), processedPages: bad })).toThrow("processed pages");
  });

  it("accepts text events in any order and records the per-file job", () => {
    const j = job();
    expect(acceptSandboxedPdfBatchEvent(j, text(2)).phase).toBe("text");
    expect(acceptSandboxedPdfBatchEvent(j, text(0, 5))).toMatchObject({ index: 0, pages: 5 });
    expect(batchFileJob(j, 0)?.output).toBe("/w/out/0.md");
    expect(unfinishedBatchFiles(j).map((f) => f.index)).toEqual([1]);
  });

  it("refuses an index outside the files", () => {
    expect(() => acceptSandboxedPdfBatchEvent(job(), text(3))).toThrow("unknown file index");
    expect(() => acceptSandboxedPdfBatchEvent(job(), text(-1))).toThrow("unknown file index");
    expect(() => acceptSandboxedPdfBatchEvent(job(), { ...text(0), index: "0" })).toThrow("unknown file index");
  });

  it("refuses a second text result for one file", () => {
    const j = job();
    acceptSandboxedPdfBatchEvent(j, text(1));
    expect(() => acceptSandboxedPdfBatchEvent(j, text(1))).toThrow();
  });

  it("refuses page counts below 1 or above 100000", () => {
    expect(() => acceptSandboxedPdfBatchEvent(job(), text(0, 0))).toThrow("page count");
    expect(() => acceptSandboxedPdfBatchEvent(job(), text(0, 100_001))).toThrow("page count");
    expect(() => acceptSandboxedPdfBatchEvent(job(), text(0, 1.5))).toThrow("page count");
  });

  it("refuses figures before text, unrequested figures, and figures riding on a text result", () => {
    const j = job(2, true);
    expect(() => acceptSandboxedPdfBatchEvent(j, { index: 0, phase: "figures", figures: { status: "extracted" } })).toThrow("figures before text");
    expect(() => acceptSandboxedPdfBatchEvent(job(2, false), { index: 0, phase: "figures", figures: { status: "extracted" } })).toThrow("not requested");
    expect(() => acceptSandboxedPdfBatchEvent(j, text(1, 2, { figures: { status: "extracted" } }))).toThrow("figures on a text result");
  });

  it("accepts figures after text exactly once and bounds the reason", () => {
    const j = job(2, true);
    acceptSandboxedPdfBatchEvent(j, text(0));
    const e = acceptSandboxedPdfBatchEvent(j, { index: 0, phase: "figures", figures: { status: "failed", reason: "x\u0000".repeat(500) } });
    expect(e).toMatchObject({ phase: "figures", figures: { status: "failed" } });
    expect((e as { figures: { reason: string } }).figures.reason.length).toBeLessThanOrEqual(200);
    expect(() => acceptSandboxedPdfBatchEvent(j, { index: 0, phase: "figures", figures: { status: "extracted" } })).toThrow("finished");
  });

  it("runs the single-file acceptance on the text result (ocrPages validated)", () => {
    expect(() => acceptSandboxedPdfBatchEvent(job(), text(0, 2, { ocrPages: [3] }))).toThrow("invalid ocrPages");
    expect(acceptSandboxedPdfBatchEvent(job(), text(0, 2, { ocrPages: [2, 1] }))).toMatchObject({ result: { ocrPages: [1, 2] } });
  });

  it("accepts a file's page facts bounded by its processed slots, and strips them from the result", () => {
    const j = job();
    const pageFacts = jsonl([docLine(), textPage(1), textPage(2), textPage(3), runLine()]);
    const event = acceptSandboxedPdfBatchEvent(j, { ...text(0, 3, { pageFacts }), processedPages: 2 });
    expect(event).toMatchObject({ phase: "text", pages: 3, processedPages: 2 });
    expect((event as { result: { pageFacts?: unknown } }).result.pageFacts).toBeUndefined();
    expect([...sandboxedPdfPageFacts(batchFileJob(j, 0)!)!.pages.keys()]).toEqual([1, 2]);
    // Malformed facts on another file: no facts, the text result still stands.
    expect(acceptSandboxedPdfBatchEvent(j, text(1, 2, { pageFacts: "garbage" })).phase).toBe("text");
    expect(sandboxedPdfPageFacts(batchFileJob(j, 1)!)).toBeUndefined();
  });

  it("hands facts on only as validated canonical lines, never the guest's raw bytes (council #358 A2, B-L3)", () => {
    const j = job();
    acceptSandboxedPdfBatchEvent(j, text(0, 1, { pageFacts: jsonl([docLine({ title: "secret" }), textPage(1, { note: "secret" }), runLine()]) }));
    const resent = pageFactsForResend(batchFileJob(j, 0)!)!;
    expect(resent).not.toMatch(/secret|PRODUCER-MARKER|producer/);
    expect(resent.split("\n").filter(Boolean)).toHaveLength(3);
    // Refused facts are not handed on at all.
    acceptSandboxedPdfBatchEvent(j, text(1, 1, { pageFacts: "garbage\n" }));
    expect(pageFactsForResend(batchFileJob(j, 1)!)).toBeUndefined();
  });

  it("records no page facts for a result refused over its ocrPages (council #358 recheck N1)", () => {
    const single = { input: "/a", output: "/b" };
    expect(() => acceptSandboxedPdfResult(single, { exitCode: 0, stdout: "", stderr: "", ocrPages: [9], pageFacts: jsonl([docLine(), textPage(1)]) }, 3)).toThrow("invalid ocrPages");
    expect(sandboxedPdfPageFacts(single)).toBeUndefined();
  });

  it("drops facts when the host has no page count of its own (council #358 A4)", () => {
    const single = { input: "/a", output: "/b" };
    for (const pages of [0, Number.NaN, -1]) {
      acceptSandboxedPdfResult(single, { exitCode: 0, stdout: "", stderr: "", pageFacts: jsonl([docLine(), textPage(1)]) }, pages);
      expect(sandboxedPdfPageFacts(single)).toBeUndefined();
    }
  });

  it("forgets a job's earlier page facts when a later result for it is refused (council #358 L4)", () => {
    const single = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(single, { exitCode: 0, stdout: "", stderr: "", pageFacts: jsonl([docLine(), textPage(1)]) }, 3);
    expect(sandboxedPdfPageFacts(single)).toBeDefined();
    expect(() => acceptSandboxedPdfResult(single, { exitCode: 0, stdout: "", stderr: "", figures: { status: "extracted" } }, 3)).toThrow("unrequested figures");
    expect(sandboxedPdfPageFacts(single)).toBeUndefined();
  });

  it("accepts a fixed failure slug only, and nothing after a failure", () => {
    const j = job();
    expect(acceptSandboxedPdfBatchEvent(j, { index: 0, phase: "failed", reason: "page-count", pageCountOutcome: "encrypted" }))
      .toEqual({ index: 0, phase: "failed", reason: "page-count", pageCountOutcome: "encrypted" });
    expect(() => acceptSandboxedPdfBatchEvent(j, text(0))).toThrow("finished");
    expect(() => acceptSandboxedPdfBatchEvent(j, { index: 1, phase: "failed", reason: "secret text from the PDF" })).toThrow("unknown failure reason");
    const noisy = acceptSandboxedPdfBatchEvent(j, { index: 2, phase: "failed", reason: "parser", pageCountOutcome: "Document says hello" });
    expect(noisy).not.toHaveProperty("pageCountOutcome");
  });

  it("refuses an unknown phase", () => {
    expect(() => acceptSandboxedPdfBatchEvent(job(), { index: 0, phase: "end" })).toThrow("unknown phase");
  });
});

describe("batch provider registration", () => {
  it("is absent when the provider declares none", () => {
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "fake", sandboxedPdf: provider() });
    expect(sandboxedPdfBatchProvider()).toBeNull();
  });

  it("registers a batch with run() and positive limits", () => {
    const batch = { maxFiles: 4, maxBatchBytes: 1000, maxBatchPages: 50, run: async () => ({ usage: [] }) };
    registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "fake", sandboxedPdf: provider(batch) });
    expect(sandboxedPdfBatchProvider()).toBe(batch);
  });

  it("refuses a batch without run() or with a zero limit", () => {
    expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "fake", sandboxedPdf: provider({ maxFiles: 4, maxBatchBytes: 1, maxBatchPages: 1 }) }))
      .toThrow("batch needs run()");
    expect(() => registerExtractorPlugin({ apiVersion: EXTRACTOR_PLUGIN_API_VERSION, name: "fake", sandboxedPdf: provider({ maxFiles: 0, maxBatchBytes: 1, maxBatchPages: 1, run: async () => ({ usage: [] }) }) }))
      .toThrow("batch needs run()");
  });
});

describe("batchUsageOf (council #340 C5)", () => {
  const vm = { provider: "modal", model: "m", metric: "sandbox_compute", amount: 1, unit: "cent", costCents: 1 };
  it("reads every VM usage event a rejection carries, or a SandboxRunError's single one", () => {
    expect(batchUsageOf(Object.assign(new Error("x"), { batchUsage: [vm, vm, { bogus: true }] }))).toEqual([vm, vm]);
    expect(batchUsageOf(Object.assign(new Error("x"), { usage: vm }))).toEqual([vm]);
    expect(batchUsageOf(new Error("x"))).toEqual([]);
    expect(batchUsageOf("x")).toEqual([]);
    expect(batchUsageOf(null)).toEqual([]);
  });
});
