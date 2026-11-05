/*
 * The one table of file formats. Intake (server/src/lib/upload-policy.ts), the worker's format-detect stage, the
 * server's extension-to-MIME map and the offline estimator card (extension lists) are all generated from FILE_FORMATS,
 * so a format the worker accepts is accepted at intake, priced by the quote and billed the way it was quoted: one
 * decision, one list. Add a format here and nowhere else.
 */

export type NormalizedFormat =
  | "pdf"
  | "markdown"
  | "plain-text"
  | "html"
  | "office-word"
  | "office-excel"
  | "office-pptx"
  | "office-other"
  | "structured-csv"
  | "structured-json"
  | "epub"
  | "latex"
  | "image"
  | "audio"
  | "video"
  | "unknown";

/**
 * Formats whose bytes can legitimately arrive under each other's MIME type or extension: a CSV declared
 * `application/vnd.ms-excel`, a `.docx` declared `application/msword`. A declared-vs-sniffed mismatch inside one family is
 * a warning; across families it is not.
 */
export type FormatFamily = "text" | "word" | "excel" | "powerpoint" | "pdf" | "epub" | "image" | "mp4" | "webm" | "audio" | "video" | "opendocument";

export interface FileFormatSpec {
  format: NormalizedFormat;
  family: FormatFamily;
  /** The canonical MIME type stored on the document. */
  mimeType: string;
  /** Other declared MIME types that mean the same thing. */
  aliases?: readonly string[];
  /** Lower-case extensions with their dot. */
  extensions: readonly string[];
}

export const FILE_FORMATS: readonly FileFormatSpec[] = [
  { format: "pdf", family: "pdf", mimeType: "application/pdf", aliases: ["application/x-pdf"], extensions: [".pdf"] },
  { format: "markdown", family: "text", mimeType: "text/markdown", aliases: ["text/x-markdown"], extensions: [".md", ".markdown"] },
  { format: "plain-text", family: "text", mimeType: "text/plain", extensions: [".txt"] },
  { format: "html", family: "text", mimeType: "text/html", aliases: ["application/xhtml+xml"], extensions: [".html", ".htm", ".mhtml"] },
  { format: "office-word", family: "word", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extensions: [".docx"] },
  { format: "office-other", family: "word", mimeType: "application/msword", extensions: [".doc"] },
  { format: "office-excel", family: "excel", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extensions: [".xlsx"] },
  { format: "office-excel", family: "excel", mimeType: "application/vnd.ms-excel", extensions: [".xls"] },
  { format: "office-pptx", family: "powerpoint", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extensions: [".pptx"] },
  { format: "office-pptx", family: "powerpoint", mimeType: "application/vnd.ms-powerpoint", extensions: [".ppt"] },
  { format: "office-other", family: "opendocument", mimeType: "application/vnd.oasis.opendocument.text", extensions: [".odt"] },
  { format: "office-other", family: "text", mimeType: "application/rtf", aliases: ["text/rtf"], extensions: [".rtf"] },
  { format: "structured-csv", family: "text", mimeType: "text/csv", aliases: ["application/csv", "text/comma-separated-values"], extensions: [".csv"] },
  { format: "structured-csv", family: "text", mimeType: "text/tab-separated-values", aliases: ["text/tsv"], extensions: [".tsv"] },
  { format: "structured-json", family: "text", mimeType: "application/json", extensions: [".json"] },
  { format: "structured-json", family: "text", mimeType: "application/x-ndjson", aliases: ["application/jsonl", "application/x-jsonlines"], extensions: [".jsonl", ".ndjson"] },
  { format: "epub", family: "epub", mimeType: "application/epub+zip", extensions: [".epub"] },
  { format: "latex", family: "text", mimeType: "application/x-latex", aliases: ["text/x-tex", "application/x-tex"], extensions: [".tex"] },
  { format: "image", family: "image", mimeType: "image/png", extensions: [".png"] },
  { format: "image", family: "image", mimeType: "image/jpeg", aliases: ["image/jpg"], extensions: [".jpg", ".jpeg"] },
  { format: "image", family: "image", mimeType: "image/tiff", extensions: [".tiff", ".tif"] },
  { format: "image", family: "image", mimeType: "image/webp", extensions: [".webp"] },
  { format: "audio", family: "audio", mimeType: "audio/mpeg", aliases: ["audio/mp3"], extensions: [".mp3"] },
  { format: "audio", family: "audio", mimeType: "audio/wav", aliases: ["audio/x-wav", "audio/wave", "audio/vnd.wave"], extensions: [".wav"] },
  { format: "audio", family: "audio", mimeType: "audio/flac", aliases: ["audio/x-flac"], extensions: [".flac"] },
  { format: "audio", family: "audio", mimeType: "audio/ogg", aliases: ["application/ogg"], extensions: [".ogg", ".opus"] },
  { format: "audio", family: "mp4", mimeType: "audio/mp4", aliases: ["audio/x-m4a", "audio/m4a"], extensions: [".m4a"] },
  { format: "audio", family: "audio", mimeType: "audio/aac", extensions: [".aac"] },
  { format: "audio", family: "webm", mimeType: "audio/webm", extensions: [".weba"] },
  { format: "video", family: "mp4", mimeType: "video/mp4", extensions: [".mp4"] },
  { format: "video", family: "webm", mimeType: "video/webm", extensions: [".webm"] },
  { format: "video", family: "mp4", mimeType: "video/quicktime", extensions: [".mov"] },
  { format: "video", family: "video", mimeType: "video/x-matroska", aliases: ["video/matroska"], extensions: [".mkv"] },
  { format: "video", family: "video", mimeType: "video/x-msvideo", aliases: ["video/avi"], extensions: [".avi"] },
];

/** Generic container type for OLE2 files whose application the bytes alone do not name. Compatible with every Office app family. */
export const OLE_STORAGE_MIME = "application/x-ole-storage";
/** Generic ZIP, which no supported format names by itself. */
export const GENERIC_ZIP_MIME = "application/zip";

/** Every MIME type (canonical or alias) → its spec. */
const SPEC_BY_MIME: ReadonlyMap<string, FileFormatSpec> = new Map(
  FILE_FORMATS.flatMap((spec) => [spec.mimeType, ...(spec.aliases ?? [])].map((mime) => [mime, spec] as const)),
);

const SPEC_BY_EXTENSION: ReadonlyMap<string, FileFormatSpec> = new Map(
  FILE_FORMATS.flatMap((spec) => spec.extensions.map((extension) => [extension, spec] as const)),
);

export const FORMAT_BY_MIME: Readonly<Record<string, NormalizedFormat>> = Object.fromEntries(
  [...SPEC_BY_MIME].map(([mime, spec]) => [mime, spec.format]),
);

/** Keyed by lower-case extension with its dot (`.pdf`). */
export const FORMAT_BY_EXTENSION: Readonly<Record<string, NormalizedFormat>> = Object.fromEntries(
  [...SPEC_BY_EXTENSION].map(([extension, spec]) => [extension, spec.format]),
);

/** Canonical MIME type of each extension (`.jpg` → `image/jpeg`). */
export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  [...SPEC_BY_EXTENSION].map(([extension, spec]) => [extension, spec.mimeType]),
);

/** Canonical MIME types intake accepts. */
export const SUPPORTED_UPLOAD_MIME_TYPES: readonly string[] = [...new Set(FILE_FORMATS.map((spec) => spec.mimeType))].sort();

/** Lower-case extension of `filename` with its dot, or "" when it has none. */
export function fileExtension(filename: string | null | undefined): string {
  const name = filename ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** A declared Content-Type reduced to its bare lower-case MIME type (no parameters). */
export function bareMimeType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** The canonical MIME type for a declared one (`audio/mp3` → `audio/mpeg`), or null when no supported format claims it. */
export function canonicalMimeType(value: string | null | undefined): string | null {
  return SPEC_BY_MIME.get(bareMimeType(value))?.mimeType ?? null;
}

/** The format family of a MIME type (canonical, alias or the generic OLE type), or null when unsupported. */
export function mimeFamily(value: string | null | undefined): FormatFamily | null {
  return SPEC_BY_MIME.get(bareMimeType(value))?.family ?? null;
}

const OLE_FAMILIES: ReadonlySet<FormatFamily> = new Set(["word", "excel", "powerpoint"]);

/**
 * Whether bytes of one type may be declared as the other without it meaning anything but a mislabelled file: both in one family
 * (CSV as `application/vnd.ms-excel` is not; a `.docx` as `application/msword` is), or one the generic OLE type and the
 * other any Office family.
 */
export function compatibleMimeTypes(declared: string | null | undefined, sniffed: string | null | undefined): boolean {
  const a = bareMimeType(declared);
  const b = bareMimeType(sniffed);
  if (!a || !b) return false;
  if (canonicalMimeType(a) !== null && canonicalMimeType(a) === canonicalMimeType(b)) return true;
  if (a === b) return true;
  const familyA = a === OLE_STORAGE_MIME ? "ole" : mimeFamily(a);
  const familyB = b === OLE_STORAGE_MIME ? "ole" : mimeFamily(b);
  if (!familyA || !familyB) return false;
  if (familyA === familyB) return true;
  return (familyA === "ole" && OLE_FAMILIES.has(familyB as FormatFamily)) || (familyB === "ole" && OLE_FAMILIES.has(familyA as FormatFamily));
}

/** Whether a declared MIME type, or failing that the filename's extension, names a format this service ingests. */
export function isSupportedFileType(mimeType: string | null | undefined, filename?: string | null): boolean {
  return resolveSupportedMimeType(mimeType, filename) !== null;
}

/**
 * The canonical MIME type a file is stored under: its declared type when a supported format claims it, else the
 * extension's. Null when neither names a supported format (`application/octet-stream` falls to the extension).
 */
export function resolveSupportedMimeType(mimeType: string | null | undefined, filename?: string | null): string | null {
  const declared = canonicalMimeType(mimeType);
  if (declared) return declared;
  const fromExtension = MIME_BY_EXTENSION[fileExtension(filename)];
  return fromExtension ?? null;
}

/** The format of a declared MIME type when supported, else of the extension. */
export function detectFileFormat(file: { filename?: string | null; mimeType?: string | null }): NormalizedFormat {
  const mime = bareMimeType(file.mimeType);
  if (Object.hasOwn(FORMAT_BY_MIME, mime)) return FORMAT_BY_MIME[mime]!;
  const extension = fileExtension(file.filename);
  return Object.hasOwn(FORMAT_BY_EXTENSION, extension) ? FORMAT_BY_EXTENSION[extension]! : "unknown";
}

/** Extensions (without the dot) the format table gives `format`. */
export function extensionsOf(format: NormalizedFormat): string[] {
  return [...new Set(FILE_FORMATS.filter((spec) => spec.format === format).flatMap((spec) => spec.extensions))].map((extension) => extension.slice(1));
}
