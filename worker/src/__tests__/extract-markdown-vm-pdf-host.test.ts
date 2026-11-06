import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, normalizeStoredPipelineFeatures } from "@docslurp/shared";

import { acceptSandboxedPdfResult, type SandboxedPdfJob } from "../extractors/plugins.js";
import { VISION_ROUTING_VERSION_SLOT } from "../lib/vision-routing-v2.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";

/**
 * A PDF routed to the sandboxed provider is never parsed on the worker host: the stage's real control flow (page facts,
 * extraction, page-image evidence, the OCR ledger) runs against a runner spy that records every method call and every
 * command it is asked to run. Only the provider's job may run; no host `pdf*` tool may even be planned.
 */
function run(documentExtraction: Record<string, unknown> = {}): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 3, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, visionFallback: true,
      documentExtraction: { ...defaultPipelineFeatures.documentExtraction, ...documentExtraction } },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
}

async function harness(providerResult: { ocrPages?: unknown; layoutFacts?: unknown; markdown: string }, documentExtraction: Record<string, unknown> = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-vm-pdf-host-test-"));
  const calls: string[] = [];
  const commands: CommandPlan[] = [];
  const json = new Map<string, unknown>();
  const plan = (binary: string): CommandPlan => ({ binary, args: [], available: true });
  const target: Record<string, unknown> = {
    sandboxedPdfMarkdown: async (input: string, output: string) =>
      ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }),
    run: async (command: CommandPlan) => {
      commands.push(command);
      if (!command.sandboxedPdf) throw new Error(`host command refused in test: ${command.binary}`);
      // What the runner does for a provider job: the provider writes Markdown, the host validates its result.
      await writeFile(command.sandboxedPdf.output, providerResult.markdown);
      acceptSandboxedPdfResult(command.sandboxedPdf as SandboxedPdfJob,
        { exitCode: 0, stdout: "", stderr: "", ...(providerResult.ocrPages !== undefined ? { ocrPages: providerResult.ocrPages as number[] } : {}),
          ...(providerResult.layoutFacts !== undefined ? { layoutFacts: providerResult.layoutFacts } : {}) }, 3);
      return { stdout: "", stderr: "" };
    },
  };
  // Every other runner method (pageText, pdfImagesList, extractText, ...) is a host tool: record it, plan a refusal.
  const runner = new Proxy(target, {
    get(object, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined;
      calls.push(key);
      return object[key] ?? (async () => plan(`host:${key}`));
    },
  }) as unknown as CommandRunner;
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async () => undefined,
    putJson: async (key: string, value: unknown) => { json.set(key, value); },
    streamText: async () => undefined,
    createMultipartUploadStream: () => ({ writable: new Writable({ write(_chunk, _encoding, done) { done(); } }), done: Promise.resolve() }),
  };
  const stage = new ExtractMarkdownStage(runner, storage as never, {} as never);
  const internals = stage as any;
  const sourcePath = path.join(scratch, "scan.pdf");
  await writeFile(sourcePath, "%PDF-1.7 bytes");
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  const document = {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "scan.pdf", mimeType: "application/pdf", sourceKey: "raw/scan",
    status: "processing", extractionMode: "hybrid", pageCount: 3, createdAt: new Date(), updatedAt: new Date(),
  } as Document;
  const state = WorkflowState.create(run(documentExtraction), [document]);
  state.usageLedger.runId = "run-1";
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", "pdf");
  const upsertPageFacts = vi.fn(async () => undefined);
  // A store that accepts every write, so page facts would be recorded if the stage probed for them.
  (state as { store?: unknown }).store = new Proxy({ upsertPageFacts, getCompletedPages: async () => new Set<number>() } as Record<string, unknown>, {
    get: (object, key) => (typeof key !== "string" || key === "then" ? undefined : object[key] ?? (async () => undefined)),
  });
  const richIds = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich").map((event) => event.id);
  const hostPdf = () => [
    ...calls.filter((name) => /^pdf|pageText|extractText|ocrPdf|images|info|render|rasteri[sz]e/i.test(name)),
    ...commands.filter((command) => !command.sandboxedPdf).map((command) => command.binary),
  ];
  return { stage, state, calls, commands, json, hostPdf, richIds, upsertPageFacts, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

describe("the sandboxed PDF route on the worker host", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("starts no host pdf* command, skips host page facts and image evidence, and bills the provider's OCR pages", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("WORKER_PAGE_FACTS", "true");
    const h = await harness({ markdown: "Born digital\fScanned page read by OCR\f\f", ocrPages: [2] });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).toBe("completed");
      expect(h.commands.map((command) => command.binary)).toEqual(["test-vm"]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.upsertPageFacts).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2"]);
      expect(checkpoint?.stats).toMatchObject({ extractor: "vm-pdf", hostPdfProbes: "skipped-sandboxed-route", ocrReadPages: 1, ocrReadSource: "extractor-reported" });
    } finally { await h.cleanup(); }
  });

  it.each([
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf", { order: { pdf: ["poppler-text"] } }],
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf", { order: { pdf: ["native-pdf"] } }],
    ["DOCSLURP_VM_PDF_INSTALLED", "1", { order: { pdf: ["poppler-text", "native-pdf"] } }],
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf", { enrich: ["poppler-text"] }],
  ])("under %s=%s refuses a run whose workspace override names a host parser (%j), without touching the host", async (name, value, override) => {
    vi.stubEnv(name, value);
    vi.stubEnv("WORKER_PAGE_FACTS", "true");
    const h = await harness({ markdown: "text\f\f\f" }, override);
    try {
      await h.stage.run(h.state).catch(() => undefined);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).not.toBe("completed");
      expect(JSON.stringify(checkpoint ?? {})).toMatch(/refused for pdf/);
      expect(h.commands).toEqual([]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.upsertPageFacts).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });

  it.each([
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf"],
    ["DOCSLURP_VM_PDF_INSTALLED", "1"],
  ])("under %s=%s runs a stored config emptied of host parsers in vm-pdf alone, never a default host parser", async (name, value) => {
    vi.stubEnv(name, value);
    vi.stubEnv("WORKER_PAGE_FACTS", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // What the worker's store hands the stage for a run whose stored pipeline named only host parsers.
    const stored = { ...defaultPipelineFeatures, documentExtraction: { ...defaultPipelineFeatures.documentExtraction,
      order: { pdf: ["poppler-text", "native-pdf"] }, pages: ["ocr"], enrich: ["poppler-text"], voting: { enabled: true, secondary: "poppler-text" } } };
    const extraction = normalizeStoredPipelineFeatures(stored as never, "run run-1").documentExtraction;
    const h = await harness({ markdown: "Text\f\f\f" }, extraction as never);
    try {
      await h.stage.run(h.state);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).toBe("completed");
      expect(checkpoint?.stats).toMatchObject({ extractor: "vm-pdf" });
      expect(h.commands.map((command) => command.binary)).toEqual(["test-vm"]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.upsertPageFacts).not.toHaveBeenCalled();
    } finally { await h.cleanup(); vi.restoreAllMocks(); }
  });

  it("bills nothing when the provider does not report OCR pages, still without probing the host", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    const h = await harness({ markdown: "\fScanned words\f\f" });
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      expect(h.hostPdf()).toEqual([]);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("stores the VM's layout facts for routing without probing the host; drops pages outside the document", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    const scan = { bbox: [72, 200, 540, 600], coverage: 0.4, widthPx: 1700, heightPx: 1450, bitsPerComponent: 1, colorSpace: "gray",
      encoding: "ccitt", ppi: [260, 260], bytesPerPixel: null, repeated: false, wordsInside: 0 };
    const layoutFacts = { version: "pdf-layout-facts@1", pages: [
      { pageNumber: 2, known: true, words: 90, images: [scan], tables: [], grids: [], tableCoverage: 0 },
      { pageNumber: 9, known: true, words: 90, images: [scan] },
    ] };
    const h = await harness({ markdown: "OneTwo with a scan beside itThree", layoutFacts });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      expect(h.hostPdf()).toEqual([]);
      const uri = h.state.artifactLedger.readDocument("doc-1", "page-layout-facts");
      expect(uri).toMatch(/page-layout-facts\/doc-1\.json$/);
      const stored = [...h.json.entries()].find(([key]) => key.includes("page-layout-facts/"))![1] as { source: string; pages: Array<{ pageNumber: number }> };
      expect(stored.source).toBe("vm-pdf");
      expect(stored.pages.map((page) => page.pageNumber)).toEqual([2]);
    } finally { await h.cleanup(); }
  });

  it("ignores malformed VM layout facts: no artifact, the run completes", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const layoutFacts of [{ version: "pdf-layout-facts@9", pages: [] }, "garbage", { version: "pdf-layout-facts@1", pages: [{ pageNumber: 99, known: true }] }]) {
      const h = await harness({ markdown: "OneTwoThree", layoutFacts });
      h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        expect(h.state.artifactLedger.readDocument("doc-1", "page-layout-facts")).toBeUndefined();
      } finally { await h.cleanup(); }
    }
    vi.restoreAllMocks();
  });

  it("refuses a provider result whose ocrPages fall outside the page count or repeat", () => {
    const job = { input: "/a", output: "/b" };
    for (const ocrPages of [[0], [4], [1, 1], [1.5], ["1"], "1"]) {
      expect(() => acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", ocrPages: ocrPages as number[] }, 3)).toThrow("invalid ocrPages");
    }
    expect(acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", ocrPages: [3, 1] }, 3).ocrPages).toEqual([1, 3]);
  });
});
