/**
 * doppler-page-facts/1 lines built from Doppler's JSON Schema (docslurp/page-facts/doppler-page-facts-1.schema.json): every
 * family at full level, with values a real run writes. Tests mutate copies of these.
 */
export const SCHEMA = "doppler-page-facts/1";
/** A document string Doppler copies from the Info dictionary: must never be stored anywhere. */
export const PRODUCER_MARKER = "PRODUCER-MARKER-7f3a <script>alert(1)</script>";

export function docLine(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SCHEMA, type: "doc", level: "full", pageCount: 3, pdfVersion: "1.7", linearized: false, xref: "ok", encryption: "none",
    incrementalUpdates: 0, tagged: true, markedContent: true, lang: "en-US", outlineCount: 4, pageLabels: false, embeddedFiles: 0,
    javascript: false, openAction: false, launchAction: false, producer: PRODUCER_MARKER, creator: `${PRODUCER_MARKER} creator`,
    acroForm: "present", needAppearances: false, xfa: "none", ocgCount: 1, ocgOffByDefault: 1, unusualFeatures: [], ...extra,
  };
}

/** Page 1: a text page with a ruled table and a logo. */
export function textPage(page = 1, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SCHEMA, type: "page", page,
    geometry: { widthPt: 612, heightPt: 792, rotation: 0, userUnit: 1 },
    text: {
      charCount: 2400, visibleCharCount: 2400, invisibleCharCount: 0, wordCount: 410, visibleWordCount: 410, invisibleWordCount: 0,
      textLayer: "visible", textCoverage: 0.6211, clippedCharCount: 0, controlCharRatio: 0, privateUseRatio: 0, replacementCharRatio: 0,
      mathGlyphRatio: 0.0125, verticalCharRatio: 0, rotatedTextRatio: 0, textOverImageRatio: 0,
    },
    fonts: { count: 3, smallestPt: 8, type3: 0, nonEmbedded: 0, cid: 0, noToUnicode: 0, glyphCount: 2400, unmappedGlyphRatio: 0, ocrFontHint: false, truncated: false },
    images: {
      imageCount: 1, imageCoverage: 0.0105, largestImageCoverage: 0.0103, fullPageImage: false, scan: "none", maskCount: 0, inlineCount: 0,
      items: [{ index: 1, bbox: [36, 36, 108, 72], coverage: 0.0103, px: [300, 150], dpi: [300, 300], filter: "flate", bpc: 8, colorSpace: "rgb",
        imageMask: false, softMask: true, mask: false, decode: false, inline: false, obj: 42, copy: "render" }],
      itemsTruncated: false, truncated: false,
    },
    vectors: {
      paths: 64, filled: 10, stroked: 54, coverage: 0.25, uncoveredRatio: 0.1, hRules: 8, vRules: 5, ruleGridScore: 1, shadings: 0, patterns: 0,
      clips: 2, figureClusters: 0, clusters: [], clustersTruncated: false, limitHit: false,
    },
    forms: { fields: 2, text: 1, checkbox: 1, radio: 0, choice: 0, signature: 0, pushButton: 0, filled: 1, empty: 1, valueAppearanceMismatch: 0, signed: 0, unsigned: 0, truncated: false },
    annots: { count: 3, bySubtype: { link: 2, widget: 1 }, linkUri: 1, linkInternal: 1, linkOther: 0, visibleAppearance: 1, truncated: false },
    layers: { hiddenContent: false, visibleContent: true, hiddenOps: 0, visibleOps: 12 },
    parseWarnings: [], unusualFeatures: ["acroform-filled", "link-internal", "link-uri", "ocg-visible"], factsMs: 1.25,
    ...extra,
  };
}

/** Page 2: a scan with an invisible OCR layer, and the same logo. */
export function scanPage(page = 2, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: SCHEMA, type: "page", page,
    geometry: { widthPt: 612, heightPt: 792, rotation: 90, userUnit: 1, mediaBox: [0, 0, 792, 612], cropBox: [0, 0, 792, 612] },
    text: {
      charCount: 1800, visibleCharCount: 0, invisibleCharCount: 1800, wordCount: 300, visibleWordCount: 0, invisibleWordCount: 300,
      textLayer: "invisible", textCoverage: 0.55, clippedCharCount: 0, controlCharRatio: 0, privateUseRatio: 0, replacementCharRatio: 0,
      mathGlyphRatio: 0, verticalCharRatio: 0, rotatedTextRatio: 0, textOverImageRatio: 1, invisibleOverFullPageImage: true,
    },
    fonts: { count: 1, smallestPt: 9.5, type3: 0, nonEmbedded: 0, cid: 0, noToUnicode: 0, glyphCount: 1800, unmappedGlyphRatio: 0, ocrFontHint: true, truncated: false },
    images: {
      imageCount: 2, imageCoverage: 1, largestImageCoverage: 1, fullPageImage: true, scan: "single", scanImage: 1, maskCount: 0, inlineCount: 0,
      items: [
        { index: 1, bbox: [0, 0, 612, 792], coverage: 1, px: [2550, 3300], dpi: [300, 300], filter: "ccitt", bpc: 1, colorSpace: "gray",
          imageMask: false, softMask: false, mask: false, decode: false, inline: false, obj: 7, copy: "bilevel" },
        { index: 2, bbox: [36, 36, 108, 72], coverage: 0.0103, px: [300, 150], dpi: [300, 300], filter: "flate", bpc: 8, colorSpace: "rgb",
          imageMask: false, softMask: true, mask: false, decode: false, inline: false, obj: 42, copy: "render" },
      ],
      itemsTruncated: false, truncated: false,
    },
    vectors: {
      paths: 0, filled: 0, stroked: 0, coverage: 0, hRules: 0, vRules: 0, ruleGridScore: 0, shadings: 0, patterns: 0, clips: 0,
      figureClusters: 0, clusters: [], clustersTruncated: false, limitHit: false,
    },
    forms: { fields: 0, text: 0, checkbox: 0, radio: 0, choice: 0, signature: 0, pushButton: 0, filled: 0, empty: 0, valueAppearanceMismatch: 0, signed: 0, unsigned: 0, truncated: false },
    annots: { count: 0, bySubtype: {}, linkUri: 0, linkInternal: 0, linkOther: 0, visibleAppearance: 0, truncated: false },
    layers: { hiddenContent: false, visibleContent: false, hiddenOps: 0, visibleOps: 0 },
    parseWarnings: [], unusualFeatures: ["rotated-page", "scan-page"], factsMs: 2.5,
    ...extra,
  };
}

/** Page 3: a vector drawing with figure clusters and the logo again. */
export function figurePage(page = 3, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = textPage(page);
  return {
    ...base,
    text: { ...(base.text as object), charCount: 40, visibleCharCount: 40, wordCount: 8, visibleWordCount: 8, textCoverage: 0.02 },
    vectors: {
      paths: 900, filled: 300, stroked: 600, coverage: 0.5, uncoveredRatio: 0.92, hRules: 1, vRules: 0, ruleGridScore: 0, shadings: 1,
      patterns: 0, clips: 3, figureClusters: 1, clusters: [{ bbox: [72, 100, 540, 500], paths: 880, curves: 300, segments: 2000 }],
      clustersTruncated: false, limitHit: false,
    },
    unusualFeatures: ["link-uri"],
    ...extra,
  };
}

export function runLine(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema: SCHEMA, type: "run", pagesEmitted: 3, pagesFailed: 0, version: "25.10.0", commit: "abc1234", ...extra };
}

export function jsonl(lines: Array<Record<string, unknown> | string>): string {
  return lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line)) + "\n").join("");
}

/** The full fixture: doc, three pages, run. */
export function fullFixture(): string {
  return jsonl([docLine(), textPage(), scanPage(), figurePage(), runLine()]);
}
