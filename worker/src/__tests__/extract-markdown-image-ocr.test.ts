import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, PUBLIC_ERROR_MESSAGES, publicDocumentError } from "@docslurp/shared";

import { documentExtractorRegistry } from "../extractors/registry.js";
import type { SandboxedOcrJob } from "../extractors/plugins.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage, OCR_PDF_BATCH_PAGES } from "../stages/extract-markdown.js";
import { fakeOcrRunner, ocrResultFor, type FakeFrame } from "../test/fake-ocr.js";
import type { CommandRunner } from "../tools/runner.js";

/*
 * Images are read only by the OCR engine (the `ocr` extractor, in the configured boundary), and scanned PDF pages are
 * filled by it. A refused or failed OCR read fails the document: hosted vision is never a stand-in, and Fast never OCRs.
 */

function createRun(pipeline: Record<string, unknown> = {}, pagesTotal = 1): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, ...pipeline },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
}

function createDocument(filename: string, mimeType: string, pageCount: number): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename, mimeType,
    sourceKey: `raw/${filename}`, status: "processing", extractionMode: "hybrid", pageCount,
    createdAt: new Date(), updatedAt: new Date(),
  } as Document;
}

/** Labels whose real executor runs (the in-process stand-in, and the OCR extractor against the fake boundary). */
const REAL_EXECUTORS = new Set(["image-textless", "ocr"]);

/** The stage's real control flow, with storage in memory, a fake OCR boundary, and other extractors replaced by `extract`. */
async function harness(args: {
  format: "image" | "pdf";
  /** Overrides the document MIME type (default image/png or application/pdf by format). */
  mimeType?: string;
  filename?: string;
  pageCount?: number;
  pipeline?: Record<string, unknown>;
  extract?: (label: string) => Promise<{ text: string }>;
  /** What the fake OCR boundary reads for a job. */
  frames?: (job: SandboxedOcrJob) => FakeFrame[];
  /** The whole result the fake boundary writes, when a case needs more than its frames. */
  result?: (job: SandboxedOcrJob) => unknown;
}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-image-ocr-test-"));
  const attempted: string[] = [];
  const configs: Record<string, string | undefined> = {};
  const objects = new Map<string, Buffer>();
  const manifests = new Map<string, any>();
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { manifests.set(key, value); },
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
  const ocr = fakeOcrRunner(args.frames ?? ((job) => (job.pages ?? [1]).map((frame) => ({ frame, text: `OCR page ${frame}` }))), args.result ? { result: args.result } : {});
  const runner = {
    ...ocr.runner,
    sandboxedPdfMarkdown: async () => ({ binary: "test-vm", args: [], available: true }),
    kreuzbergMarkdown: vi.fn(async (_source: string, _output: string, configJson?: string) => {
      configs.kreuzberg = configJson;
      return { binary: "node", args: [], available: true };
    }),
    dolphinMarkdown: async (_source: string, _output: string, configJson?: string) => {
      configs.dolphin = configJson;
      return { binary: "python", args: [], available: true };
    },
    extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
  } as unknown as CommandRunner & typeof ocr.runner;
  const stage = new ExtractMarkdownStage(runner, storage as any, {} as any);
  const internals = stage as any;
  const filename = args.filename ?? (args.format === "image" ? "scanned-memo.png" : "scan.pdf");
  const sourcePath = path.join(scratch, filename);
  await writeFile(sourcePath, "bytes");
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.buildParserArtifacts = async () => [];
  internals.recordPageImageEvidence = async () => null;
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  const realExtractCandidate = internals.extractCandidate.bind(stage);
  internals.extractCandidate = async (extractor: { label: string }, textKey: string, ...rest: unknown[]) => {
    attempted.push(extractor.label);
    if (REAL_EXECUTORS.has(extractor.label)) return await realExtractCandidate(extractor, textKey, ...rest);
    const { text } = await (args.extract ?? (async () => { throw new Error("no text-layer extractor expected"); }))(extractor.label);
    const tempTextPath = path.join(scratch, `${extractor.label}.md`);
    await writeFile(tempTextPath, text);
    return { label: extractor.label, plan: (extractor as any).plan, textKey, textUri: `s3://test/${textKey}`, tempTextPath };
  };
  const pageCount = args.pageCount ?? 1;
  const mimeType = args.mimeType ?? (args.format === "image" ? "image/png" : "application/pdf");
  const document = createDocument(filename, mimeType, pageCount);
  const state = WorkflowState.create(createRun(args.pipeline, pageCount), [document]);
  state.usageLedger.runId = "run-1";
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", args.format);
  const richEvents = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich");
  return {
    stage, state, attempted, configs, objects, manifests, runner, jobs: ocr.jobs, richEvents,
    richIds: () => richEvents().map((event) => event.id),
    checkpoint: () => state.documentStage("doc-1", "extract-markdown"),
    text: () => [...objects.entries()].filter(([key]) => key.endsWith(".md")).map(([, bytes]) => bytes.toString("utf8")),
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  // Escalation is a separate concern (ocr/__tests__); these cases read with the recogniser alone.
  vi.stubEnv("DOCSLURP_OCR_ESCALATION", "off");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("image documents are read by the OCR extractor", () => {
  it("routes an image to the ocr extractor and bills page-ocr once for the frame with words", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "image", frames: () => [{ frame: 1, text: "Invoice total 4200" }] });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.attempted).toEqual(["ocr"]);
      expect(h.runner.kreuzbergMarkdown).not.toHaveBeenCalled();
      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0]).toMatchObject({ kind: "image", recognisers: expect.any(Array) });
      expect(h.jobs[0]!.pages).toBeUndefined();
      expect(h.text()).toContain("Invoice total 4200");
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1"]);
      expect(h.richEvents()[0]?.metadata).toMatchObject({ readBy: "page-ocr" });
    } finally { await h.cleanup(); }
  });

  it("yields one page per frame of a multi-frame TIFF, makes the frames its page count and charges every frame", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    // Intake counts every image as one page; the engine reads three frames.
    const h = await harness({
      format: "image", filename: "fax.tiff", mimeType: "image/tiff", pageCount: 1,
      frames: () => [{ frame: 1, text: "Cover sheet" }, { frame: 2, text: "   " }, { frame: 3, text: "Signed by Ada" }],
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs).toHaveLength(1);
      expect(h.text()).toContain("Cover sheet\f   \fSigned by Ada");
      // The page basis is the frames read, so the Markdown's three pages, page rows and the bill agree.
      expect(h.state.documents[0]!.pageCount).toBe(3);
      // An uploaded image bills Rich per frame read, words or not (0.75 credits; 0.5 under the earlier words rule).
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:2", "rich:run-1:doc-1:3"]);
    } finally { await h.cleanup(); }
  });

  it("refuses a TIFF with more frames than one file may hold, publishing nothing and charging nothing", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frames = Array.from({ length: 64 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({
      format: "image", filename: "archive.tiff", mimeType: "image/tiff", pageCount: 1,
      frames: () => frames,
      result: (job) => ocrResultFor(job, frames, { truncatedFrames: true }),
    });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageTooManyFrames);
      expect(h.richIds()).toEqual([]);
      expect(h.state.documents[0]!.pageCount).toBe(1);
    } finally { await h.cleanup(); }
  });

  it("fails an image when OCR is off instead of routing it to vision", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "off");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "image" });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no untried extractor remains for image/);
      expect(h.attempted).not.toContain("image-textless");
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.runner.sandboxedOcrRead).not.toHaveBeenCalled();
      expect([...h.manifests.values()].some((value) => value?.needsVision === true)).toBe(false);
      expect(error.mock.calls.flat().join(" ")).toMatch(/\[ocr\] image-unread document=doc-1 mode=off/);
      // The stored diagnostic never reaches users.
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.processing);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("fails an image when the VM read fails, with no vision stand-in and nothing billed", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "image" });
    h.runner.run.mockRejectedValue(new Error("vm ocr: guest crashed"));
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no extractor produced output|no untried extractor remains/);
      expect(h.attempted.every((label) => label === "ocr")).toBe(true);
      expect(h.attempted).not.toContain("image-textless");
      expect([...h.manifests.values()].some((value) => value?.needsVision === true)).toBe(false);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("fails an image whose OCR result is malformed", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "image" });
    h.runner.run.mockImplementation(async (plan: any) => {
      await writeFile(plan.sandboxedOcr.output, "{not json");
      return { stdout: "", stderr: "" };
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("failed");
      expect(h.attempted).not.toContain("image-textless");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("makes Kreuzberg's prepared plan unavailable for images", async () => {
    const runner = { kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true }) } as unknown as CommandRunner;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const byFormat = await documentExtractorRegistry.prepare("kreuzberg", runner, "/scratch/source.bin", undefined, { format: "image" } as any);
    expect(byFormat.plan.available).toBe(false);
    const byExtension = await documentExtractorRegistry.prepare("kreuzberg", runner, "/scratch/scan.TIFF");
    expect(byExtension.plan.available).toBe(false);
    const pdf = await documentExtractorRegistry.prepare("kreuzberg", runner, "/scratch/scan.pdf", undefined, { format: "pdf" } as any);
    expect(pdf.plan.available).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toContain("kreuzberg refused an image input");
  });

  it("makes the ocr extractor unavailable when OCR is off", async () => {
    const off = await documentExtractorRegistry.prepare("ocr", {} as CommandRunner, "/scratch/scan.png", undefined, { format: "image", env: { DOCSLURP_OCR_MODE: "off" } } as any);
    expect(off.plan.available).toBe(false);
    const vm = await documentExtractorRegistry.prepare("ocr", {} as CommandRunner, "/scratch/scan.png", undefined, { format: "image", env: { DOCSLURP_OCR_MODE: "vm" } } as any);
    expect(vm.plan.available).toBe(true);
  });
});

describe("scanned PDF pages are filled by the OCR engine", () => {
  it("reads exactly the empty pages in one pdf job and bills each once", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({
      format: "pdf", pageCount: 4,
      extract: async () => ({ text: "Native text layer page\f\fThird page native\f\f" }),
      frames: (job) => job.pages!.map((frame) => ({ frame, text: `Scanned words ${frame}` })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0]).toMatchObject({ kind: "pdf", pages: [2, 4] });
      expect(h.text().some((text) => text === "Native text layer page\fScanned words 2\fThird page native\fScanned words 4")).toBe(true);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:4"]);
      expect(new Set(h.richEvents().map((event) => event.metadata?.readBy))).toEqual(new Set(["page-ocr"]));
    } finally { await h.cleanup(); }
  });

  it(`reads a long scan in batches of ${OCR_PDF_BATCH_PAGES} pages`, async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const pageCount = 41;
    // Page 1 has a text layer; pages 2..41 (40 pages) are scans.
    const h = await harness({
      format: "pdf", pageCount,
      extract: async () => ({ text: ["Native page", ...Array.from({ length: pageCount - 1 }, () => "")].join("\f") + "\f" }),
      frames: (job) => job.pages!.map((frame) => ({ frame, text: `Scan ${frame}` })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs.map((job) => job.pages)).toEqual([
        Array.from({ length: 32 }, (_, i) => i + 2),
        Array.from({ length: 8 }, (_, i) => i + 34),
      ]);
      expect(h.jobs.every((job) => job.kind === "pdf")).toBe(true);
      const ids = h.richIds();
      expect(ids).toHaveLength(40);
      expect(new Set(ids).size).toBe(40);
      expect(ids).not.toContain("rich:run-1:doc-1:1");
    } finally { await h.cleanup(); }
  });

  it("fails only the scanned pages, loudly, when the VM read fails during scan fill; the text pages stand", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "Native\f\f" }) });
    h.runner.run.mockRejectedValue(new Error("vm ocr: guest crashed"));
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(error.mock.calls.flat().join(" ")).toMatch(/\[ocr\] scanned-pages-failed document=doc-1 pages=2/);
      // Recorded so vision never reads the failed page in OCR's place.
      expect(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages")).toBe("[2]");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  it("retries a transient VM failure once before failing the scanned pages", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "Native\f\f" }) });
    h.runner.run.mockRejectedValueOnce(new Error("vm capacity"));
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.runner.run).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/scanned-pages-retry document=doc-1 pages=2/);
      expect(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages")).toBeFalsy();
    } finally { await h.cleanup(); warn.mockRestore(); }
  });

  it("fails the document when every page is a scan and the VM read fails", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "" }) });
    h.runner.run.mockRejectedValue(new Error("vm ocr: guest crashed"));
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("failed");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  for (const mode of ["off", "hosted"] as const) {
    it(`leaves scanned pages unread with an error log and no OCR call when DOCSLURP_OCR_MODE=${mode}`, async () => {
      vi.stubEnv("DOCSLURP_OCR_MODE", mode);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const h = await harness({ format: "pdf", pageCount: 3, extract: async () => ({ text: "Native\f\f\f" }) });
      try {
        await h.stage.run(h.state);
        expect(h.checkpoint()?.status).toBe("completed");
        expect(h.attempted).toEqual(["kreuzberg"]);
        expect(h.runner.run).not.toHaveBeenCalled();
        expect(h.runner.sandboxedOcrRead).not.toHaveBeenCalled();
        expect(h.runner.localOcrRead).not.toHaveBeenCalled();
        expect(error.mock.calls.flat().join(" ")).toMatch(new RegExp(`\\[ocr\\] scanned-pages-unread document=doc-1 pages=2 mode=${mode}`));
        expect(h.richIds()).toEqual([]);
      } finally { await h.cleanup(); }
    });
  }

  it("keeps an empty VM PDF scan healthy and skips implicit native enrichment", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_PDF_ENGINE", "shadow");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", extract: async () => ({ text: "" }) });
    const internals = h.stage as any;
    const payload = vi.fn(async () => { throw new Error("must not parse on host"); });
    internals.buildParserArtifacts = payload;
    try {
      await h.stage.run(h.state);
      expect(h.attempted).toEqual(["vm-pdf"]);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.state.documents[0]?.status).not.toBe("failed");
      expect(payload).not.toHaveBeenCalled();
      const manifest = [...h.manifests.values()].find(v => v?.needsVision !== undefined);
      expect(manifest).toBeDefined();
    } finally { await h.cleanup(); }
  });

  it("still reports other extractor failures for formats that have a text layer", async () => {
    const h = await harness({ format: "pdf", extract: async () => { throw new Error("pdftotext: unreadable cross-reference table"); } });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no extractor produced output|no untried extractor remains/);
      expect(h.runner.run).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });
});

describe("quality fast extraction is text-layer only", () => {
  it("keeps an image unread and never calls OCR", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "image", pipeline: { quality: "fast" } });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.attempted).toEqual(["image-textless"]);
      expect(h.runner.sandboxedOcrRead).not.toHaveBeenCalled();
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("never fills scanned PDF pages with OCR", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, pipeline: { quality: "fast" }, extract: async () => ({ text: "Native\f\f" }) });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("drops request OCR options and model extractors, and passes Kreuzberg disableOcr", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({
      format: "pdf",
      pipeline: {
        quality: "fast",
        documentExtraction: {
          ...defaultPipelineFeatures.documentExtraction,
          order: { pdf: ["dolphin", "graph-local", "kreuzberg"] },
          options: { kreuzberg: { forceOcr: true, ocr: { backend: "paddleocr" } }, dolphin: { mode: "layout" } },
        },
      },
      extract: async () => ({ text: "Born-digital text." }),
    });
    try {
      await h.stage.run(h.state);
      expect(h.attempted).toEqual(["kreuzberg"]);
      expect(h.configs.dolphin).toBeUndefined();
      expect(JSON.parse(h.configs.kreuzberg!)).toEqual({ disableOcr: true });
    } finally {
      await h.cleanup();
    }
  });

  // An image/* MIME the format map does not know falls back to the filename: "scan.pdf" uploaded as image/gif
  // detects as pdf. Billing and render-images treat it as an image, so extraction must keep it unread too.
  it("keeps an image/* MIME the format map does not know unread instead of OCRing it", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", mimeType: "image/gif", pipeline: { quality: "fast" }, extract: async () => ({ text: "OCR TEXT" }) });
    try {
      await h.stage.run(h.state);
      expect(h.attempted).toEqual(["image-textless"]);
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.checkpoint()?.status).toBe("completed");
    } finally {
      await h.cleanup();
    }
  });

  it("still extracts that MIME under auto", async () => {
    const h = await harness({ format: "pdf", mimeType: "image/gif", extract: async () => ({ text: "OCR TEXT" }) });
    try {
      await h.stage.run(h.state);
      expect(h.attempted.length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });
});
