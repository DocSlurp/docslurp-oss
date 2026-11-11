import { afterEach, describe, expect, it } from "vitest";
import {
  registerExtractorPlugin, resetExtractorPluginsForTest, EXTRACTOR_PLUGIN_API_VERSION, type SandboxedPdfExtractorProvider,
} from "../extractors/plugins.js";
import {
  acceptSandboxedPdfBatchEvent, assertSingleScopeBatch, batchFileJob, sandboxedPdfBatchProvider, unfinishedBatchFiles,
  type SandboxedPdfBatchJob,
} from "../extractors/sandboxed-pdf-batch.js";

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
