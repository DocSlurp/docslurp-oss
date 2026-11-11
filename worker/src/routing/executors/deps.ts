/**
 * Production ExecutorDeps: page text from the canonical document, per-page native-pdf text/Markdown, page
 * rasters from the shared raster cache, sharp crops, the OCR engine (in its VM, or the self-hosted sandbox) and Florence
 * tooling, and the vision stage's own per-image model call (usage ledger, cost, privacy gate).
 */

import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "../../tools/isolated-image.js";
import {
  canonicalDocumentSchema,
  type Assignment,
  type AssignmentRole,
  type BBox,
  type VisionConfig,
} from "@docslurp/shared";

import type { Document } from "../../models.js";
import type { PdfRasterCache } from "../../pipeline/pdf-asset-cache.js";
import type { VisionPageOutput } from "../../stages/vision-extract.js";
import type { CommandRunner } from "../../tools/runner.js";
import { cleanupTempFile, keyFromStorageUri, readJsonFile, type ArtifactStore } from "../../tools/storage.js";
import { trustedTempDownloadPattern } from "../../lib/temp-file-names.js";
import { readWithOcr, type OcrReadOutcome } from "../../ocr/engine.js";
import { escalateOcrPages } from "../../ocr/escalation.js";
import { ocrEscalationEnabled, type HostedOcrReader } from "../../ocr/hosted-reader.js";
import { OcrBoundaryFailure, OcrRefusedError, resolveOcrMode } from "../../ocr/mode.js";
import { extractNativePdfDocument } from "../../native-pdf/extract.js";
import { loadNativePdfEngine } from "../../native-pdf/loader.js";
import { logNativePdfFallback } from "../../native-pdf/types.js";
import type { NativePdfDocument } from "../../native-pdf/types.js";
import { budgetGuardDowngraded } from "../estimate.js";
import { readRoutingFlags } from "../flags.js";
import { visionConfigForModel } from "../routed-vision.js";
import { RASTER_PX_PER_POINT } from "./merge.js";
import { NATIVE_PDF_MARKDOWN_EXTRACTOR, NATIVE_PDF_TEXT_EXTRACTOR } from "./native-pdf.js";
import type { ExecutorDeps, NativePdfOcrResult, RasterRef } from "./types.js";
import { sniffedPdf } from "../../lib/sniffed-pdf.js";

export interface ProductionExecutorDepsInput {
  runId: string;
  document: Document;
  storage: Pick<ArtifactStore, "bucket" | "getJson" | "downloadToTempFile">;
  rasters: Pick<PdfRasterCache, "renderSelectedPages" | "sourcePath"> & Partial<Pick<PdfRasterCache, "renderClip">>;
  runner: Pick<CommandRunner, "plan" | "florence2" | "run" | "sandboxedOcrRead" | "localOcrRead">;
  /** The project OCR language setting (`auto` or language codes); unset reads the environment default. */
  ocrLanguage?: string;
  /** Ledger lookup for the document's canonical-document artifact uri. */
  canonicalUri: () => string | null;
  selection: VisionConfig;
  /** Privacy gate for a hosted model call (false refuses it). */
  allow: (vision: VisionConfig) => Promise<boolean>;
  /** Runs one image through a vision config, recording usage like any vision call. */
  callVision: (vision: VisionConfig, image: { imagePath: string; mimeType: string; pageNumber: number }, signal?: AbortSignal) => Promise<VisionPageOutput>;
  /** Cost-only usage row for a local model (the labeler). */
  recordLocalUsage: (event: { model: string; metric: string; pageNumber: number; latencyMs: number; outputChars: number }) => void;
  /**
   * Bills one router OCR read like every other OCR read (ocr/ledger.ts `recordOcrReads`): a Rich page for a page with
   * words, plus the job's compute event. `outcome.pages` carry the document page number.
   */
  recordOcrRead: (outcome: OcrReadOutcome) => void;
  /** The hosted escalation reader (ocr/hosted-reader.ts) for a page OCR read poorly; null disables escalation. */
  hostedReader?: HostedOcrReader | null;
  labelerModel?: string;
  /**
   * Chart export (chart-export/session.ts): serves a chart-data/diagram crop through the chart-export generator in
   * place of the role's vision prompt. `output` null with `modelCalled` false keeps the usual reading (nothing was
   * spent); with `modelCalled` true the generator already paid for this crop, so it is not read a second time.
   */
  exportVisual?: (args: {
    role: AssignmentRole;
    scope: Assignment["scope"];
    assignmentIndex: number;
    raster: RasterRef;
    pageNumber: number;
    signal?: AbortSignal;
  }) => Promise<ExportVisualOutcome>;
}

export type ExportVisualOutcome =
  | { output: VisionPageOutput; modelCalled: boolean }
  | { output: null; modelCalled: false }
  | { output: null; modelCalled: true; spent: VisionPageOutput };

/** Model label for router OCR reads in usage rows and route outputs. */
const OCR_MODEL = "ppocr-v6-small";

export interface ProductionExecutorDeps extends ExecutorDeps {
  /** Page height in points for pages whose raster was fetched (null otherwise). */
  pageHeightPt(pageNumber: number): number | null;
  dispose(): Promise<void>;
}

/**
 * Process-wide bound on concurrent native-pdf OCR calls (NATIVE_PDF_OCR_MAX_CONCURRENT, default 1; the engine's own
 * limit is set from the same variable by the loader).
 */
let nativeOcrActive = 0;
const nativeOcrQueue: Array<() => void> = [];
function nativeOcrLimit(): number {
  const n = Number.parseInt(process.env.NATIVE_PDF_OCR_MAX_CONCURRENT ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
export async function withNativeOcrSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (nativeOcrActive >= nativeOcrLimit()) {
    // The releasing call hands its slot straight to the next waiter, so the count never overshoots.
    await new Promise<void>((resolve) => nativeOcrQueue.push(resolve));
  } else {
    nativeOcrActive += 1;
  }
  try {
    return await fn();
  } finally {
    const next = nativeOcrQueue.shift();
    if (next) next();
    else nativeOcrActive -= 1;
  }
}

export function createProductionExecutorDeps(input: ProductionExecutorDepsInput): ProductionExecutorDeps {
  /** Clip render through the shared raster cache (null unless PDF_RASTER_ENGINE=native-pdf serves it). */
  async function clipToTemp<T>(pageNumber: number, bbox: BBox, fn: (crop: RasterRef) => Promise<T>): Promise<T | null> {
    if (!input.rasters.renderClip || !(bbox.width > 0 && bbox.height > 0)) return null;
    const clip = await input.rasters.renderClip({
      document: input.document,
      pageNumber,
      clip: [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height],
      dpi: Math.round(RASTER_PX_PER_POINT * 72),
    }).catch(() => null);
    if (!clip) return null;
    const cropPath = path.join(tmpdir(), `docslurp-router-clip-${randomUUID()}.${clip.mimeType === "image/jpeg" ? "jpg" : "png"}`);
    await writeFile(cropPath, clip.bytes);
    try {
      return await fn({ path: cropPath, mimeType: clip.mimeType, pageNumber });
    } finally {
      await rm(cropPath, { force: true });
    }
  }

  let pageTexts: Promise<Map<number, string> | null> | null = null;
  let nativePdfDoc: Promise<NativePdfDocument | null> | null = null;
  let nativePdfMarkdownPages: Promise<string[] | null> | null = null;
  const heights = new Map<number, number>();
  const temp: string[] = [];

  const loadPageTexts = (): Promise<Map<number, string> | null> => {
    pageTexts ??= (async () => {
      const uri = input.canonicalUri();
      const key = uri ? keyFromStorageUri(uri, input.storage.bucket) : null;
      if (!key) return null;
      const doc = canonicalDocumentSchema.parse(await input.storage.getJson<unknown>(key));
      const byPage = new Map<number, string[]>();
      for (const block of doc.blocks) {
        if (block.pageNumber === null || block.pageNumber === undefined) continue;
        byPage.set(block.pageNumber, [...(byPage.get(block.pageNumber) ?? []), block.text]);
      }
      return new Map([...byPage].map(([page, texts]) => [page, texts.join("\n\n")]));
    })().catch(() => null);
    return pageTexts;
  };

  /** The native-pdf engine's open document for this run's source, or null when no engine/PDF. */
  const openNativePdf = (): Promise<NativePdfDocument | null> => {
    nativePdfDoc ??= (async () => {
      if (!sniffedPdf(input.document)) return null;
      const loaded = await loadNativePdfEngine();
      if (!loaded.ok) return null;
      return await loaded.engine.openPath(await input.rasters.sourcePath(input.document));
    })().catch((error: unknown) => {
      logNativePdfFallback("router-open", error, "non-native page text");
      return null;
    });
    return nativePdfDoc;
  };

  /** Per-page repaired Markdown for the whole document, extracted once and cached. */
  const loadNativePdfMarkdown = (signal?: AbortSignal): Promise<string[] | null> => {
    nativePdfMarkdownPages ??= (async () => {
      const doc = await openNativePdf();
      const loaded = await loadNativePdfEngine();
      if (!doc || !loaded.ok) return null;
      const extraction = await extractNativePdfDocument(doc, loaded.engine.id, { signal });
      return extraction.pages.map((page) => page.markdown);
    })().catch((error: unknown) => {
      logNativePdfFallback("router-native-markdown", error, "non-native page text");
      return null;
    });
    return nativePdfMarkdownPages;
  };

  return {
    async pageText(pageNumber) {
      return (await loadPageTexts())?.get(pageNumber) ?? null;
    },

    async nativePageText(extractorId, pageNumber) {
      if (extractorId === NATIVE_PDF_MARKDOWN_EXTRACTOR) {
        return (await loadNativePdfMarkdown())?.[pageNumber - 1] ?? null;
      }
      if (extractorId === NATIVE_PDF_TEXT_EXTRACTOR) {
        const doc = await openNativePdf();
        if (!doc) return null;
        try {
          return await doc.page(pageNumber - 1).text();
        } catch (error) {
          logNativePdfFallback(`router-native-text page=${pageNumber}`, error, "non-native page text");
          return null;
        }
      }
      return null;
    },

    nativeOcrPolicy: readRoutingFlags().nativeOcr,

    async nativePdfOcr({ pageNumber, mode, dpi }): Promise<NativePdfOcrResult | null> {
      // The native engine OCRs inside the worker process: only customer-owned self-hosting (local mode) may use it.
      if (resolveOcrMode() !== "local") return null;
      const doc = await openNativePdf();
      if (!doc) return null;
      // One engine OCR at a time per process: each call holds ~400-500 MB outside WORKER_COMMAND_MAX_RSS_MB.
      return await withNativeOcrSlot(async () => {
        const started = Date.now();
        const page = doc.page(pageNumber - 1);
        // Rejects NATIVE_PDF_UNSUPPORTED without OCR models (NATIVE_PDF_OCR_MODEL_DIR); the executor then falls back.
        const out = await page.ocrFill({ policy: mode === "fill" ? "fill" : "adaptive", ...(dpi ? { dpi } : {}) });
        const latencyMs = Date.now() - started;
        const size = await page.size().catch(() => null);
        input.recordLocalUsage({ model: out.engine, metric: "ocr-native-pdf", pageNumber, latencyMs, outputChars: out.markdown.length });
        return {
          text: out.text, markdown: out.markdown, filledRegions: out.filledRegions, engine: out.engine, latencyMs,
          pageAreaIn2: size ? (size.widthPt / 72) * (size.heightPt / 72) : null,
        };
      });
    },

    async withRaster(pageNumber, fn) {
      const [page] = await input.rasters.renderSelectedPages({ document: input.document, runId: input.runId, pageNumbers: [pageNumber] });
      if (!page) return null;
      if (page.heightPx) heights.set(pageNumber, page.heightPx / RASTER_PX_PER_POINT);
      const imagePath = await input.storage.downloadToTempFile(
        page.artifactKey,
        trustedTempDownloadPattern("docslurp-router-raster-", input.document),
      );
      try {
        return await fn({ path: imagePath, mimeType: page.mimeType, pageNumber });
      } finally {
        await cleanupTempFile(imagePath);
      }
    },

    withPageClip: clipToTemp,

    async withCrop(raster, bbox: BBox, fn) {
      // Native raster engine: render just the clip from the source instead of cutting the full-page PNG.
      if (raster.pageNumber !== undefined) {
        const clipped = await clipToTemp(raster.pageNumber, bbox, async (crop) => ({ value: await fn(crop) }));
        if (clipped) return clipped.value;
      }
      const image = sharp(raster.path);
      const meta = await image.metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      const left = Math.max(0, Math.min(width - 1, Math.floor(bbox.x * RASTER_PX_PER_POINT)));
      const top = Math.max(0, Math.min(height - 1, Math.floor(bbox.y * RASTER_PX_PER_POINT)));
      const cropWidth = Math.max(1, Math.min(width - left, Math.ceil(bbox.width * RASTER_PX_PER_POINT)));
      const cropHeight = Math.max(1, Math.min(height - top, Math.ceil(bbox.height * RASTER_PX_PER_POINT)));
      const cropPath = `${raster.path}.crop-${left}-${top}.png`;
      await image.extract({ left, top, width: cropWidth, height: cropHeight }).png().toFile(cropPath);
      try {
        return await fn({ path: cropPath, mimeType: "image/png" } satisfies RasterRef);
      } finally {
        await rm(cropPath, { force: true });
      }
    },

    async ocr(raster, { pageNumber, signal }) {
      const started = Date.now();
      // The router's raster (already rendered for routing) is read in the OCR boundary; OCR itself renders and decodes
      // nothing on the host. In vm/local mode a failed or refused read throws OcrBoundaryFailure, which the executor
      // loop records as a failed page: neither the project-model fallback nor a cascade reads the page in OCR's place.
      // With OCR off or hosted (operator choices with no recogniser) the read is empty.
      const mode = resolveOcrMode();
      const hostedReader = input.hostedReader ?? null;
      let outcome: OcrReadOutcome;
      try {
        outcome = await readWithOcr(input.runner, {
          source: raster.path, kind: "image", pages: [1], escalation: Boolean(hostedReader) && ocrEscalationEnabled(),
          ...(input.ocrLanguage ? { languageSetting: input.ocrLanguage } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (mode === "vm" || mode === "local") {
          console.error(`[ocr] page=${pageNumber} router OCR failed in the ${mode} boundary: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
          throw new OcrBoundaryFailure(`OCR of page ${pageNumber} failed in the ${mode} boundary`, { cause: error });
        }
        if (!(error instanceof OcrRefusedError)) throw error;
        console.error(`[ocr] page=${pageNumber} router OCR refused (${error.reason}): ${error.message}`);
        return { text: "", latencyMs: Date.now() - started, model: OCR_MODEL };
      }
      try {
        // The raster is one frame; ledger rows and escalation name the document page.
        const read: OcrReadOutcome = { ...outcome, pages: outcome.pages.map((page) => Object.assign(page, { pageNumber })) };
        input.recordOcrRead(read);
        const page = read.pages[0];
        // A degraded or empty read goes to the hosted escalation reader, which applies the escalation opt-in and its
        // budget; never to the route's cascade or the project model. Without escalation the recogniser's read stands.
        if (page?.escalation && hostedReader) await escalateOcrPages(read, hostedReader, input.document.id, signal);
        const text = page?.text.trim() ?? "";
        const model = page?.recogniser.startsWith("escalated:") ? page.recogniser.slice("escalated:".length) : OCR_MODEL;
        return { text, latencyMs: Date.now() - started, model };
      } finally {
        await outcome.dispose();
      }
    },

    async label(raster, { pageNumber, signal }) {
      const started = Date.now();
      const model = input.labelerModel ?? readRoutingFlags().labelerModel;
      const outputPath = `${raster.path}.label.json`;
      const plan = await input.runner.florence2(raster.path, outputPath, "<CAPTION>", model);
      if (!plan.available) throw new Error(`local labeler unavailable: ${model}`);
      try {
        await input.runner.run(plan, signal);
        const payload = await readJsonFile<{ text?: string }>(outputPath);
        const text = (payload.text ?? "").trim();
        const latencyMs = Date.now() - started;
        input.recordLocalUsage({ model, metric: "image-label", pageNumber, latencyMs, outputChars: text.length });
        return { text, latencyMs, model };
      } finally {
        await rm(outputPath, { force: true });
      }
    },

    async vlm({ target, role, raster, pageNumber, scope, assignmentIndex, reason, signal }) {
      // A role the budget guard downgraded to a cheaper target keeps that target's read: the generator would re-spend
      // what the guard cut.
      const exportable = (role === "chart-data" || role === "diagram") && !budgetGuardDowngraded({ reason: reason ?? "" });
      if (input.exportVisual && scope && assignmentIndex !== undefined && exportable) {
        const exported = await input.exportVisual({ role, scope, assignmentIndex, raster, pageNumber, ...(signal ? { signal } : {}) });
        if (exported.output) return exported.output;
        // Generator calls were made and nothing usable came back: return their (empty) reading with its usage instead
        // of paying for a second vision read of the same crop. The merge drops empty inserts.
        if (exported.modelCalled) return exported.spent;
      }
      const modelUri = target.ref.modelUri;
      if (!modelUri) throw new Error(`target ${target.id} has no model uri`);
      const vision = visionConfigForModel(input.selection, modelUri, role);
      if (!(await input.allow(vision))) throw new Error(`privacy mode refuses ${target.id}`);
      return await input.callVision(vision, { imagePath: raster.path, mimeType: raster.mimeType, pageNumber }, signal);
    },

    pageHeightPt: (pageNumber) => heights.get(pageNumber) ?? null,

    async dispose() {
      await Promise.all(temp.map((file) => rm(file, { force: true })));
      const doc = await nativePdfDoc?.catch(() => null);
      await doc?.close().catch(() => undefined);
    },
  };
}
