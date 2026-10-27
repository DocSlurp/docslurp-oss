import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES, defaultPipelineFeatures, publicDocumentError } from "@docslurp/shared";

import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import type { CommandRunner } from "../tools/runner.js";

const KREUZBERG_OCR_CRASH =
  "kreuzberg=Error: node (1): Error opening data file /home/runner/work/kreuzberg-lts/target/kreuzberg-tesseract-cache/tessdata/eng.traineddata";

function createRun(pipeline: Record<string, unknown> = {}): WorkspaceRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, ...pipeline },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
}

function createDocument(filename: string, mimeType: string): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename, mimeType,
    sourceKey: `raw/${filename}`, status: "processing", extractionMode: "hybrid", pageCount: 1,
    createdAt: new Date(), updatedAt: new Date(),
  } as Document;
}

/** The stage's real control flow, with storage in memory and each extractor replaced by `extract`. */
async function harness(args: {
  format: "image" | "pdf";
  pipeline?: Record<string, unknown>;
  extract?: (label: string) => Promise<{ text: string }>;
}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-image-ocr-test-"));
  const attempted: string[] = [];
  const objects = new Map<string, Buffer>();
  const manifests = new Map<string, any>();
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { manifests.set(key, value); },
    streamText: async (key: string, text: string) => { objects.set(key, Buffer.from(text)); },
  };
  const runner = {
    kreuzbergMarkdown: async () => ({ binary: "node", args: [], available: true }),
    extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
  } as unknown as CommandRunner;
  const stage = new ExtractMarkdownStage(runner, storage as any, {} as any);
  const internals = stage as any;
  const sourcePath = path.join(scratch, args.format === "image" ? "scanned-memo.png" : "scan.pdf");
  await writeFile(sourcePath, "bytes");
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.buildParserArtifacts = async () => [];
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  const realExtractCandidate = internals.extractCandidate.bind(stage);
  internals.extractCandidate = async (extractor: { label: string }, textKey: string, ...rest: unknown[]) => {
    // The textless stand-in is the stage's own in-process code, not an external parser to fake.
    if (extractor.label === "image-textless") return await realExtractCandidate(extractor, textKey, ...rest);
    attempted.push(extractor.label);
    const { text } = await (args.extract ?? (async () => { throw new Error(KREUZBERG_OCR_CRASH); }))(extractor.label);
    const tempTextPath = path.join(scratch, `${extractor.label}.md`);
    await writeFile(tempTextPath, text);
    return { label: extractor.label, plan: (extractor as any).plan, textKey, textUri: `s3://test/${textKey}`, tempTextPath };
  };
  const document = args.format === "image"
    ? createDocument("scanned-memo.png", "image/png")
    : createDocument("scan.pdf", "application/pdf");
  const state = WorkflowState.create(createRun(args.pipeline), [document]);
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", args.format);
  return {
    stage, state, attempted, objects, manifests,
    checkpoint: () => state.documentStage("doc-1", "extract-markdown"),
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

describe("image documents whose OCR cannot run", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("continues to vision when Tesseract data is missing, without attempting Kreuzberg OCR", async () => {
    vi.stubEnv("DOCSLURP_OCR", "off");
    const h = await harness({ format: "image" });
    try {
      await h.stage.run(h.state);

      expect(h.attempted).not.toContain("kreuzberg");
      expect(h.checkpoint()?.status).toBe("completed");
      const manifest = [...h.manifests.values()].find((value) => value?.needsVision !== undefined);
      expect(manifest).toMatchObject({ needsVision: true, textlessFallback: expect.stringContaining("OCR") });
      expect([...h.objects.values()].every((bytes) => bytes.length === 0)).toBe(true);
    } finally { await h.cleanup(); }
  });

  it("does not fail the document when Kreuzberg's bundled OCR crashes on missing language data", async () => {
    vi.stubEnv("DOCSLURP_OCR", "on");
    const h = await harness({ format: "image" });
    try {
      await h.stage.run(h.state);

      expect(h.attempted).toEqual(["kreuzberg"]);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.checkpoint()?.status).not.toBe("failed");
      const manifest = [...h.manifests.values()].find((value) => value?.needsVision !== undefined);
      expect(manifest).toMatchObject({ needsVision: true, textlessFallback: expect.stringContaining("Error opening data file") });
    } finally { await h.cleanup(); }
  });

  it("fails with a specific, user-facing cause when vision is turned off for the workspace", async () => {
    vi.stubEnv("DOCSLURP_OCR", "off");
    const h = await harness({ format: "image", pipeline: { visionFallback: false } });
    try {
      await h.stage.run(h.state);

      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toContain(DOCUMENT_FAILURE_MARKERS.imageNeedsVision);
      expect(checkpoint?.error).not.toMatch(/^no extractor produced output/);
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageNeedsVision);
    } finally { await h.cleanup(); }
  });

  it("fails with the same cause, keeping the raw diagnostic, when privacy mode forbids the hosted vision route", async () => {
    vi.stubEnv("DOCSLURP_OCR", "on");
    const h = await harness({ format: "image", pipeline: { privacyMode: "strict-privacy" } });
    try {
      await h.stage.run(h.state);

      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toContain(DOCUMENT_FAILURE_MARKERS.imageNeedsVision);
      expect(checkpoint?.error).toContain("Error opening data file");
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageNeedsVision);
    } finally { await h.cleanup(); }
  });

  it("still reports other extractor failures for formats that have a text layer", async () => {
    vi.stubEnv("DOCSLURP_OCR", "off");
    const h = await harness({ format: "pdf", extract: async () => { throw new Error("pdftotext: unreadable cross-reference table"); } });
    try {
      await h.stage.run(h.state);

      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no extractor produced output|no untried extractor remains/);
      expect(checkpoint?.error).not.toContain(DOCUMENT_FAILURE_MARKERS.imageNeedsVision);
    } finally { await h.cleanup(); }
  });

  it("lets a scanned PDF through the text-layer path with OCR unavailable, since Kreuzberg only OCRs images unless asked", async () => {
    vi.stubEnv("DOCSLURP_OCR", "off");
    const h = await harness({ format: "pdf", extract: async () => ({ text: "" }) });
    try {
      await h.stage.run(h.state);

      expect(h.attempted).toEqual(["kreuzberg"]);
      expect(h.checkpoint()?.status).toBe("completed");
    } finally { await h.cleanup(); }
  });
});
