import { fileExtension, FILE_FORMATS } from "./file-formats.js";
import { DEFAULT_PAGE_EQUIVALENT_ALLOWANCE } from "./page-equivalents.js";
import { isUploadImageFile, isUploadTextFile, TEXT_PAGE_CHARS, TEXT_PAGE_MIME_PREFIXES } from "./media-upload-estimate.js";

/*
 * Page counts and ranges of an upload from each file's name, type and size: what intake and quotes assume before the
 * worker measures a file. No prices here (pricing-provider.ts).
 */

/** Pages assumed for a file whose page count the client does not know (about 75 KB of source per page): the middle of its range. */
export const ASSUMED_BYTES_PER_PAGE = 75 * 1024;
/**
 * The ends of that range. A page of source is anywhere from a bilevel scan or dense vector page (about 16 KB) to a photographic
 * scan (about 300 KB), so a file of unknown page count is quoted over the pages those sizes give, not at one guess. The high end is
 * a ceiling only when pages are measured.
 */
export const UNMEASURED_MIN_BYTES_PER_PAGE = 16 * 1024;
export const UNMEASURED_MAX_BYTES_PER_PAGE = 300 * 1024;
/**
 * Text files of unknown line count: pages by characters need 3,500 per page (UTF-8; a UTF-16 file has half as many characters per
 * byte), pages by lines up to one per 12 bytes of line (60 lines, the shortest lines a text file realistically has).
 */
export const UNMEASURED_TEXT_MAX_BYTES_PER_PAGE = 7_000;
export const UNMEASURED_TEXT_MIN_BYTES_PER_PAGE = 720;

/**
 * Formats whose page count only the worker can measure (it converts or parses the file): intake counts them as one page and the
 * page count is `assumed`. A file of these is priced over its size, at bytes per page that hold for the format rather than for a scan:
 * a Word, slide, sheet or EPUB file holds a page in a few KB to a few tens of KB, far below a PDF's 16 KB to 300 KB scanned page.
 */
export type WorkerCountedFormat = "office-word" | "office-other" | "office-excel" | "office-pptx" | "epub";
export const WORKER_COUNTED_FORMATS: readonly WorkerCountedFormat[] = ["office-word", "office-other", "office-excel", "office-pptx", "epub"];
/**
 * Bytes of source per page for each of those formats, as `[min, typical, max]`: `min` is the densest file (the most pages: the
 * high end of a quote), `typical` prices the middle, `max` is an image-heavy file (the fewest pages: the low end). Judgement
 * from what the formats hold (compressed text, a page of a .docx is 1 to 7 KB; a slide is a few KB with no pictures and
 * 100 KB or more with them; a sheet page is 3,500 characters of CSV, about 1 KB compressed). They are quoted, never billed:
 * the worker measures the real count.
 */
export const UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE: Readonly<Record<WorkerCountedFormat, { min: number; typical: number; max: number }>> = {
  "office-word": { min: 1_024, typical: 12 * 1024, max: 150 * 1024 },
  "office-other": { min: 2_048, typical: 24 * 1024, max: 300 * 1024 },
  "office-excel": { min: 512, typical: 4 * 1024, max: 300 * 1024 },
  "office-pptx": { min: 2_048, typical: 40 * 1024, max: 300 * 1024 },
  epub: { min: 1_024, typical: 6 * 1024, max: 300 * 1024 },
};

/**
 * Of those, the formats no model ever reads, in any quality: Word, legacy Office, OpenDocument, RTF, slide and sheet files have their
 * text extracted and are never rendered for a vision model, so each of their pages bills Fast. A quote prices them Fast at both ends.
 */
export const FAST_ONLY_FORMATS: readonly WorkerCountedFormat[] = ["office-word", "office-other", "office-excel", "office-pptx"];

/**
 * Whether a file's pages bill Fast whatever the workspace's quality (FAST_ONLY_FORMATS). A page mix the client sent does not change
 * that: no model reads these files, so a measured scanned share would quote Rich pages the worker never bills.
 */
export function isFastOnlyFile(file: { name: string; type?: string | null }): boolean {
  const format = workerCountedFormat(file);
  return format !== null && FAST_ONLY_FORMATS.includes(format);
}

/**
 * The MIME types and extensions that make a file one of those formats (the card ships them for ports that cannot import the table).
 * A MIME type the API counts as text (`text/rtf`) is left out: intake counts such a file from its text.
 */
export function workerCountedFormatTable(): Array<{ format: WorkerCountedFormat; mimeTypes: string[]; extensions: string[] }> {
  cachedFormatTable ??= WORKER_COUNTED_FORMATS.map((format) => {
    const specs = FILE_FORMATS.filter((spec) => spec.format === format);
    return {
      format,
      mimeTypes: [...new Set(specs.flatMap((spec) => [spec.mimeType, ...(spec.aliases ?? [])]))]
        .filter((type) => !TEXT_PAGE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))),
      extensions: [...new Set(specs.flatMap((spec) => spec.extensions.map((extension) => extension.slice(1))))],
    };
  });
  return cachedFormatTable;
}
let cachedFormatTable: Array<{ format: WorkerCountedFormat; mimeTypes: string[]; extensions: string[] }> | null = null;

/**
 * The worker-counted format of a file: its declared MIME type when one of them claims it, else its extension when the type is absent
 * or generic (the rule `isUploadImageFile` and `isUploadTextFile` follow, which the offline estimator's port repeats).
 */
export function workerCountedFormat(file: { name: string; type?: string | null }): WorkerCountedFormat | null {
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const table = workerCountedFormatTable();
  const byType = table.find((entry) => entry.mimeTypes.includes(type));
  if (byType) return byType.format;
  if (type !== "" && type !== "application/octet-stream") return null;
  const extension = fileExtension(file.name).slice(1);
  return table.find((entry) => entry.extensions.includes(extension))?.format ?? null;
}

/**
 * Where a stored page count came from (documents.page_count_source, migration 0126): `counted` only on real evidence, a count
 * taken from the file's bytes; `assumed` for everything else, which the worker replaces with its own measurement (a PDF's count
 * from its VM or sandboxed page facts, a TIFF's frames from the OCR boundary, an Office file's pages from its extractor).
 * Shown on documents as `measured` / `estimated`.
 */
export type PageCountSource = "counted" | "assumed";

/**
 * The evidence behind intake's page count (server source-metadata.ts), never the file's name or declared type:
 * - `text-rule`: the text rule over the whole decoded text file.
 * - `image-header`: the bytes' magic is a single-frame raster format (one page by definition).
 * - `text-sample`: the text rule over a sample, scaled by size (an estimate).
 * - `size-estimate`: pages from the size alone (a PDF: the API never parses one).
 * - `none`: no count at all (a format only the worker counts, a multi-frame image, an empty or unrecognised file).
 */
export type IntakePageEvidence = "text-rule" | "image-header" | "text-sample" | "size-estimate" | "none";

/** `counted` only for evidence taken from the bytes in full; an estimate, a sample or a MIME type alone is `assumed`. */
export function intakePageCountSource(evidence: IntakePageEvidence | null | undefined): PageCountSource {
  return evidence === "text-rule" || evidence === "image-header" ? "counted" : "assumed";
}

/** Intake's estimate of a PDF's pages from its size (ASSUMED_BYTES_PER_PAGE), never parsed; labelled `estimated`. */
export function estimatedPdfPages(bytes: number): number {
  return Math.max(1, Math.ceil(Math.max(0, bytes) / ASSUMED_BYTES_PER_PAGE));
}

/**
 * The pages a cost forecast may pass as counted for a stored document: the worker's measured billing pages, else intake's page count
 * when intake counted it. Any other count is left out so the forecast prices the file's size instead.
 */
export function countedPagesForForecast(document: { pageCount: number; billingPages?: number | null; pageCountSource?: string | null }): number | undefined {
  if (Number(document.billingPages) > 0) return Number(document.billingPages);
  // Only an explicitly counted page count: an assumed, missing or unknown source is priced over the file's size.
  return document.pageCountSource === "counted" && Number(document.pageCount) > 0 ? Number(document.pageCount) : undefined;
}

/** Pages of a file of `format` from its size alone, at the format's typical bytes per page (at least 1). */
export function pagesFromSize(format: WorkerCountedFormat, sizeBytes: number): number {
  return Math.max(1, Math.ceil(Math.max(0, sizeBytes) / UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE[format].typical));
}

/**
 * Frames one multi-frame image file (a TIFF) may hold: the OCR engine reads each frame as a page, and refuses a file with more
 * (split it, or upload a PDF). A quote prices a TIFF's frames as its pages, up to this many.
 */
export const IMAGE_MAX_FRAMES = 64;
/** Image formats that can hold several frames (pages). */
export const MULTI_FRAME_IMAGE_MIME_TYPES: readonly string[] = ["image/tiff", "image/tiff-fx"];
export const MULTI_FRAME_IMAGE_EXTENSIONS: readonly string[] = ["tif", "tiff"];

/** Whether a file is a multi-frame image: its declared type, else its extension when the type is absent or generic. */
export function isMultiFrameImageFile(file: { name: string; type?: string | null }): boolean {
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (MULTI_FRAME_IMAGE_MIME_TYPES.includes(type)) return true;
  if (type !== "" && type !== "application/octet-stream") return false;
  return MULTI_FRAME_IMAGE_EXTENSIONS.includes(fileExtension(file.name).slice(1));
}

/** Where a file's page count sits: the cheap end, the middle, and the expensive end; `measured` when the client counted them. */
export type PageRange = { low: number; central: number; high: number; measured: boolean };

/**
 * Pages a non-media file counts as: its known page count; else 1 for an image file, its size over TEXT_PAGE_CHARS
 * for a text file, and its size at ASSUMED_BYTES_PER_PAGE for anything else (at least 1). A TIFF counts its frames (1 when not
 * counted), at most IMAGE_MAX_FRAMES.
 */
export function quoteFilePages(file: { name: string; type?: string | null; size: number; pages?: number; measured?: { pages: number } }): number {
  // A stored document the worker measured at no pages (an empty Office file): nothing to process. Only the server sets
  // `measured` (stored-quote.ts); a client's request cannot carry it.
  if (file.measured?.pages === 0) return 0;
  // A TIFF's frames are its pages, up to the frames one file may hold (more are refused, never read or billed).
  if (isMultiFrameImageFile(file)) return Math.max(1, Math.min(IMAGE_MAX_FRAMES, Math.round(file.pages ?? 1)));
  const counted = file.pages === undefined ? workerCountedFormat(file) : null;
  const pages = file.pages
    ?? (isUploadImageFile(file)
      ? 1
      // Text pages count characters (TEXT_PAGE_CHARS each); bytes bound them from above for UTF-8.
      : isUploadTextFile(file)
        ? Math.ceil(file.size / TEXT_PAGE_CHARS)
        : counted
          ? pagesFromSize(counted, file.size)
          : Math.ceil(file.size / ASSUMED_BYTES_PER_PAGE));
  return Math.max(1, Math.round(pages));
}

/**
 * Page equivalents of a profiled PDF: the pages the billing measurement (page-equivalents.ts) will count, estimated from the
 * sampled pages' equivalents scaled to the document. Equal to the page count for an ordinary document; more for a stuffed
 * one (tiny, invisible or off-page text, oversized pages). Undefined when the profile carries no page facts.
 */
type ProfiledPdf = {
  sampledPages: number;
  sampledPageEquivalents: number;
  textEstimatedPages?: number;
  maxPageEquivalents?: number;
  pageEquivalentsByAllowance?: readonly number[];
  maxPageEquivalentsByAllowance?: readonly number[];
};
type ProfiledFile = { pages?: number; profile?: { pages?: number; pdf?: ProfiledPdf } };

/** The profile's index for a text allowance: 1, 2 or 3 (a larger allowance is quoted as 3, which can only overstate). */
const allowanceIndex = (allowance: number) => Math.min(2, Math.max(0, Math.floor(allowance) - 1));

/**
 * The sampled pages' equivalents under a dense-page `allowance` (billedPagePageEquivalents: each page's text above the
 * allowance else 1, or its area, whichever is larger). Exact for an allowance of 1 to 3. Without the per-allowance sums (an
 * older profile), every page's full volume.
 */
export function sampledBilledEquivalents(pdf: ProfiledPdf, allowance: number): number {
  const sums = pdf.pageEquivalentsByAllowance;
  if (!sums || sums.length !== 3) return pdf.sampledPageEquivalents;
  return Math.max(pdf.sampledPages, sums[allowanceIndex(allowance)]!);
}

/** The largest sampled page under `allowance`. */
function densestBilledPage(pdf: ProfiledPdf, allowance: number): number {
  const maxes = pdf.maxPageEquivalentsByAllowance;
  return Math.max(1, maxes && maxes.length === 3 ? maxes[allowanceIndex(allowance)]! : pdf.maxPageEquivalents ?? 1);
}

/** A file's billed page equivalents from its profile under `allowance`, scaled from the sampled pages; at least its pages. */
export function profilePageEquivalents(file: ProfiledFile, allowance = DEFAULT_PAGE_EQUIVALENT_ALLOWANCE): number | undefined {
  const pages = file.pages ?? file.profile?.pages;
  const pdf = file.profile?.pdf;
  if (!pages || !pdf || pdf.sampledPages <= 0) return undefined;
  const billed = sampledBilledEquivalents(pdf, allowance);
  if (pdf.sampledPages >= pages) return Math.max(pages, billed);
  return Math.max(pages, Math.ceil(pages * (billed / pdf.sampledPages)));
}

/**
 * The page equivalents as a range: `low` is profilePageEquivalents; the high end widens with the share of sampled pages
 * whose text was estimated (read only in part: up to twice their estimated volume) and of pages not sampled at all when
 * the sampled pages were dense (up to the largest sampled page each).
 */
export function profilePageEquivalentRange(file: ProfiledFile, allowance = DEFAULT_PAGE_EQUIVALENT_ALLOWANCE): { low: number; high: number } | undefined {
  const low = profilePageEquivalents(file, allowance);
  const pdf = file.profile?.pdf;
  const pages = file.pages ?? file.profile?.pages;
  if (low === undefined || !pdf || !pages) return low === undefined ? undefined : { low, high: low };
  const estimatedShare = Math.min(1, (pdf.textEstimatedPages ?? 0) / pdf.sampledPages);
  let high = Math.ceil(low * (1 + estimatedShare));
  const densest = densestBilledPage(pdf, allowance);
  if (pages > pdf.sampledPages && densest > 1) {
    high = Math.max(high, Math.ceil(low + (pages - pdf.sampledPages) * (densest - sampledBilledEquivalents(pdf, allowance) / pdf.sampledPages)));
  }
  return { low, high: Math.max(low, high) };
}

/** Pages of a file over the range its size allows when the client has not counted them; one value when they are known. */
export function quoteFilePageRange(file: { name: string; type?: string | null; size: number; pages?: number; measured?: { pages: number } }): PageRange {
  const central = quoteFilePages(file);
  if (file.measured?.pages === 0) return { low: 0, central: 0, high: 0, measured: true };
  // An uncounted TIFF holds one frame to as many as its size allows at the densest page, up to IMAGE_MAX_FRAMES.
  if (file.pages === undefined && isMultiFrameImageFile(file)) {
    return { low: 1, central, high: Math.max(central, Math.min(IMAGE_MAX_FRAMES, Math.ceil(file.size / UNMEASURED_MIN_BYTES_PER_PAGE))), measured: false };
  }
  if (file.pages !== undefined || isUploadImageFile(file)) return { low: central, central, high: central, measured: true };
  const counted = workerCountedFormat(file);
  const [lowDivisor, highDivisor] = isUploadTextFile(file)
    ? [UNMEASURED_TEXT_MAX_BYTES_PER_PAGE, UNMEASURED_TEXT_MIN_BYTES_PER_PAGE]
    : counted
      ? [UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE[counted].max, UNMEASURED_WORKER_COUNTED_BYTES_PER_PAGE[counted].min]
      : [UNMEASURED_MAX_BYTES_PER_PAGE, UNMEASURED_MIN_BYTES_PER_PAGE];
  return {
    low: Math.max(1, Math.min(central, Math.round(Math.ceil(file.size / lowDivisor)))),
    central,
    high: Math.max(central, Math.round(Math.ceil(file.size / highDivisor))),
    measured: false,
  };
}

