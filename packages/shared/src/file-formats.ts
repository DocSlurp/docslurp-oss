/*
 * File formats by declared MIME type and extension. The worker's format-detect stage routes documents with these
 * tables, and upload quotes read them to tell media and image files from paged documents, so a format the worker
 * accepts is priced the way it will be billed.
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

export const FORMAT_BY_MIME: Readonly<Record<string, NormalizedFormat>> = {
  "audio/mpeg": "audio", "audio/mp3": "audio", "audio/wav": "audio", "audio/x-wav": "audio",
  "audio/flac": "audio", "audio/ogg": "audio", "audio/mp4": "audio", "audio/webm": "audio",
  "video/mp4": "video", "video/webm": "video", "video/quicktime": "video", "video/x-matroska": "video",
  "application/pdf": "pdf",
  "text/markdown": "markdown",
  "text/plain": "plain-text",
  "text/html": "html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "office-word",
  "application/rtf": "office-other",
  "text/csv": "structured-csv",
  "application/json": "structured-json",
  "application/x-ndjson": "structured-json",
  "application/epub+zip": "epub",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "office-pptx",
  "application/vnd.ms-powerpoint": "office-pptx",
  "application/x-latex": "latex",
  "text/x-tex": "latex",
  "image/png": "image",
  "image/jpeg": "image",
  "image/tiff": "image",
  "image/webp": "image",
};

/** Keyed by lower-case extension with its dot (`.pdf`). */
export const FORMAT_BY_EXTENSION: Readonly<Record<string, NormalizedFormat>> = {
  ".mp3": "audio", ".wav": "audio", ".flac": "audio", ".ogg": "audio", ".opus": "audio", ".m4a": "audio", ".aac": "audio",
  ".mp4": "video", ".webm": "video", ".mov": "video", ".mkv": "video", ".avi": "video",
  ".pdf": "pdf",
  ".md": "markdown",
  ".txt": "plain-text",
  ".html": "html",
  ".htm": "html",
  ".mhtml": "html",
  ".docx": "office-word",
  ".doc": "office-word",
  ".xlsx": "office-excel",
  ".xls": "office-excel",
  ".pptx": "office-pptx",
  ".ppt": "office-pptx",
  ".odt": "office-other",
  ".rtf": "office-other",
  ".csv": "structured-csv",
  ".tsv": "structured-csv",
  ".json": "structured-json",
  ".jsonl": "structured-json",
  ".epub": "epub",
  ".tex": "latex",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".tiff": "image",
  ".tif": "image",
  ".webp": "image",
};

/** Lower-case extension of `filename` with its dot, or "" when it has none. */
export function fileExtension(filename: string | null | undefined): string {
  const name = filename ?? "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

/** The worker's format detection: the declared MIME type when known, else the extension. */
export function detectFileFormat(file: { filename?: string | null; mimeType?: string | null }): NormalizedFormat {
  const mime = file.mimeType?.toLowerCase() ?? "";
  if (Object.hasOwn(FORMAT_BY_MIME, mime)) return FORMAT_BY_MIME[mime]!;
  const extension = fileExtension(file.filename);
  return Object.hasOwn(FORMAT_BY_EXTENSION, extension) ? FORMAT_BY_EXTENSION[extension]! : "unknown";
}

/** Extensions (without the dot) the format tables give `format`. */
export function extensionsOf(format: NormalizedFormat): string[] {
  return Object.entries(FORMAT_BY_EXTENSION).filter(([, value]) => value === format).map(([extension]) => extension.slice(1));
}
