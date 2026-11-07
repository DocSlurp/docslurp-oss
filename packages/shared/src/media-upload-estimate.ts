import { z } from "zod";

import { MEDIA_BYTES_PER_MINUTE, mediaRichPages, pageCredits } from "./billing.js";
import { extensionsOf, fileExtension } from "./file-formats.js";

/** Audio and video are priced by duration, not by page. */
export type UploadMediaKind = "audio" | "video";

/** Extensions priced by duration when the MIME type does not say: the worker's media formats, plus browser `weba`. */
export const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(extensionsOf("audio"));
export const VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(extensionsOf("video"));
/** Image files: read whole as images, so a page bills Rich in the auto and good profiles (page-base-fee.ts). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(extensionsOf("image"));

function declaredType(type: string | null | undefined): string {
  return (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function extensionOf(name: string): string {
  return fileExtension(name).slice(1);
}

/** Which media kind a file is, from its MIME type then its extension; null for everything priced per page. */
export function uploadMediaKind(file: { name: string; type?: string | null }): UploadMediaKind | null {
  const type = declaredType(file.type);
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  const extension = extensionOf(file.name);
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

/** Extensions of formats the API counts as text pages (TEXT_PAGE_MIME_PREFIXES) when no specific MIME type is given. */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  (["plain-text", "markdown", "html", "structured-csv", "structured-json", "latex"] as const).flatMap((format) => extensionsOf(format)),
);

/** Declared MIME types that say nothing about the format, so the extension decides. */
function isGenericType(type: string): boolean {
  return type === "" || type === "application/octet-stream";
}

/**
 * Whether a file is an image, billed as Rich pages read whole (page-base-fee.ts reads the stored MIME type): an
 * `image/*` type, or an image extension when the type is absent or generic.
 */
export function isUploadImageFile(file: { name: string; type?: string | null }): boolean {
  const type = declaredType(file.type);
  return type.startsWith("image/") || (isGenericType(type) && IMAGE_EXTENSIONS.has(extensionOf(file.name)));
}

/**
 * MIME type prefixes whose page count the API derives from the text (server/src/services/source-metadata.ts):
 * the larger of one page per TEXT_PAGE_LINES lines and one per TEXT_PAGE_CHARS characters.
 */
export const TEXT_PAGE_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
] as const;
export const TEXT_PAGE_LINES = 60;
export const TEXT_PAGE_CHARS = 3_500;

/** Whether a file's pages are counted from its text: a text MIME type, or a text extension with no specific type. */
export function isUploadTextFile(file: { name: string; type?: string | null }): boolean {
  const type = declaredType(file.type);
  if (TEXT_PAGE_MIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
  return isGenericType(type) && TEXT_EXTENSIONS.has(extensionOf(file.name));
}

/** East Asian characters carry about three times the content of a Latin one, so each counts as this many characters toward a page. */
export const TEXT_PAGE_CJK_WEIGHT = 3;

function isCjkCodePoint(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff66 && code <= 0xff9f)
    || (code >= 0x20000 && code <= 0x2fa1f);
}

function asciiLower(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** Index of lower-case ASCII `needle` in `text` ignoring ASCII case, from `from`; -1 when absent. */
function indexOfAsciiInsensitive(text: string, needle: string, from: number): number {
  for (let at = from; at + needle.length <= text.length; at++) {
    let hit = true;
    for (let offset = 0; offset < needle.length && hit; offset++) hit = asciiLower(text.charCodeAt(at + offset)) === needle.charCodeAt(offset);
    if (hit) return at;
  }
  return -1;
}

/** Longest stretch of text measured in full; a longer file is measured on its first part and scaled. */
export const TEXT_MEASURE_SAMPLE_CHARS = 2_000_000;

/**
 * The visible text of HTML: tags, comments, scripts and styles removed. Markup is not content a page holds.
 * One forward pass: every search starts at the cursor and a search that finds nothing is never repeated, so
 * hostile input ("<a" repeated, unclosed comments or scripts) costs O(n).
 */
export function stripHtmlMarkup(text: string): string {
  const parts: string[] = [];
  // Literal text from `pending` is not yet copied: a "<" that is not markup stays in it, so a flood of them is
  // one slice instead of one part each.
  let pending = 0;
  let at = 0;
  // Position of the next ">" at or after the last search, or -1 once none remains, so a "<" that never
  // closes does not rescan the rest of the file.
  let nextClose = -2;
  const closeFrom = (from: number): number => {
    if (nextClose === -1 || nextClose >= from) return nextClose;
    nextClose = text.indexOf(">", from);
    return nextClose;
  };
  const skip = (open: number, resume: number, replacement: string) => {
    if (open > pending) parts.push(text.slice(pending, open));
    if (replacement) parts.push(replacement);
    pending = resume;
    at = resume;
  };
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      skip(open, close < 0 ? text.length : close + 3, "");
      continue;
    }
    const first = text.charCodeAt(open + 1);
    const lowerFirst = asciiLower(first);
    // Only "<s..." can open a script or style.
    const block = lowerFirst === 115 ? ["script", "style"].find((name) => {
      if (indexOfAsciiInsensitive(text.slice(open, open + name.length + 2), `<${name}`, 0) !== 0) return false;
      const next = text.charAt(open + name.length + 1);
      return next === ">" || next === "/" || next === " " || next === "\t" || next === "\n" || next === "\r" || next === "\f";
    }) : undefined;
    if (block) {
      // No closing tag swallows the rest of the file, as a browser would.
      const close = indexOfAsciiInsensitive(text, `</${block}`, open);
      const end = close < 0 ? -1 : text.indexOf(">", close);
      skip(open, end < 0 ? text.length : end + 1, "");
      continue;
    }
    const tagStart = first === 33 || first === 47 || first === 63 || (lowerFirst >= 97 && lowerFirst <= 122);
    const end = tagStart ? closeFrom(open) : -1;
    if (end < 0) {
      // Not a tag, or no ">" anywhere after it: a literal "<".
      at = open + 1;
      continue;
    }
    skip(open, end + 1, "\n");
  }
  if (pending < text.length) parts.push(text.slice(pending));
  return parts.join("");
}

/**
 * Pages of a text file: one per TEXT_PAGE_LINES lines or per TEXT_PAGE_CHARS characters, whichever is more. East Asian
 * characters count TEXT_PAGE_CJK_WEIGHT each. With `markup` (HTML) the tags, scripts and styles are removed first and
 * only non-blank lines count, so markup and inline code do not bill as pages of reading. The first
 * TEXT_MEASURE_SAMPLE_CHARS are measured and a longer text is scaled by its length, so the cost is bounded.
 */
export function textPageCount(text: string, options: { markup?: boolean } = {}): number {
  if (text.length > TEXT_MEASURE_SAMPLE_CHARS) {
    const sampled = measuredTextPages(text.slice(0, TEXT_MEASURE_SAMPLE_CHARS), options);
    return Math.max(1, Math.ceil(sampled * (text.length / TEXT_MEASURE_SAMPLE_CHARS)));
  }
  return measuredTextPages(text, options);
}

/**
 * The same text rule as textPageCount over the whole text, never sampled: the worker's measured count of a text file, which
 * billing reads (worker/src/lib/text-page-count.ts). The caller bounds the text's size.
 */
export function measuredTextPages(text: string, options: { markup?: boolean } = {}): number {
  const visible = options.markup ? stripHtmlMarkup(text) : text;
  const lines = options.markup ? visible.split(/\r?\n/).filter((line) => line.trim() !== "").length : visible.split(/\r?\n/).length;
  const trimmed = visible.trim();
  let chars = trimmed.length;
  for (const char of trimmed) if (isCjkCodePoint(char.codePointAt(0)!)) chars += TEXT_PAGE_CJK_WEIGHT - 1;
  return Math.max(1, Math.ceil(lines / TEXT_PAGE_LINES), Math.ceil(chars / TEXT_PAGE_CHARS));
}

export const uploadMediaEstimateSchema = z.object({
  audioFiles: z.number().int().nonnegative(),
  videoFiles: z.number().int().nonnegative(),
  audioMinutes: z.number().nonnegative(),
  videoMinutes: z.number().nonnegative(),
  /** True when a file's duration was not supplied and was guessed from its size. */
  durationsAssumed: z.boolean(),
  /** Whether the project reads sampled video frames (`mediaVideo.enabled`), which triples a video minute's price. */
  videoFrames: z.boolean(),
  /** Credits for the media files: `low` reads video from its audio track only, `high` also reads frames. */
  credits: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  /**
   * The cheaper way to process these files, or null when the price is already the lowest. Pass `pipeline` as the
   * upload's pipeline overrides to apply it to that upload only.
   */
  lighter: z.object({
    kind: z.literal("video-audio-track-only"),
    credits: z.number().nonnegative(),
    savedCredits: z.number().nonnegative(),
    pipeline: z.object({ mediaVideo: z.object({ enabled: z.literal(false) }) }),
  }).nullable(),
});
export type UploadMediaEstimate = z.infer<typeof uploadMediaEstimateSchema>;

export type UploadMediaFile = { name: string; size: number; type?: string | null; durationSeconds?: number };

/**
 * What the audio and video among `files` will cost, at the pricing provider's media prices (`mediaRichPages`), rounded
 * up per file. A video read from its audio track alone bills as audio, which is the cheaper option offered as `lighter`
 * when the provider prices frames higher. Null when no file is media.
 */
export function estimateUploadMedia(files: readonly UploadMediaFile[], options: { videoFrames: boolean }): UploadMediaEstimate | null {
  let audioFiles = 0;
  let videoFiles = 0;
  let audioSeconds = 0;
  let videoSeconds = 0;
  let audioPages = 0;
  let videoFramePages = 0;
  let videoTrackPages = 0;
  let assumed = false;
  for (const file of files) {
    const kind = uploadMediaKind(file);
    if (!kind) continue;
    const known = typeof file.durationSeconds === "number" && Number.isFinite(file.durationSeconds) && file.durationSeconds > 0;
    if (!known) assumed = true;
    const seconds = known
      ? file.durationSeconds!
      : (Math.max(0, file.size) / MEDIA_BYTES_PER_MINUTE[kind]) * 60;
    if (kind === "audio") {
      audioFiles += 1;
      audioSeconds += seconds;
      audioPages += mediaRichPages("audio", seconds);
    } else {
      videoFiles += 1;
      videoSeconds += seconds;
      videoFramePages += mediaRichPages("video", seconds);
      videoTrackPages += mediaRichPages("audio", seconds);
    }
  }
  if (audioFiles + videoFiles === 0) return null;
  const low = pageCredits("rich", audioPages + videoTrackPages);
  const high = options.videoFrames ? pageCredits("rich", audioPages + videoFramePages) : low;
  return uploadMediaEstimateSchema.parse({
    audioFiles,
    videoFiles,
    audioMinutes: round(audioSeconds / 60),
    videoMinutes: round(videoSeconds / 60),
    durationsAssumed: assumed,
    videoFrames: options.videoFrames,
    credits: { low, high },
    lighter: options.videoFrames && videoFiles > 0 && high > low
      ? { kind: "video-audio-track-only", credits: low, savedCredits: high - low, pipeline: { mediaVideo: { enabled: false } } }
      : null,
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
