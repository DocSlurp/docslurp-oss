import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures } from "@docslurp/shared";

import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import type { CommandRunner } from "../tools/runner.js";

/**
 * A page bills Rich only when a vision or OCR model read it (db/page-base-fee.ts). Every page OCR produced text for is a read:
 * recorded on the usage ledger once per page, whatever extractor did the OCR and however often the stage runs again.
 */
function run(pipeline: Record<string, unknown> = {}): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 3, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, ...pipeline },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
}

async function harness(args: { format: "image" | "pdf"; pageCount?: number; pipeline?: Record<string, unknown>; text: string; nativePages?: string[] | null }) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-ocr-ledger-test-"));
  const objects = new Map<string, Buffer>();
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async () => undefined,
    streamText: async (key: string, text: string) => { objects.set(key, Buffer.from(text)); },
  };
  const runner = {
    kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true }),
    extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
    pageText: async () => ({ binary: "pdftotext", args: [], available: false }),
  } as unknown as CommandRunner;
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
  internals.extractCandidate = async (extractor: { label: string; plan: unknown }, textKey: string) => {
    const tempTextPath = path.join(scratch, `${extractor.label}.md`);
    await writeFile(tempTextPath, args.text);
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
  const richIds = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich").map((event) => event.id);
  return { stage, state, richIds, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

describe("OCR reads on the usage ledger", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("records the OCR read of an uploaded image that produced text, and nothing for one that produced none", async () => {
    vi.stubEnv("DOCSLURP_OCR", "on");
    const read = await harness({ format: "image", text: "Invoice total 4200" });
    try {
      await read.stage.run(read.state);
      expect(read.richIds()).toEqual(["rich:run-1:doc-1:1"]);
      expect(read.state.usageLedger.snapshot().find((event) => event.metric === "ingest-page-rich")?.metadata).toMatchObject({ readBy: "image-ocr" });
    } finally { await read.cleanup(); }
    const blank = await harness({ format: "image", text: "   " });
    try {
      await blank.stage.run(blank.state);
      expect(blank.richIds()).toEqual([]);
    } finally { await blank.cleanup(); }
  });

  it("records one Rich read per scanned PDF page the extractor OCR'd, found by an empty native layer and words in the page", async () => {
    // Pages 2 and 4 are scans OCR gave text for; page 3 is scanned but blank (nothing was read into it); page 1 has a text layer.
    const h = await harness({
      format: "pdf", pageCount: 4,
      text: "Native text layer page\fSecond page signed by Ada\f\fFourth page total 4200\f",
      nativePages: ["Native text layer page", "", "", ""],
    });
    try {
      await h.stage.run(h.state);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:4"]);
      expect(h.state.usageLedger.snapshot().find((event) => event.metric === "ingest-page-rich")?.metadata).toMatchObject({ readBy: "pdf-ocr" });
      // The stage again (a retried activity's second pass over the same ledger) charges nothing more.
      await (h.stage as any).recordOcrPageReads(h.state, h.state.documents[0], {
        format: "pdf", isPdf: true, winningText: "Native text layer page\fSecond page signed by Ada\f\fFourth page total 4200\f",
        candidate: { label: "kreuzberg" }, sourcePath: "unused",
      });
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:4"]);
    } finally { await h.cleanup(); }
  });

  it("records nothing for a born-digital PDF, a PDF whose text layer exists but is unreadable here, or Fast", async () => {
    const digital = await harness({ format: "pdf", pageCount: 2, text: "Page one\fPage two\f", nativePages: ["Page one", "Page two"] });
    try { await digital.stage.run(digital.state); expect(digital.richIds()).toEqual([]); } finally { await digital.cleanup(); }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unknown = await harness({ format: "pdf", pageCount: 2, text: "Page one\fPage two\f", nativePages: null });
    try {
      await unknown.stage.run(unknown.state);
      expect(unknown.richIds()).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toContain("native text layer unavailable");
    } finally { await unknown.cleanup(); warn.mockRestore(); }
    const fast = await harness({ format: "pdf", pageCount: 2, pipeline: { quality: "fast" }, text: "x\fy\f", nativePages: ["", ""] });
    try { await fast.stage.run(fast.state); expect(fast.richIds()).toEqual([]); } finally { await fast.cleanup(); }
  });

  it("records no OCR reads when the extractor's text carries no page breaks: an unknown fact never raises a charge", async () => {
    // Before: pages 2 and 3 (no text layer) were both charged because they "shared the document's words".
    const h = await harness({ format: "pdf", pageCount: 3, text: "Native page text then scanned words", nativePages: ["Native page text", "", ""] });
    try {
      await h.stage.run(h.state);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("does not bill a page that holds only an image reference or a page marker", async () => {
    const ref = `![](docslurp-artifact:doc-1:${"a".repeat(64)}.webp#p2o0)`;
    const h = await harness({
      format: "pdf", pageCount: 3,
      text: `Native text\f<!-- page 2 -->\n\n${ref}\f<!-- page 3 -->\n\n![Signed by Ada](docslurp-artifact:doc-1:${"b".repeat(64)}.webp#p3o0)\nTotal 4200\f`,
      nativePages: ["Native text", "", ""],
    });
    try {
      await h.stage.run(h.state);
      // Page 2 is an image reference alone (before: billed Rich); page 3 has OCR words besides its reference.
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:3"]);
    } finally { await h.cleanup(); }
  });

  it("infers OCR reads only for a winner that ran OCR", async () => {
    const h = await harness({ format: "pdf", pageCount: 2, text: "x\fScanned words\f", nativePages: ["x", ""] });
    try {
      const record = (candidate: Record<string, unknown>) => (h.stage as any).recordOcrPageReads(h.state, h.state.documents[0], {
        format: "pdf", isPdf: true, winningText: "x\fScanned words\f", candidate, sourcePath: "unused",
      });
      for (const label of ["native-pdf", "poppler-text", "pandoc"]) expect(await record({ label, plan: { binary: "x", args: [] } })).toEqual([]);
      expect(await record({ label: "liteparse", plan: { binary: "node", args: ["--input", "a"] } })).toEqual([]);
      expect(await record({ label: "kreuzberg", plan: { binary: "node", args: ["--config-json", JSON.stringify({ disableOcr: true })] } })).toEqual([]);
      expect(h.richIds()).toEqual([]);
      expect(await record({ label: "kreuzberg", plan: { binary: "node", args: ["--config-json", "{}"] } })).toEqual([2]);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2"]);
    } finally { await h.cleanup(); }
  });

  it("logs and counts a failed text-layer probe for an OCR-capable winner and bills nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, text: "x\fScanned words\f", nativePages: null });
    try {
      (h.stage as any).runner.pageText = async () => ({ binary: "pdftotext", args: [], available: true });
      (h.stage as any).runner.run = async () => { throw new Error("pdftotext timed out"); };
      await h.stage.run(h.state);
      expect(h.richIds()).toEqual([]);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/\[ocr-ledger\] probe-failed document=doc-1 extractor=kreuzberg reason=pdftotext timed out/);
    } finally { await h.cleanup(); warn.mockRestore(); }
  });

  it("uses the sandboxed provider's reported pages and never probes the host for them", async () => {
    const h = await harness({ format: "pdf", pageCount: 3, text: "a\fb\fc\f", nativePages: ["", "", ""] });
    try {
      const probe = vi.fn(async () => { throw new Error("must not probe the host"); });
      (h.stage as any).nativeTextLayerPages = probe;
      const record = (candidate: Record<string, unknown>) => (h.stage as any).recordOcrPageReads(h.state, h.state.documents[0], {
        format: "pdf", isPdf: true, winningText: "a\fb\fc\f", candidate, sourcePath: "unused", sandboxedRoute: true,
      });
      expect(await record({ label: "vm-pdf", plan: { binary: "vm", args: [] } })).toEqual([]);
      expect(await record({ label: "vm-pdf", plan: { binary: "vm", args: [] }, ocrPages: [3, 1, 9] })).toEqual([1, 3]);
      expect(probe).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:3"]);
    } finally { await h.cleanup(); }
  });

  it("bills exactly the pages the graph extractor's tesseract adapter reports it OCR'd", async () => {
    const h = await harness({ format: "pdf", pageCount: 2, text: "<!-- page 1 -->\n\nWords", nativePages: ["Words", "Words"] });
    try {
      const pages = await (h.stage as any).recordOcrPageReads(h.state, h.state.documents[0], {
        format: "pdf", isPdf: true, winningText: "<!-- page 1 -->\n\nWords", candidate: { label: "graph-local", ocrPages: [1, 2] }, sourcePath: "unused",
      });
      expect(pages).toEqual([1, 2]);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:2"]);
    } finally { await h.cleanup(); }
  });
});
