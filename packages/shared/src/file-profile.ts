import { z } from "zod";

import { TEXT_PAGE_CHARS, TEXT_PAGE_LINES } from "./media-upload-estimate.js";
import { PAGE_AREA_EQUIVALENTS_CAP } from "./page-equivalents.js";

/*
 * File profiles: what the offline profiler (`@docslurp/estimate`, Rust/WASM) measures about a file on the customer's own
 * machine, and what `POST /v1/uploads/estimate` accepts beside a file's name, size and type.
 *
 * A profile holds neutral, aggregate facts only: counts, small fixed-size histograms and flags. Never file content, never
 * per-page arrays, never a price or a pricing class. The server treats it as untrusted input: it is validated here, clamped
 * (`normalizeFileProfile`) and used only to estimate; what a run is charged comes from the worker's own measurements.
 *
 * The PDF facts come from up to `FILE_PROFILE_MAX_SAMPLED_PAGES` pages spread over the document; counts are over those
 * sampled pages, not the whole document.
 */

/** Profile JSON shape; the profiler and the server reject other versions. */
export const FILE_PROFILE_SCHEMA = 1;
/** PDF pages the profiler inspects at most (evenly spread, first and last included). */
export const FILE_PROFILE_MAX_SAMPLED_PAGES = 24;
/**
 * Native words per sampled page, histogram bucket lower bounds: 0, 1-10, 11-29, 30-199, 200-499, 500+. The 10 and 30
 * edges are the page raster rule's stamp-text and sparse-page word limits (PAGE_RASTER_ROUTING).
 */
export const WORDS_PER_PAGE_BUCKETS = [0, 1, 11, 30, 200, 500] as const;
/** Placed image resolution, pixels per inch, bucket lower bounds. */
export const IMAGE_PPI_BUCKETS = [0, 100, 200, 300] as const;
/** Image stream bytes per pixel, bucket lower bounds. */
export const IMAGE_BYTES_PER_PIXEL_BUCKETS = [0, 0.05, 0.2, 0.5, 1] as const;
/** Per-page text equivalents, histogram bucket lower bounds: 1, 2, 3, 4-8, 9-16, 17-64, 65 and up. */
export const TEXT_EQUIVALENT_BUCKETS = [1, 2, 3, 4, 9, 17, 65] as const;
/** Effective font size (font size times text and page scaling), in points, bucket lower bounds: under 1, 1, 4, 6, 20. */
export const FONT_SIZE_BUCKETS = [0, 1, 4, 6, 20] as const;
/** Share of the page area covered by significant, non-furniture images, bucket lower bounds: 0, >0, 0.15, 0.5, 0.9. */
export const IMAGE_COVERAGE_BUCKETS = [0, Number.MIN_VALUE, 0.15, 0.5, 0.9] as const;
/** A serialized profile larger than this is refused. */
export const FILE_PROFILE_MAX_BYTES = 4 * 1024;

export const fileProfileKindSchema = z.enum(["pdf", "image", "office", "ebook", "text", "audio", "video", "unknown"]);
export type FileProfileKind = z.infer<typeof fileProfileKindSchema>;

const count = z.number().int().nonnegative().max(1_000_000);

export const pdfProfileSchema = z.strictObject({
  /** Pages inspected. */
  sampledPages: z.number().int().nonnegative().max(FILE_PROFILE_MAX_SAMPLED_PAGES),
  /** Sampled pages with at least one native (text-layer) word. */
  textLayerPages: count,
  /** Sampled pages per WORDS_PER_PAGE_BUCKETS bucket. */
  wordsPerPage: z.array(count).length(WORDS_PER_PAGE_BUCKETS.length),
  /** Sampled pages under the sparse-page word limit (fewer than 30 native words). */
  lowTextPages: count,
  /** Sampled pages with neither native words nor a significant, non-furniture image. */
  blankPages: count,
  /** Sampled pages the page raster rule finds held by a full-page image (a scan or photo of the page). */
  rasterPages: count,
  /** Sampled pages with at least one significant, non-furniture image. */
  imagePages: count,
  /** Significant, non-furniture image placements on the sampled pages (at most 64 tracked per page). */
  images: count,
  /** Sampled pages per IMAGE_COVERAGE_BUCKETS bucket of total image coverage. */
  imageCoverage: z.array(count).length(IMAGE_COVERAGE_BUCKETS.length),
  /** Distinct images drawn on many sampled pages (headers, footers, logos), excluded from the image facts above. */
  furnitureImages: count,
  /** Sampled pages, other than raster pages, with at least 15% image coverage or heavy vector drawing (tables, charts, figures). */
  layoutHeavyPages: count,
  /** Sampled pages with heavy vector drawing (60 or more path operations). */
  vectorHeavyPages: count,
  /** Sampled pages showing text in a font with no Unicode mapping, whose text layer is likely unreadable. */
  unmappedFontPages: count,
  /** No sampled page has words or images, yet the document carries heavy non-image content per page (text drawn as paths). */
  drawnContent: z.boolean(),
  /** A page or the document hit the profiler's content budget; facts are partial. */
  budgetExhausted: z.boolean(),
  /** Native words on the sampled pages, in total (text volume). */
  sampledWords: z.number().int().nonnegative().max(100_000_000),
  /** Median and largest visible page area of the sampled pages, in square inches (render and OCR size). */
  medianPageAreaSqIn: z.number().int().nonnegative().max(1_000_000),
  maxPageAreaSqIn: z.number().int().nonnegative().max(1_000_000),
  /** Glyphs shown on the sampled pages, and text lines started. */
  sampledChars: z.number().int().nonnegative().max(10 ** 12),
  sampledTextLines: z.number().int().nonnegative().max(10 ** 12),
  /** Glyphs per effective font size (FONT_SIZE_BUCKETS), of the glyphs measured (not those estimated). */
  charsByFontSize: z.array(z.number().int().nonnegative().max(10 ** 12)).length(5),
  /** Glyphs drawn invisibly (text rendering modes 3 and 7), and glyphs placed outside the visible box. */
  invisibleChars: z.number().int().nonnegative().max(10 ** 12),
  offCropChars: z.number().int().nonnegative().max(10 ** 12),
  /**
   * Page equivalents of the sampled pages by the rule billing measures with (page-equivalents.ts): text pages, area in
   * standard pages, each page's larger of the two (at least 1), summed; and the largest page.
   */
  sampledTextEquivalents: z.number().int().nonnegative().max(10 ** 9),
  sampledAreaEquivalents: z.number().int().nonnegative().max(10 ** 9),
  sampledPageEquivalents: z.number().int().nonnegative().max(10 ** 9),
  maxPageEquivalents: z.number().int().nonnegative().max(10 ** 9),
  /** Sampled pages per text equivalents (TEXT_EQUIVALENT_BUCKETS) and per area equivalents (1 to 8). */
  textEquivalentsPerPage: z.array(count).length(TEXT_EQUIVALENT_BUCKETS.length),
  areaEquivalentsPerPage: z.array(count).length(8),
  /** Sampled pages whose text counts as more than DENSE_PAGE_EQUIVALENTS pages. */
  densePages: count,
  /** Median and largest visible page width and height, in points. */
  medianPageWidthPt: z.number().int().nonnegative().max(10_000_000),
  medianPageHeightPt: z.number().int().nonnegative().max(10_000_000),
  maxPageWidthPt: z.number().int().nonnegative().max(10_000_000),
  maxPageHeightPt: z.number().int().nonnegative().max(10_000_000),
  /** Glyphs extraction drops (outside the MediaBox; tiny glyphs over the per-page limit), not counted above. */
  offPageChars: z.number().int().nonnegative().max(10 ** 12),
  tinyCharsDropped: z.number().int().nonnegative().max(10 ** 12),
  /** Sampled pages whose text could not be read to the end: their text facts are estimates from content size. */
  textEstimatedPages: count,
  /**
   * The layout walker's image facts (worker/scripts/pdf_layout_facts.py) over significant, non-furniture images: images
   * per placed resolution (IMAGE_PPI_BUCKETS) and per stream bytes per pixel (IMAGE_BYTES_PER_PIXEL_BUCKETS).
   */
  imagePpi: z.array(count).length(4),
  imageBytesPerPixel: z.array(count).length(5),
  /** Glyphs shown inside such an image's box (a text layer over a scan, captions over a figure), and pages with 20 or more. */
  glyphsOverImages: z.number().int().nonnegative().max(10 ** 12),
  textOverImagePages: count,
});
export type PdfProfile = z.infer<typeof pdfProfileSchema>;

export const fileProfileSchema = z.strictObject({
  schema: z.literal(FILE_PROFILE_SCHEMA),
  /** Profiler version, for diagnostics. */
  profiler: z.string().max(32),
  kind: fileProfileKindSchema,
  /** Detected container or format (`pdf`, `mp4`, `docx`, `png`, ...). */
  format: z.string().regex(/^[a-z0-9.+-]{1,16}$/),
  /** Sniffed MIME type, reported only when the file's name and declared type say nothing. */
  mimeType: z.string().max(127).optional(),
  /** File size the profile was measured on. */
  bytes: z.number().int().nonnegative().max(10 ** 13),
  /** Pages, slides, sheets or image frames, when counted. */
  pages: z.number().int().positive().max(10_000_000).optional(),
  /** The file is encrypted (PDF); its content facts were not measured. */
  encrypted: z.boolean().optional(),
  /** Audio or video length in seconds, when read. */
  durationSeconds: z.number().positive().max(7 * 24 * 3600).optional(),
  /** Characters of a text file read whole (text volume). */
  textChars: z.number().int().nonnegative().max(10 ** 12).optional(),
  pdf: pdfProfileSchema.optional(),
  /** Office and EPUB packages: counts from the package structure. */
  office: z.strictObject({
    embeddedImages: count,
    /** Slide or worksheet parts in the package. */
    slides: count.optional(),
    sheets: count.optional(),
    /** Uncompressed bytes of the main body parts (text volume). */
    bodyBytes: z.number().int().nonnegative().max(10 ** 13),
    /**
     * Informational only: the page or slide number the document's own metadata claims. Authored metadata is not a
     * measurement; nothing prices or counts from it.
     */
    declaredPages: count.optional(),
  }).optional(),
  /** Why a fact is missing or approximate (truncated input, budget reached, parse error). */
  notes: z.array(z.string().max(160)).max(8).optional(),
});
export type FileProfile = z.infer<typeof fileProfileSchema>;

/** Largest page area an estimate trusts: an A0 sheet (about 1,800 square inches). */
const MAX_PAGE_AREA_SQ_IN = 1_900;
/** Longest media duration an estimate trusts; longer ones are clamped (the worker measures the real one). */
const MAX_MEDIA_SECONDS = 24 * 3600;

/**
 * Clamp an untrusted, schema-valid profile against the file it claims to describe. Returns null when it does not describe
 * this file (another size) or is internally inconsistent; the file is then estimated from its name, type and size alone.
 * Every PDF count is clamped to the pages sampled, and the histograms must account for exactly those pages.
 */
export function normalizeFileProfile(profile: FileProfile, file: { size: number }): FileProfile | null {
  if (profile.bytes !== file.size) return null;
  if (JSON.stringify(profile).length > FILE_PROFILE_MAX_BYTES) return null;
  const normalized: FileProfile = { ...profile };
  if (normalized.durationSeconds !== undefined) normalized.durationSeconds = Math.min(MAX_MEDIA_SECONDS, normalized.durationSeconds);
  if (normalized.pdf) {
    const pdf = normalized.pdf;
    const sampled = Math.min(pdf.sampledPages, normalized.pages ?? pdf.sampledPages);
    const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
    // Histograms must account for exactly the pages (and glyphs) sampled, and the page sum may not undercount its parts.
    if (normalized.kind !== "pdf" || sum(pdf.wordsPerPage) !== pdf.sampledPages || sum(pdf.imageCoverage) !== pdf.sampledPages
      // Estimated pages add glyphs no size was measured for: the histogram may then hold fewer, never more.
      || (pdf.textEstimatedPages > 0 ? sum(pdf.charsByFontSize) > pdf.sampledChars : sum(pdf.charsByFontSize) !== pdf.sampledChars)
      || sum(pdf.textEquivalentsPerPage) !== pdf.sampledPages || sum(pdf.areaEquivalentsPerPage) !== pdf.sampledPages
      || sum(pdf.imagePpi) !== pdf.images || sum(pdf.imageBytesPerPixel) !== pdf.images) {
      delete normalized.pdf;
    } else {
      const clamp = (value: number) => Math.min(sampled, value);
      normalized.pdf = {
        ...pdf,
        sampledPages: sampled,
        textLayerPages: clamp(pdf.textLayerPages),
        lowTextPages: clamp(pdf.lowTextPages),
        blankPages: clamp(pdf.blankPages),
        rasterPages: clamp(pdf.rasterPages),
        imagePages: clamp(pdf.imagePages),
        layoutHeavyPages: clamp(pdf.layoutHeavyPages),
        vectorHeavyPages: clamp(pdf.vectorHeavyPages),
        unmappedFontPages: clamp(pdf.unmappedFontPages),
        images: Math.min(pdf.images, sampled * 64),
        sampledWords: Math.min(pdf.sampledWords, pdf.sampledChars),
        sampledTextLines: Math.min(pdf.sampledTextLines, pdf.sampledChars),
        invisibleChars: Math.min(pdf.invisibleChars, pdf.sampledChars),
        offCropChars: Math.min(pdf.offCropChars, pdf.sampledChars),
        // Every sampled page counts at least once; text pages are bounded by the glyphs and lines measured (the text rule),
        // area pages by their cap, the page sum by its parts and the largest page by the sum.
        ...(() => {
          const textBound = sampled + Math.ceil(pdf.sampledChars / TEXT_PAGE_CHARS) + Math.ceil(pdf.sampledTextLines / TEXT_PAGE_LINES);
          // The histograms bound the sums from below: a page in the "9-16" bucket counts at least 9.
          const textFloor = pdf.textEquivalentsPerPage.reduce((total, pages, index) => total + pages * TEXT_EQUIVALENT_BUCKETS[index]!, 0);
          const text = Math.min(textBound, Math.max(sampled, textFloor, pdf.sampledTextEquivalents));
          // Area equivalents are whole pages 1..8: the histogram gives their sum exactly.
          const area = pdf.areaEquivalentsPerPage.reduce((total, pages, index) => total + pages * (index + 1), 0);
          const page = Math.min(text + area, Math.max(sampled, text, area, pdf.sampledPageEquivalents));
          return { sampledTextEquivalents: text, sampledAreaEquivalents: area, sampledPageEquivalents: page, maxPageEquivalents: Math.min(page, Math.max(1, pdf.maxPageEquivalents)) };
        })(),
        medianPageAreaSqIn: Math.min(pdf.medianPageAreaSqIn, pdf.maxPageAreaSqIn, MAX_PAGE_AREA_SQ_IN),
        maxPageAreaSqIn: Math.min(pdf.maxPageAreaSqIn, MAX_PAGE_AREA_SQ_IN),
        // Dense pages are the text histogram's pages over 3 equivalents.
        densePages: pdf.textEquivalentsPerPage.slice(3).reduce((total, pages) => total + pages, 0),
        textEstimatedPages: Math.min(pdf.textEstimatedPages, sampled),
        glyphsOverImages: Math.min(pdf.glyphsOverImages, pdf.sampledChars),
        textOverImagePages: Math.min(pdf.textOverImagePages, sampled),
        medianPageWidthPt: Math.min(pdf.medianPageWidthPt, pdf.maxPageWidthPt),
        medianPageHeightPt: Math.min(pdf.medianPageHeightPt, pdf.maxPageHeightPt),
        // Histograms are kept as measured: their totals were checked above.
      };
      if (sampled !== pdf.sampledPages) delete normalized.pdf;
    }
  }
  if (normalized.office && normalized.kind !== "office" && normalized.kind !== "ebook") delete normalized.office;
  // A text file holds at most one character per byte of UTF-8 (two for UTF-16): a larger claim is clamped.
  if (normalized.textChars !== undefined) normalized.textChars = Math.min(normalized.textChars, file.size);
  if (normalized.office) normalized.office = { ...normalized.office, bodyBytes: Math.min(normalized.office.bodyBytes, file.size * 1_000) };
  return normalized;
}
