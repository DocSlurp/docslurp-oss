import { z } from "zod";

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
  pdf: pdfProfileSchema.optional(),
  /** Office files: images embedded in the package. */
  office: z.strictObject({ embeddedImages: count }).optional(),
  /** Why a fact is missing or approximate (truncated input, budget reached, parse error). */
  notes: z.array(z.string().max(160)).max(8).optional(),
});
export type FileProfile = z.infer<typeof fileProfileSchema>;

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
    if (normalized.kind !== "pdf" || sum(pdf.wordsPerPage) !== pdf.sampledPages || sum(pdf.imageCoverage) !== pdf.sampledPages) {
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
        // Histograms are kept as measured: their totals were checked above.
      };
      if (sampled !== pdf.sampledPages) delete normalized.pdf;
    }
  }
  if (normalized.office && normalized.kind !== "office" && normalized.kind !== "ebook") delete normalized.office;
  return normalized;
}
