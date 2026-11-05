import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { SandboxedOcrJob } from "../extractors/plugins.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import { fakeOcrRunner, type FakeFrame } from "../test/fake-ocr.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * A page bills Rich only when a vision or OCR model read it (db/page-base-fee.ts). The OCR engine charges every page it read
 * with words as `page-ocr`, once per run, document and page; extractors that report their own OCR pages (graph-local, the
 * sandboxed PDF provider) are billed from that report; Dolphin and liteparse --ocr are inferred from an empty native layer.
 * Kreuzberg never OCRs, and Fast never reads a page.
 */
function run(pipeline: Record<string, unknown> = {}): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 3, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, ...pipeline },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
}

async function harness(args: {
  format: "image" | "pdf";
  pageCount?: number;
  pipeline?: Record<string, unknown>;
  /** The text-layer extractor's text (PDFs). */
  text?: string;
  nativePages?: string[] | null;
  frames?: (job: SandboxedOcrJob) => FakeFrame[];
}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-ledger-test-"));
  const objects = new Map<string, Buffer>();
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async () => undefined,
    streamText: async (key: string, text: string) => { objects.set(key, Buffer.from(text)); },
    createMultipartUploadStream: (key: string) => {
      const chunks: Buffer[] = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      return {
        writable: new Writable({
          write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
          final(callback) { objects.set(key, Buffer.concat(chunks)); resolveDone(); callback(); },
        }),
        done,
      };
    },
  };
  const ocr = fakeOcrRunner(args.frames ?? ((job) => (job.pages ?? [1]).map((frame) => ({ frame, text: `OCR words ${frame}` }))));
  const runner = {
    ...ocr.runner,
    kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true }),
    extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
    pageText: async () => ({ binary: "pdftotext", args: [], available: false }),
  } as unknown as CommandRunner & typeof ocr.runner;
  const stage = new ExtractMarkdownStage(runner, storage as never, {} as never);
  const internals = stage as any;
  const sourcePath = path.join(scratch, args.format === "image" ? "scan.png" : "scan.pdf");
  await writeFile(sourcePath, "bytes");
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.buildParserArtifacts = async () => [];
  internals.recordPageImageEvidence = async () => null;
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  // The native text layer page facts probed (null: the probe did not run).
  internals.textLayerPages = async () => args.nativePages ?? null;
  const realExtractCandidate = internals.extractCandidate.bind(stage);
  internals.extractCandidate = async (extractor: { label: string; plan: unknown }, textKey: string, ...rest: unknown[]) => {
    if (extractor.label === "ocr" || extractor.label === "image-textless") return await realExtractCandidate(extractor, textKey, ...rest);
    const tempTextPath = path.join(scratch, `${extractor.label}.md`);
    await writeFile(tempTextPath, args.text ?? "");
    return { label: extractor.label, plan: extractor.plan, textKey, textUri: `s3://test/${textKey}`, tempTextPath };
  };
  const document = {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: args.format === "image" ? "scan.png" : "scan.pdf",
    mimeType: args.format === "image" ? "image/png" : "application/pdf", sourceKey: "raw/scan", status: "processing",
    extractionMode: "hybrid", pageCount: args.pageCount ?? 1, createdAt: new Date(), updatedAt: new Date(),
  } as Document;
  const state = WorkflowState.create(run(args.pipeline), [document]);
  state.usageLedger.runId = "run-1";
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", args.format);
  const richEvents = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich");
  const record = (candidate: Record<string, unknown>, winningText: string, extra: Record<string, unknown> = {}) =>
    internals.recordOcrPageReads(state, state.documents[0], { format: args.format, isPdf: args.format === "pdf", winningText, candidate, sourcePath: "unused", ...extra });
  return {
    stage, state, runner, jobs: ocr.jobs, richEvents, record,
    richIds: () => richEvents().map((event) => event.id),
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
  vi.stubEnv("DOCSLURP_OCR_ESCALATION", "off");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OCR reads on the usage ledger", () => {
  it("bills the OCR engine's read of an uploaded image once as page-ocr, with or without words", async () => {
    const read = await harness({ format: "image", frames: () => [{ frame: 1, text: "Invoice total 4200" }] });
    try {
      await read.stage.run(read.state);
      expect(read.richIds()).toEqual(["rich:run-1:doc-1:1"]);
      expect(read.richEvents()[0]?.metadata).toMatchObject({ readBy: "page-ocr", model: "ppocr:multi" });
      // The stage's own ledger pass sees an engine-charged candidate and charges nothing more.
      expect(await read.record({ label: "ocr", plan: { binary: "in-process:ocr", args: [] }, ocrPages: [1], ocrCharged: true }, "Invoice total 4200")).toEqual([1]);
      expect(read.richIds()).toEqual(["rich:run-1:doc-1:1"]);
      const compute = read.state.usageLedger.snapshot().filter((event) => event.metric === "ocr-compute");
      expect(compute).toHaveLength(1);
      expect(compute[0]?.metadata).toMatchObject({ cpuMs: 1_200, peakRssKb: 660_000, chargedPages: [1] });
    } finally { await read.cleanup(); }
    const blank = await harness({ format: "image", frames: () => [{ frame: 1, text: "   " }] });
    try {
      await blank.stage.run(blank.state);
      // An uploaded image bills its OCR read whether or not it found text (owner decision, 2026-11-05).
      expect(blank.richIds()).toEqual(["rich:run-1:doc-1:1"]);
    } finally { await blank.cleanup(); }
  });

  it("bills each scanned PDF page the engine filled once, whatever the stage records afterwards", async () => {
    // Pages 2 and 4 are scans the engine reads; page 3 is a scan the engine finds blank; page 1 has a text layer.
    const h = await harness({
      format: "pdf", pageCount: 4,
      text: "Native text layer page\f\f\f\f",
      frames: (job) => job.pages!.map((frame) => ({ frame, text: frame === 3 ? "" : `Scanned page ${frame}` })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.jobs.map((job) => job.pages)).toEqual([[2, 3, 4]]);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:4"]);
      expect(new Set(h.richEvents().map((event) => event.metadata?.readBy))).toEqual(new Set(["page-ocr"]));
      // Kreuzberg won the text layer and never OCRs: the stage's own pass records nothing more.
      expect(await h.record({ label: "kreuzberg", plan: { binary: "node", args: ["--config-json", "{}"] } }, "Native text layer page\fScanned page 2\f\fScanned page 4\f")).toEqual([]);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:4"]);
    } finally { await h.cleanup(); }
  });

  it("sends a page holding only an image reference to OCR, and bills it only when the engine finds words", async () => {
    const ref = `![](docslurp-artifact:doc-1:${"a".repeat(64)}.webp#p2o0)`;
    const h = await harness({
      format: "pdf", pageCount: 3,
      text: `Native text\f<!-- page 2 -->\n\n${ref}\f<!-- page 3 -->\n\n![Signed by Ada](docslurp-artifact:doc-1:${"b".repeat(64)}.webp#p3o0)\nTotal 4200\f`,
      frames: (job) => job.pages!.map((frame) => ({ frame, text: "" })),
    });
    try {
      await h.stage.run(h.state);
      // Page 2 has no words besides its reference; page 3 has words and is not re-read.
      expect(h.jobs.map((job) => job.pages)).toEqual([[2]]);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("records nothing for a born-digital PDF or under Fast", async () => {
    const digital = await harness({ format: "pdf", pageCount: 2, text: "Page one\fPage two\f", nativePages: ["Page one", "Page two"] });
    try {
      await digital.stage.run(digital.state);
      expect(digital.jobs).toEqual([]);
      expect(digital.richIds()).toEqual([]);
    } finally { await digital.cleanup(); }
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fast = await harness({ format: "pdf", pageCount: 2, pipeline: { quality: "fast" }, text: "x\f\f", nativePages: ["", ""] });
    try {
      await fast.stage.run(fast.state);
      expect(fast.jobs).toEqual([]);
      expect(fast.richIds()).toEqual([]);
      expect(await fast.record({ label: "dolphin", plan: { binary: "python", args: [] } }, "x\fScanned words\f")).toEqual([]);
      expect(fast.richIds()).toEqual([]);
    } finally { await fast.cleanup(); }
  });

  it("infers OCR reads only for a winner that ran OCR; Kreuzberg never does", async () => {
    const h = await harness({ format: "pdf", pageCount: 2, text: "x\fScanned words\f", nativePages: ["x", ""] });
    try {
      for (const label of ["native-pdf", "poppler-text", "pandoc"]) expect(await h.record({ label, plan: { binary: "x", args: [] } }, "x\fScanned words\f")).toEqual([]);
      expect(await h.record({ label: "liteparse", plan: { binary: "node", args: ["--input", "a"] } }, "x\fScanned words\f")).toEqual([]);
      expect(await h.record({ label: "kreuzberg", plan: { binary: "node", args: ["--config-json", "{}"] } }, "x\fScanned words\f")).toEqual([]);
      expect(await h.record({ label: "kreuzberg", plan: { binary: "node", args: [] } }, "x\fScanned words\f")).toEqual([]);
      expect(h.richIds()).toEqual([]);
      expect(await h.record({ label: "liteparse", plan: { binary: "node", args: ["--ocr"] } }, "x\fScanned words\f")).toEqual([2]);
      expect(await h.record({ label: "dolphin", plan: { binary: "python", args: [] } }, "x\fScanned words\f")).toEqual([2]);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2"]);
      expect(h.richEvents()[0]?.metadata).toMatchObject({ readBy: "pdf-ocr" });
    } finally { await h.cleanup(); }
  });

  it("records no inferred OCR reads when the winner's text carries no page breaks: an unknown fact never raises a charge", async () => {
    const h = await harness({ format: "pdf", pageCount: 3, nativePages: ["Native page text", "", ""] });
    try {
      expect(await h.record({ label: "dolphin", plan: { binary: "python", args: [] } }, "Native page text then scanned words")).toEqual([]);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("logs a missing or failed text-layer probe for an OCR-capable winner and bills nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unknown = await harness({ format: "pdf", pageCount: 2, nativePages: null });
    try {
      expect(await unknown.record({ label: "dolphin", plan: { binary: "python", args: [] } }, "x\fScanned words\f")).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toContain("native text layer unavailable");
    } finally { await unknown.cleanup(); }
    const failing = await harness({ format: "pdf", pageCount: 2, nativePages: null });
    try {
      (failing.stage as any).runner.pageText = async () => ({ binary: "pdftotext", args: [], available: true });
      (failing.stage as any).runner.run = async () => { throw new Error("pdftotext timed out"); };
      expect(await failing.record({ label: "dolphin", plan: { binary: "python", args: [] } }, "x\fScanned words\f")).toEqual([]);
      expect(failing.richIds()).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/\[ocr-ledger\] probe-failed document=doc-1 extractor=dolphin reason=pdftotext timed out/);
    } finally { await failing.cleanup(); }
  });

  it("uses the sandboxed provider's reported pages and never probes the host for them", async () => {
    const h = await harness({ format: "pdf", pageCount: 3, nativePages: ["", "", ""] });
    try {
      const probe = vi.fn(async () => { throw new Error("must not probe the host"); });
      (h.stage as any).nativeTextLayerPages = probe;
      expect(await h.record({ label: "vm-pdf", plan: { binary: "vm", args: [] } }, "a\fb\fc\f", { sandboxedRoute: true })).toEqual([]);
      expect(await h.record({ label: "vm-pdf", plan: { binary: "vm", args: [] }, ocrPages: [3, 1, 9] }, "a\fb\fc\f", { sandboxedRoute: true })).toEqual([1, 3]);
      expect(probe).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:3"]);
    } finally { await h.cleanup(); }
  });

  it("bills exactly the pages the graph extractor's OCR adapter reports, as page-ocr", async () => {
    const h = await harness({ format: "pdf", pageCount: 2, nativePages: ["Words", "Words"] });
    try {
      const pages = await h.record({ label: "graph-local", ocrPages: [1, 2] }, "<!-- page 1 -->\n\nWords");
      expect(pages).toEqual([1, 2]);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:2"]);
      expect(new Set(h.richEvents().map((event) => event.metadata?.readBy))).toEqual(new Set(["page-ocr"]));
    } finally { await h.cleanup(); }
  });
});
