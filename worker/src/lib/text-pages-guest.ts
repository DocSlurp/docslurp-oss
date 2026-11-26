/**
 * VM guest: a text file's pages by the shared text rule (measuredTextPages over the whole decoded text), taken by the
 * quarantine inspection every file already goes through (scripts/quarantine-inspect.mjs), so counting costs no extra
 * command, download or staging.
 *
 * Under the VM-only floor this runs only inside the credential-free parser VM; the host never decodes a text source there
 * (lib/text-page-count.ts refuses). The answer is the page count (and, for HTML, the count with markup removed) and the
 * byte length the guest read, which the host checks against the staged file's size and against bounds it takes from fixed
 * byte comparisons of its own before it records anything. Outside the service profile the host runs this same function
 * in-process. This module is imported dynamically by the guest scripts, so an image without it (or without the shared
 * `text-page-rule` subpath) still inspects every file; it only lacks the text answer, and the contract does not advertise
 * the capability.
 */
import { decodeTextBytes, type FileEncoding } from "@docslurp/shared/file-sniff";
import { measuredTextPages } from "@docslurp/shared/text-page-rule";

/**
 * Largest text source measured in full: the whole decoded text is held once in memory. A larger text file is refused
 * (failed, never billed) rather than billed on an estimate.
 */
export const TEXT_MEASURE_MAX_BYTES = 128 * 1024 * 1024;

export const TEXT_PAGE_ENCODINGS: ReadonlySet<FileEncoding> = new Set<FileEncoding>(["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "8-bit"]);

/** What the host asks of the inspection: count pages, with markup removed too (HTML), even when the sniff says binary. */
export interface TextPagesRequest {
  /** Also count with HTML markup removed (`markupPages`). The guest does so on its own when the sniff says HTML. */
  markup: boolean;
  /** Count even when the sniff found no text encoding (a file the host will treat as text by its declared type). */
  force: boolean;
}

/**
 * The inspection's text answer: `pages` by the plain rule, `markupPages` with HTML markup removed (when asked or sniffed
 * as HTML), and `bytes`, the length the guest measured. Null in the result: not measured (not asked, not text, too large).
 */
export interface TextPagesInspection {
  bytes: number;
  pages: number;
  markupPages?: number;
}

/** The request as the host wrote it into the guest's options, refused when anything is unexpected. */
export function parseTextPagesRequest(raw: unknown): TextPagesRequest | null {
  if (raw === undefined || raw === null) return null;
  const value = raw as Partial<TextPagesRequest>;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "markup" && key !== "force")
    || typeof value.markup !== "boolean" || typeof value.force !== "boolean") throw new Error("invalid text pages request");
  return { markup: value.markup, force: value.force };
}

/** Pages of decoded `bytes` by the text rule; an empty file is one page. */
export function measureTextPagesBytes(bytes: Uint8Array, options: { encoding: FileEncoding | null; markup: boolean }): { pages: number; bytes: number } {
  if (bytes.length > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
  const pages = bytes.length === 0 ? 1 : measuredTextPages(decodeTextBytes(bytes, options.encoding ?? undefined), { markup: options.markup });
  return { pages, bytes: bytes.length };
}

/**
 * The text answer for the inspection result: measured when asked and the bytes are text by the sniff (or `force`), up to
 * TEXT_MEASURE_MAX_BYTES; null otherwise. Decodes once (by the sniffed encoding, or detection when none) and counts both
 * ways when markup is wanted.
 */
export function inspectTextPages(bytes: Uint8Array, sniffed: { mimeType: string | null; encoding: FileEncoding | null }, request: TextPagesRequest | null): TextPagesInspection | null {
  if (!request || bytes.length > TEXT_MEASURE_MAX_BYTES) return null;
  if (sniffed.encoding === null && !request.force) return null;
  const markup = request.markup || sniffed.mimeType === "text/html";
  if (bytes.length === 0) return { bytes: 0, pages: 1, ...(markup ? { markupPages: 1 } : {}) };
  const text = decodeTextBytes(bytes, sniffed.encoding ?? undefined);
  return { bytes: bytes.length, pages: measuredTextPages(text), ...(markup ? { markupPages: measuredTextPages(text, { markup: true }) } : {}) };
}
