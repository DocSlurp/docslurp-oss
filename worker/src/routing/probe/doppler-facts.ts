/**
 * Doppler page facts (validated by lib/doppler-page-facts.ts) as the v2 router's `ProbeRow`, so `pageInputFromProbeRow`
 * reads them like a probe row. Pure: no I/O, no rendering (`thumbnail` is always absent), `probeEngine: "doppler-facts"`.
 *
 * Field by field (ProbeRow ← facts; "0 when absent" means the family was not computed, as the probe's failed row does):
 * - `pageNumber` ← `page`; `pageCount` ← the host's own count (never the facts' `pageCount`).
 * - `charCount`, `wordCount`, `textCoverage` ← `text`; `textFacts.wordCount` ← `text.wordCount` (null without `text`).
 * - `fontCount` ← `fonts.count`; `smallestFontPt` ← `fonts.smallestPt` (null when absent).
 * - `unmappedGlyphRatio` ← the larger of `fonts.unmappedGlyphRatio` and `text.replacementCharRatio + privateUseRatio` (the
 *   probe counts U+FFFD and private-use characters as unmapped).
 * - `mathGlyphRatio` ← `text.mathGlyphRatio` (`oddtext`).
 * - `garbled` ← at least 20 characters and unmapped > 0.1 or control characters > 0.4 (the probe's printable-share test,
 *   from the ratios facts carry).
 * - `tableRuleScore` ← min(`vectors.hRules`, `vectors.vRules`), as the native probe computes it from rule counts.
 * - `imageCoverage`, `largestImageCoverage`, `fullPageImage`, `imageCount` ← `images`; `images[]` ← `images.items` boxes.
 * - `vectorDrawingCount` ← `vectors.paths`; `uncoveredVectorRatio` ← `vectors.uncoveredRatio`.
 * - `invisibleTextRatio` ← `text.invisibleCharCount / charCount`; `textOverImageRatio` ← `text.textOverImageRatio`.
 * - `textLayerStatus` ← the probe's rule (features.ts textLayerStatus) on these values, then `ocr-layer` for text over a page
 *   image (isOcrLayer) or an all-invisible layer over a full-page image (`invisibleOverFullPageImage`), and `suspect` for an
 *   `ok` layer drawn with `no-tounicode` fonts. `unknown` without the `text` family.
 * - `widthPt`, `heightPt`, `rotation` ← `geometry` (612 × 792, 0 when absent, as the probe's failed row).
 * - `unusualFeatures` ← page and doc features, renamed to the probe's vocabulary (`javascript-present` → `javascript`,
 *   `embedded-files` → `attachment`); `needsAttention` from the probe's ATTENTION_FEATURES.
 * - `probeMs` ← `factsMs` (0 without timing).
 * Facts cannot supply `ocrLayerCheck` (no OCR runs) or `thumbnail` (no rendering).
 */
import type { DopplerDocFacts, DopplerPageFacts, DopplerPageFactsDocument } from "../../lib/doppler-page-facts.js";
import type { ProbeRow } from "../page-input.js";
import { isOcrLayer, textLayerStatus } from "./features.js";
import { ATTENTION_FEATURES } from "./unusual.js";

export const DOPPLER_FACTS_PROBE_ENGINE = "doppler-facts";

const FEATURE_NAMES: Record<string, string> = { "javascript-present": "javascript", "embedded-files": "attachment" };

function features(page: DopplerPageFacts | null, doc: DopplerDocFacts): string[] {
  const out = new Set<string>();
  for (const name of [...doc.unusualFeatures, ...(page?.unusualFeatures ?? [])]) out.add(FEATURE_NAMES[name] ?? name);
  if (page?.failed) out.add("probe-error");
  return [...out].sort();
}

const round = (value: number, digits: number) => { const f = 10 ** digits; return Math.round(value * f) / f; };

/** One page as a probe row. A failed page becomes the probe's failed row shape (`unknown` layer, needs attention). */
export function probeRowFromDopplerPage(page: DopplerPageFacts, doc: DopplerDocFacts, pageCount: number): ProbeRow {
  const t = page.failed ? undefined : page.text;
  const img = page.failed ? undefined : page.images;
  const vec = page.failed ? undefined : page.vectors;
  const fonts = page.failed ? undefined : page.fonts;
  const geo = page.failed ? undefined : page.geometry;
  const chars = t?.charCount ?? 0;
  const words = t?.wordCount ?? 0;
  const textUnmapped = Math.min(1, (t?.replacementCharRatio ?? 0) + (t?.privateUseRatio ?? 0));
  const unmapped = Math.max(fonts?.unmappedGlyphRatio ?? 0, textUnmapped);
  const garbled = chars >= 20 && (unmapped > 0.1 || (t?.controlCharRatio ?? 0) > 0.4);
  const imageCoverage = img?.imageCoverage ?? 0;
  const unusual = features(page, doc);
  let status: ProbeRow["textLayerStatus"] = "unknown";
  if (t) {
    status = textLayerStatus(chars, words, unmapped, garbled, imageCoverage);
    const overImage = t.textOverImageRatio;
    if ((status === "ok" || status === "suspect") &&
        ((overImage !== undefined && isOcrLayer(overImage, words)) || (t.textLayer === "invisible" && t.invisibleOverFullPageImage === true))) {
      status = "ocr-layer";
    }
    if (status === "ok" && unusual.includes("no-tounicode")) status = "suspect";
  }
  const imageCount = img?.imageCount ?? 0;
  return {
    pageNumber: page.page,
    pageCount,
    charCount: chars,
    wordCount: words,
    textCoverage: t?.textCoverage ?? 0,
    fontCount: fonts?.count ?? 0,
    unmappedGlyphRatio: round(unmapped, 5),
    mathGlyphRatio: t?.mathGlyphRatio ?? 0,
    tableRuleScore: vec ? Math.min(vec.hRules, vec.vRules) : 0,
    imageCoverage,
    largestImageCoverage: img?.largestImageCoverage ?? 0,
    fullPageImage: img?.fullPageImage ?? false,
    vectorDrawingCount: vec?.paths ?? 0,
    uncoveredVectorRatio: vec?.uncoveredRatio ?? 0,
    garbled,
    textLayerStatus: status,
    imageCount,
    textFacts: {
      wordCount: t ? words : null,
      imageCount: img ? imageCount : null,
      imageCoverage: img ? imageCoverage : null,
      textLayerStatus: status,
    },
    ...(t ? { invisibleTextRatio: chars ? round(t.invisibleCharCount / chars, 4) : 0 } : {}),
    ...(t?.textOverImageRatio !== undefined ? { textOverImageRatio: t.textOverImageRatio } : {}),
    images: (img?.items ?? []).map((item) => ({ bbox: [...item.bbox] as [number, number, number, number], coverage: item.coverage })),
    smallestFontPt: fonts?.smallestPt ?? null,
    widthPt: geo?.widthPt ?? 612,
    heightPt: geo?.heightPt ?? 792,
    rotation: geo?.rotation ?? 0,
    probeMs: page.factsMs ?? 0,
    unusualFeatures: unusual,
    needsAttention: unusual.some((name) => ATTENTION_FEATURES.has(name)) || unusual.includes("probe-error"),
    probeEngine: DOPPLER_FACTS_PROBE_ENGINE,
  };
}

/**
 * Probe rows for every known page, ascending. `pageCount` is the host's count. A locked document gives the probe's single
 * locked row; an unreadable one (`error`) gives none, as the native probe throws for it.
 */
export function probeRowsFromDopplerFacts(facts: Pick<DopplerPageFactsDocument, "doc" | "pages">, pageCount: number): ProbeRow[] {
  if (facts.doc.locked) {
    const unusual = [...new Set(["encrypted-user-password", ...features(null, facts.doc)])].sort();
    return [{
      pageNumber: 1, pageCount: 1, charCount: 0, wordCount: 0, textCoverage: 0, fontCount: 0, unmappedGlyphRatio: 0, mathGlyphRatio: 0,
      tableRuleScore: 0, imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false, vectorDrawingCount: 0, uncoveredVectorRatio: 0,
      garbled: false, textLayerStatus: "unknown", imageCount: 0,
      textFacts: { wordCount: null, imageCount: null, imageCoverage: null, textLayerStatus: "unknown" },
      images: [], smallestFontPt: null, widthPt: 612, heightPt: 792, rotation: 0, probeMs: 0,
      unusualFeatures: unusual, needsAttention: true, locked: true, probeEngine: DOPPLER_FACTS_PROBE_ENGINE,
    }];
  }
  if (facts.doc.error) return [];
  return [...facts.pages.values()].filter((page) => page.page <= pageCount).sort((a, b) => a.page - b.page)
    .map((page) => probeRowFromDopplerPage(page, facts.doc, pageCount));
}
