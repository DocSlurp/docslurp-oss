import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyIngestFailure, defaultPipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { unsupportedSourceReason } from "../extractors/registry.js";
import type { Document, WorkspaceRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";

/*
 * Office files no extractor here can read (the retired parsers read some of them) fail loudly as an unsupported format:
 * logged, non-retryable in the ingest report, and never handed to a weaker reader or published as empty text.
 */
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
const ZIP = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.alloc(60)]);

const cases = [
  { name: "legacy Word .doc", filename: "memo.doc", mimeType: "application/msword", format: "office-other", reason: /legacy binary Office file/ },
  { name: "legacy PowerPoint .ppt", filename: "deck.ppt", mimeType: "application/vnd.ms-powerpoint", format: "office-pptx", reason: /legacy binary Office file/ },
  { name: "legacy Excel .xls", filename: "book.xls", mimeType: "application/vnd.ms-excel", format: "office-excel", reason: /legacy binary Office file/ },
  { name: "password-protected .docx", filename: "secret.docx", mimeType: "application/x-ole-storage", format: "office-word", reason: /password-protected/ },
  { name: "password-protected .xlsx", filename: "secret.xlsx", mimeType: "application/x-ole-storage", format: "office-excel", reason: /password-protected/ },
] as const;

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function source(filename: string, bytes: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "unsupported-office-"));
  dirs.push(dir);
  const file = path.join(dir, filename);
  await writeFile(file, bytes);
  return file;
}

function stageFor(sourcePath: string, c: (typeof cases)[number]) {
  const stage = new ExtractMarkdownStage({} as never, {} as never, {} as never);
  const internals = stage as any;
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.recordSourcePageFacts = async () => undefined;
  const planExtractors = vi.fn(async () => null);
  const extractCandidate = vi.fn(async () => { throw new Error("no extractor may run"); });
  internals.planExtractors = planExtractors;
  internals.extractCandidate = extractCandidate;
  const run = {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as WorkspaceRun;
  const document = {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: c.filename, mimeType: c.mimeType,
    sourceKey: `raw/${c.filename}`, status: "processing", extractionMode: "hybrid", pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
  } as Document;
  const state = WorkflowState.create(run, [document]);
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", c.format);
  return { stage, state, planExtractors, extractCandidate };
}

describe("Office files with no reader fail loudly as an unsupported format", () => {
  it.each(cases)("$name", async (c) => {
    const file = await source(c.filename, OLE);
    const reason = await unsupportedSourceReason(file, { format: c.format, mimeType: c.mimeType, filename: c.filename });
    expect(reason).toMatch(c.reason);
    // The ingest report shows it as unsupported and not retryable, never as a transient extractor failure.
    expect(classifyIngestFailure(reason)).toMatchObject({ reason: "unsupported_format", retryable: false });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { stage, state, planExtractors, extractCandidate } = stageFor(file, c);
    await stage.run(state).catch(() => undefined);
    const checkpoint = state.documentStage("doc-1", "extract-markdown");
    expect(checkpoint?.status).toBe("failed");
    expect(JSON.stringify(checkpoint)).toMatch(c.reason);
    // Failed before any extractor was planned or run: no fallback, no empty result.
    expect(planExtractors).not.toHaveBeenCalled();
    expect(extractCandidate).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toMatch(/\[extract-markdown\] unsupported-format document=doc-1/);
  });

  it("leaves Office Open XML files, and non-Office formats with OLE bytes, to their extractors", async () => {
    for (const [filename, format] of [["deck.pptx", "office-pptx"], ["book.xlsx", "office-excel"], ["brief.docx", "office-word"]] as const) {
      expect(await unsupportedSourceReason(await source(filename, ZIP), { format, filename }), filename).toBeNull();
    }
    expect(await unsupportedSourceReason(await source("scan.pdf", OLE), { format: "pdf", filename: "scan.pdf" })).toBeNull();
  });
});
