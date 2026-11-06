import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { defaultPipelineFeatures, fileFactsFor } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sniffedPdf } from "../lib/sniffed-pdf.js";
import type { Document, WorkspaceRun } from "../models.js";
import { resolveNativePdfEngine } from "../native-pdf/engine.js";
import { assertNativePdfEngineAtStartup, loadNativePdfEngine, setNativePdfEngineForTesting } from "../native-pdf/loader.js";
import type { NativePdfEngine } from "../native-pdf/types.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";

/**
 * Council A H1: an HTML file named x.pdf with a PDF embedded after its markup. Intake sniffs it as HTML (the sniffer reads
 * `%PDF-` only at offset 0); the in-process engine would find the embedded `%PDF-` anywhere. No PDF parser may open it.
 */
const POLYGLOT = Buffer.from(
  "<!doctype html><html><body><p>hello</p><!--\n%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n" +
    "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n--></body></html>\n",
);

/** An engine that records every open; opening a polyglot must never happen. */
function spyEngine() {
  const openPath = vi.fn(async () => { throw new Error("the native engine opened the file"); });
  const engine = { id: "spy", version: () => ({ engine: "native-pdf", version: "0", gitSha: "", features: [] }), openPath } as unknown as NativePdfEngine;
  return { engine, openPath };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "polyglot-"));
  for (const name of ["DOCSLURP_SERVICE_PROFILE", "DOCSLURP_PDF_EXTRACTOR", "DOCSLURP_VM_PDF_INSTALLED", "DOCSLURP_NATIVE_PDF_INSTALLED", "DOCSLURP_PDF_ENGINE", "DOCSLURP_NATIVE_PDF_POPPLER"]) vi.stubEnv(name, "");
});
afterEach(async () => {
  setNativePdfEngineForTesting(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("a polyglot x.pdf sniffed as HTML never reaches a PDF parser", () => {
  const facts = () => fileFactsFor(POLYGLOT, { filename: "x.pdf", declaredMimeType: "text/html" });

  it("sniffs as HTML, not PDF, whatever its name says", () => {
    expect(facts().format).toBe("html");
    const document = { mimeType: facts().mimeType, fileFacts: facts() };
    expect(sniffedPdf(document)).toBe(false);
    // Even declared as a PDF, the sniffed facts decide.
    expect(sniffedPdf({ mimeType: "application/pdf", fileFacts: { ...facts(), declaredMimeType: "application/pdf" } })).toBe(false);
  });

  it("extract-markdown builds no PDF parser artifact and never opens the native engine", async () => {
    const { engine, openPath } = spyEngine();
    setNativePdfEngineForTesting(engine);
    const source = path.join(dir, "x.pdf");
    await writeFile(source, POLYGLOT);
    const document = {
      id: "doc-1", userId: "u", runId: "run-1", filename: "x.pdf", mimeType: facts().mimeType, fileFacts: facts(),
      sourceKey: "u/run/raw/x.pdf", status: "queued", extractionMode: "hybrid", pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
    } as Document;
    const run = { id: "run-1", orgId: "o", userId: "u", pipeline: { ...defaultPipelineFeatures, pdfRegionExtraction: true }, stats: {}, artifacts: {} } as unknown as WorkspaceRun;
    const state = WorkflowState.create(run, [document]);
    const runner = { run: vi.fn(async () => { throw new Error("a parser ran"); }) };
    const stage = new ExtractMarkdownStage(runner as never, {} as never, { parserArtifactTimeoutMs: 1_000 } as never);
    const outcome = { status: "none" as const, reason: null as string | null };
    const artifacts = await (stage as unknown as {
      buildParserArtifacts(...args: unknown[]): Promise<unknown[]>;
    }).buildParserArtifacts(document, "html", source, state, { hasTablePages: true, nativePayloadOutcome: outcome });
    expect(artifacts).toEqual([]);
    expect(outcome.reason).toBe("sniffed format is html, not pdf");
    expect(openPath).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
  });
});

describe("the in-process native engine is refused wherever PDFs run only in vm-pdf", () => {
  for (const env of [{ DOCSLURP_PDF_EXTRACTOR: "vm-pdf" }, { DOCSLURP_VM_PDF_INSTALLED: "1" }, { DOCSLURP_SERVICE_PROFILE: "service" }]) {
    it(`never loads or resolves it under ${JSON.stringify(env)}, nor the host Poppler subset`, async () => {
      const { engine, openPath } = spyEngine();
      setNativePdfEngineForTesting(engine);
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      vi.stubEnv("DOCSLURP_NATIVE_PDF_POPPLER", "1");
      expect(await loadNativePdfEngine()).toMatchObject({ ok: false, reason: expect.stringMatching(/refused|lacks a VM boundary/) });
      expect(await resolveNativePdfEngine({ extractText: vi.fn(), run: vi.fn() } as never)).toBeNull();
      expect(openPath).not.toHaveBeenCalled();
    });
  }

  it("refuses to start when the image ships the engine (or a mode asks for it) beside vm-pdf", async () => {
    await expect(assertNativePdfEngineAtStartup({ DOCSLURP_PDF_EXTRACTOR: "vm-pdf", DOCSLURP_NATIVE_PDF_INSTALLED: "1" })).rejects.toThrow(/runs PDFs only in vm-pdf/);
    await expect(assertNativePdfEngineAtStartup({ DOCSLURP_SERVICE_PROFILE: "service", DOCSLURP_PDF_ENGINE: "shadow" })).rejects.toThrow(/lacks a VM boundary/);
    await expect(assertNativePdfEngineAtStartup({ DOCSLURP_PDF_EXTRACTOR: "vm-pdf" })).resolves.toMatchObject({ ok: false });
  });
});
