import type { PerformanceEvent } from "../models.js";
import { extractNativePdf } from "./extract.js";
import { nativePdfAdapterVersion } from "./loader.js";
import { toNativePdfError, type NativePdfEngine } from "./types.js";

export const NATIVE_PDF_SHADOW_METRIC = "native-pdf-shadow";

const tokens = (text: string): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
};

/** Bag-of-words F1 between two pages; two empty pages agree. */
export function pageAgreement(reference: string, candidate: string): number {
  const a = tokens(reference);
  const b = tokens(candidate);
  const sizeA = [...a.values()].reduce((s, n) => s + n, 0);
  const sizeB = [...b.values()].reduce((s, n) => s + n, 0);
  if (sizeA === 0 && sizeB === 0) return 1;
  if (sizeA === 0 || sizeB === 0) return 0;
  let overlap = 0;
  for (const [token, n] of a) overlap += Math.min(n, b.get(token) ?? 0);
  const precision = overlap / sizeB;
  const recall = overlap / sizeA;
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export interface NativePdfShadowArgs {
  engine: NativePdfEngine;
  sourcePath: string;
  documentId: string;
  stageName: string;
  /**
   * Per-page Markdown the primary extractor produced (page i = index i), or
   * null when it carries no page boundaries; then only the document row is
   * recorded, compared against the joined text.
   */
  referencePages: string[] | null;
  referenceText: string;
  referenceExtractor: string;
  referenceMs?: number;
  signal?: AbortSignal;
  emphasis?: boolean;
}

/**
 * Run the engine beside the primary extractor and return performance rows;
 * never throws and never alters extraction output. Failures become a single
 * error row so shadow coverage stays measurable.
 */
export async function runNativePdfShadow(args: NativePdfShadowArgs): Promise<PerformanceEvent[]> {
  const adapter = nativePdfAdapterVersion(args.engine);
  const base = { documentId: args.documentId, stageName: args.stageName, tags: ["native-pdf", "shadow"] };
  try {
    const result = await extractNativePdf(args.engine, args.sourcePath, { signal: args.signal, emphasis: args.emphasis });
    const referencePages = args.referencePages;
    const rows: PerformanceEvent[] = (referencePages ? result.pages : []).map((page) => {
      const reference = referencePages![page.pageNumber - 1] ?? "";
      return {
        ...base,
        scope: "page",
        metric: NATIVE_PDF_SHADOW_METRIC,
        pageNumber: page.pageNumber,
        value: pageAgreement(reference, page.markdown),
        unit: "agreement",
        metadata: {
          adapter,
          referenceExtractor: args.referenceExtractor,
          nativeMs: Math.round(page.ms * 100) / 100,
          nativeChars: page.markdown.length,
          referenceChars: reference.length,
          repairs: page.repairs,
          warnings: page.warnings,
        },
      };
    });
    const mean = rows.length > 0
      ? rows.reduce((s, r) => s + r.value, 0) / rows.length
      : pageAgreement(args.referenceText, result.pages.map((page) => page.markdown).join("\n"));
    rows.push({
      ...base,
      scope: "document",
      metric: NATIVE_PDF_SHADOW_METRIC,
      value: mean,
      unit: "agreement",
      metadata: {
        adapter,
        referenceExtractor: args.referenceExtractor,
        pages: result.pageCount,
        perPage: referencePages !== null,
        nativeMs: Math.round(result.totalMs),
        referenceMs: args.referenceMs ?? null,
        warnings: result.warnings,
      },
    });
    console.error(
      `[native-pdf] shadow document=${args.documentId} pages=${result.pageCount} agreement=${mean.toFixed(3)} ms=${Math.round(result.totalMs)}`,
    );
    return rows;
  } catch (error) {
    const failure = toNativePdfError(error);
    return [{
      ...base,
      scope: "document",
      metric: NATIVE_PDF_SHADOW_METRIC,
      value: 0,
      unit: "error",
      metadata: {
        adapter,
        referenceExtractor: args.referenceExtractor,
        code: failure.code,
        kind: failure.kind,
        ...(failure.engineCode ? { engineCode: failure.engineCode } : {}),
        ...(failure.limit ? { limit: failure.limit } : {}),
        reason: failure.message.slice(0, 300),
      },
    }];
  }
}
