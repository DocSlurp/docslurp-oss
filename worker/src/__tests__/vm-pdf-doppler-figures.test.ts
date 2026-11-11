import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acceptSandboxedPdfResult, registerExtractorPlugin, resetExtractorPluginsForTest, type SandboxedPdfResult } from "../extractors/plugins.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-figures");
const DOC_ID = "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b";
const MARKDOWN = "# Heading\n\nProse before the figure.\n\n![image](doppler-image:p3.1)\n\nProse after.\f![image](doppler-image:p3.g2)\f![image](doppler-image:p4.1)\fFour.\fFive.";

function registerProvider(figures: boolean) {
  registerExtractorPlugin({ apiVersion: 1, name: "test-plugin", sandboxedPdf: {
    id: "test-vm", maxSourceBytes: 1024, assertConfigured: () => undefined, timeoutMs: () => 1_000,
    run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    ...(figures ? { figures: { producerId: "test-figures" } } : {}),
  } });
}

/**
 * Runs the real ExtractMarkdownStage over a faked VM. `vm` plays the provider: it gets the job the stage built and
 * returns the provider result (the runner normally passes it through acceptSandboxedPdfResult).
 */
async function runStage(vm: (job: any) => Promise<Partial<SandboxedPdfResult>>) {
  const { defaultPipelineFeatures, defaultDocumentExtractionConfig } = await import("@docslurp/shared");
  const { WorkflowState } = await import("../pipeline/pipeline.js");
  const dir = await mkdtemp(path.join(tmpdir(), "vm-figures-stage-"));
  const sourcePath = path.join(dir, "source.pdf");
  await writeFile(sourcePath, "trusted test input; VM faked");
  const objects = new Map<string, { bytes: Buffer; type?: string }>();
  const json = new Map<string, any>();
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array, type: string) => { objects.set(key, { bytes: Buffer.from(data), type }); },
    putJson: async (key: string, value: unknown) => { json.set(key, value); },
    streamText: async (key: string, value: string) => { objects.set(key, { bytes: Buffer.from(value) }); },
    streamToStorage: async (key: string, stream: AsyncIterable<Buffer>) => { const parts: Buffer[] = []; for await (const b of stream) parts.push(b); objects.set(key, { bytes: Buffer.concat(parts) }); },
    createMultipartUploadStream: (key: string) => {
      const parts: Buffer[] = [];
      const writable = new Writable({ write(chunk, _enc, cb) { parts.push(Buffer.from(chunk)); cb(); } });
      const done = new Promise<void>((resolve, reject) => { writable.on("finish", () => { objects.set(key, { bytes: Buffer.concat(parts) }); resolve(); }); writable.on("error", reject); });
      return { writable, done };
    },
  };
  const jobs: any[] = [];
  const run = vi.fn(async (plan: any) => {
    jobs.push(structuredClone(plan.sandboxedPdf));
    await writeFile(plan.sandboxedPdf.output, MARKDOWN);
    const result = await vm(plan.sandboxedPdf);
    acceptSandboxedPdfResult(plan.sandboxedPdf, { stdout: "", stderr: "", exitCode: 0, ...result }, 5);
    return { stdout: "", stderr: "" };
  });
  const runner = { sandboxedPdfMarkdown: async (input: string, output: string) => ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }), run };
  const stage = new ExtractMarkdownStage(runner as any, storage as any, {} as any);
  const internals = stage as any;
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "a".repeat(64) }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.recordPageImageEvidence = async () => null;
  const doc = { id: DOC_ID, userId: "u", runId: "r", filename: "source.pdf", mimeType: "application/pdf", sourceKey: "u/source.pdf", status: "processing", extractionMode: "hybrid", pageCount: 5, createdAt: new Date(), updatedAt: new Date() };
  const state = WorkflowState.create({ id: "r", orgId: "o", userId: "u", kind: "bulk-upload", status: "processing", stage: "extract-markdown", totalDocuments: 1, processedDocuments: 0, pagesTotal: 5, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, quality: "fast", markdownExtraction: true, visionFallback: false,
      documentExtraction: { ...defaultDocumentExtractionConfig, order: { pdf: ["vm-pdf"] } } },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date() } as any, [doc as any]);
  state.artifactLedger.recordDocument(DOC_ID, "normalizedFormat", "pdf");
  try {
    await stage.run(state);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const stageState = state.documentStage(DOC_ID, "extract-markdown");
  const ledger = state.artifactLedger.all() as Record<string, string>;
  const markdown = [...objects.entries()].find(([key]) => key === `u/r/markdown/${DOC_ID}.vm-pdf.md`)?.[1].bytes.toString();
  return { jobs, objects, json, stageState, ledger, markdown };
}

const figureRoot = `u/r/doppler-figures/${DOC_ID}`;

beforeEach(() => resetExtractorPluginsForTest());
afterEach(() => { resetExtractorPluginsForTest(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Doppler figures in the extraction stage", () => {
  it("flag off: no figure request, no figure objects or slots, Markdown unchanged", async () => {
    registerProvider(true);
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "");
    const out = await runStage(async () => ({}));
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0].figures).toBeUndefined();
    expect(out.stageState?.status).toBe("completed");
    expect(out.stageState?.stats?.dopplerFigures).toBeUndefined();
    expect([...out.objects.keys()].some((key) => key.includes("doppler-figures"))).toBe(false);
    expect(Object.keys(out.ledger).some((slot) => slot.includes("doppler-figure"))).toBe(false);
    expect(out.markdown).toBe(MARKDOWN);
  });

  it("flag on: validates the folder, stores figures under the document root with fixed types and records each slot", async () => {
    registerProvider(true);
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "1");
    const out = await runStage(async (job) => {
      await cp(FIXTURE, job.figures.dir, { recursive: true });
      return { figures: { status: "extracted", confined: false } };
    });
    expect(out.stageState?.stats?.dopplerFigures).toMatchObject({ imagesConfined: false });
    expect(out.jobs[0].figures.dir).toMatch(/\.doppler-figures-/);
    expect(out.stageState?.status).toBe("completed");
    expect(out.objects.get(`${figureRoot}/p3.1.webp`)?.type).toBe("image/webp");
    expect(out.objects.get(`${figureRoot}/p3.g2.svg`)?.type).toBe("image/svg+xml");
    expect(out.objects.get(`${figureRoot}/p5.g1.png`)?.type).toBe("image/png");
    expect(out.ledger[`${DOC_ID}:doppler-figure:p3.g2`]).toBe(`s3://test/${figureRoot}/p3.g2.svg`);
    expect(out.ledger[`${DOC_ID}:doppler-figures`]).toBe(`s3://test/${figureRoot}/index.json`);
    expect(out.json.get(`${figureRoot}/index.json`).markers).toEqual(["p3.1", "p3.g2", "p4.1"]);
    expect(out.stageState?.stats?.dopplerFigures).toMatchObject({ status: "stored", files: 3, markers: 3, markersResolved: 3 });
    // The stored Markdown is Doppler's, byte for byte: markers resolve at read time.
    expect(out.markdown).toBe(MARKDOWN);
  });

  it("Doppler exit 5: keeps the Markdown, stores no figure, and the raw reason goes to the log only", async () => {
    registerProvider(true);
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "1");
    const warn = vi.spyOn(console, "warn");
    const out = await runStage(async () => ({ figures: { status: "failed", reason: "pdfregions: limit hit (memory)", confined: true } }));
    expect(out.stageState?.status).toBe("completed");
    expect(out.markdown).toBe(MARKDOWN);
    expect([...out.objects.keys()].some((key) => key.includes("doppler-figures"))).toBe(false);
    expect(Object.keys(out.ledger).some((slot) => slot.includes("doppler-figure"))).toBe(false);
    expect(out.stageState?.stats?.dopplerFigures).toEqual({ status: "extraction-failed", imagesConfined: true });
    expect(JSON.stringify(out.stageState?.stats)).not.toContain("pdfregions");
    expect(warn.mock.calls.some(([line]) => String(line).includes("[doppler-figures]") && String(line).includes("pdfregions: limit hit (memory)"))).toBe(true);
  });

  it("a hostile folder is refused whole: the document completes with no figures", async () => {
    registerProvider(true);
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "1");
    const out = await runStage(async (job) => {
      await cp(FIXTURE, job.figures.dir, { recursive: true });
      await writeFile(path.join(job.figures.dir, "p3.1.webp"), "<html>not a webp</html>");
      return { figures: { status: "extracted" } };
    });
    expect(out.stageState?.status).toBe("completed");
    expect(out.stageState?.stats?.dopplerFigures).toEqual({ status: "rejected", rule: "size-mismatch", imagesConfined: null });
    expect([...out.objects.keys()].some((key) => key.includes("doppler-figures"))).toBe(false);
    expect(out.markdown).toBe(MARKDOWN);
  });
});
