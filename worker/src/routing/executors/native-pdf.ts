/**
 * Executors for the neutral native-pdf targets (`native:pdf-markdown`, `native:pdf-text`,
 * `ocr:pdf-ocr-fill`, `ocr:pdf-ocr`) plus the generic per-page native extractor shared with
 * `native:kreuzberg`. The engine behind them is a swappable adapter
 * (worker/src/native-pdf); nothing here names it.
 */

import {
  NATIVE_PDF_MARKDOWN_TARGET_ID,
  NATIVE_PDF_OCR_FILL_TARGET_ID,
  NATIVE_PDF_OCR_TARGET_ID,
  NATIVE_PDF_TEXT_TARGET_ID,
} from "@docslurp/shared";

import { isUnsupported, logNativePdfFallback } from "../../native-pdf/types.js";

import {
  NATIVE_OTHER_SCRIPT_MIN,
  TESSERACT_WORDLIKE_MIN,
  nativeOcrDropout,
  otherScriptShare,
  wordLikeShare,
} from "./ocr-policy.js";
import {
  baseOutput,
  type ExecutionRequest,
  type ExecutorDeps,
  type ExecutorOutput,
  type NativePdfOcrResult,
  type RasterRef,
  type TargetExecutor,
} from "./types.js";

/** `deps.nativePageText` extractor ids served by the native-pdf engine. */
export const NATIVE_PDF_MARKDOWN_EXTRACTOR = "native-pdf-markdown";
export const NATIVE_PDF_TEXT_EXTRACTOR = "native-pdf-text";

/**
 * Native extractors per page. The extractor runs per page when the adapter supports it; when
 * it does not (kreuzberg is document-level, or the native-pdf engine is absent), the canonical
 * document's text for the page is the slice.
 */
export function nativeExtractor(id: string, extractorId: string): TargetExecutor {
  return {
    id,
    needsRaster: false,
    async run(request, deps) {
      const started = Date.now();
      const page = request.assignment.pageNumber;
      const native = await deps.nativePageText(extractorId, page);
      if (native !== null && native.trim() !== "") {
        return { ...baseOutput(request), text: native, model: extractorId, runtime: "native", latencyMs: Date.now() - started };
      }
      const slice = await deps.pageText(page);
      if (slice === null) return null;
      return {
        ...baseOutput(request),
        text: slice,
        model: extractorId,
        runtime: "native",
        latencyMs: Date.now() - started,
        fallback: "canonical-page-slice",
      };
    },
  };
}

/**
 * The request's raster, fetched only when needed: the page, or the assignment's region/image crop (a native clip
 * render when PDF_RASTER_ENGINE serves it, else the full-page raster cut down).
 */
async function withScopedRaster<T>(request: ExecutionRequest, deps: ExecutorDeps, fn: (raster: RasterRef) => Promise<T>): Promise<T | null> {
  if (request.raster) return await fn(request.raster);
  const pageNumber = request.assignment.pageNumber;
  const scope = request.assignment.scope;
  const bbox = scope.kind === "page" ? undefined : scope.bbox;
  if (!bbox || !(bbox.width > 0 && bbox.height > 0)) return await deps.withRaster(pageNumber, fn);
  const clipped = deps.withPageClip ? await deps.withPageClip(pageNumber, bbox, fn) : null;
  if (clipped !== null) return clipped;
  return await deps.withRaster(pageNumber, (raster) => deps.withCrop(raster, bbox, fn));
}

type TesseractResult = { text: string; latencyMs: number; model: string };

/**
 * Page OCR for the `ocr:pdf-ocr-fill` / `ocr:pdf-ocr` targets. Tesseract on the page raster is primary (see
 * ocr-policy.ts for the evidence). With NATIVE_PDF_OCR=scripts (default) the native-pdf engine runs only when
 * tesseract's output does not look like words in its languages, and serves the page only when its own output is
 * mostly another script and passes the dropout guard. NATIVE_PDF_OCR=prefer runs the engine first (guarded, with
 * tesseract as fallback and cross-check); off never calls it. The engine OCRs the whole page from the source, so
 * image/region assignments always use tesseract on their crop. Without OCR models the engine rejects
 * NATIVE_PDF_UNSUPPORTED and tesseract serves silently; other engine errors fall back with a warning.
 */
function nativePdfOcr(id: string, mode: "fill" | "full"): TargetExecutor {
  return {
    id,
    needsRaster: false,
    async run(request, deps, signal): Promise<ExecutorOutput | null> {
      const pageNumber = request.assignment.pageNumber;
      const tesseract = async (): Promise<TesseractResult | null> =>
        await withScopedRaster(request, deps, (raster) => deps.ocr(raster, { pageNumber, signal }));
      const fromTesseract = (result: TesseractResult, fallback?: string): ExecutorOutput => ({
        ...baseOutput(request),
        text: result.text,
        model: result.model,
        runtime: "tesseract",
        latencyMs: result.latencyMs,
        fallback: fallback ?? "ocr:tesseract",
      });
      const policy = deps.nativeOcrPolicy ?? "scripts";
      if (!deps.nativePdfOcr || policy === "off" || request.assignment.scope.kind !== "page") {
        const result = await tesseract();
        return result ? fromTesseract(result) : null;
      }

      const native = async () => {
        try {
          const out = await deps.nativePdfOcr!({ pageNumber, mode, signal });
          return out && out.markdown.trim() !== "" ? out : null;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!isUnsupported(error)) logNativePdfFallback(`ocr page=${pageNumber}`, error, "tesseract");
          return null;
        }
      };
      const layerChars = async () => ((await deps.pageText(pageNumber)) ?? "").replace(/\s+/g, "").length;
      const fromNative = (out: NativePdfOcrResult): ExecutorOutput => ({
        ...baseOutput(request), text: out.markdown, model: out.engine, runtime: "native", latencyMs: out.latencyMs,
      });
      const rejected = (reason: string) => console.warn(`[native-pdf] ocr page=${pageNumber} rejected reason=${reason} next=tesseract`);

      if (policy === "scripts") {
        const primary = await tesseract();
        if (primary && wordLikeShare(primary.text) >= TESSERACT_WORDLIKE_MIN) return fromTesseract(primary);
        const out = await native();
        if (out && otherScriptShare(out.markdown) >= NATIVE_OTHER_SCRIPT_MIN) {
          const verdict = nativeOcrDropout({ output: out.markdown, layerChars: await layerChars(), pageAreaIn2: out.pageAreaIn2 ?? null, crossCheckChars: null });
          if (verdict.ok) return fromNative(out);
          rejected(verdict.reason);
        }
        return primary ? fromTesseract(primary) : null;
      }

      // prefer: engine first, guarded.
      const out = await native();
      if (out) {
        const expected = await layerChars();
        let verdict = nativeOcrDropout({ output: out.markdown, layerChars: expected, pageAreaIn2: out.pageAreaIn2 ?? null, crossCheckChars: null });
        if (!verdict.ok && verdict.reason === "low-density") {
          const check = await tesseract();
          verdict = nativeOcrDropout({ output: out.markdown, layerChars: expected, pageAreaIn2: out.pageAreaIn2 ?? null, crossCheckChars: check ? check.text.replace(/\s+/g, "").length : 0 });
          if (verdict.ok) return fromNative(out);
          rejected(verdict.reason);
          return check ? fromTesseract(check, "ocr:tesseract-dropout") : null;
        }
        if (verdict.ok) return fromNative(out);
        rejected(verdict.reason);
      }
      const result = await tesseract();
      return result ? fromTesseract(result, out ? "ocr:tesseract-dropout" : undefined) : null;
    },
  };
}

export const nativePdfExecutors: TargetExecutor[] = [
  nativeExtractor(NATIVE_PDF_MARKDOWN_TARGET_ID, NATIVE_PDF_MARKDOWN_EXTRACTOR),
  nativeExtractor(NATIVE_PDF_TEXT_TARGET_ID, NATIVE_PDF_TEXT_EXTRACTOR),
  nativePdfOcr(NATIVE_PDF_OCR_FILL_TARGET_ID, "fill"),
  nativePdfOcr(NATIVE_PDF_OCR_TARGET_ID, "full"),
];
