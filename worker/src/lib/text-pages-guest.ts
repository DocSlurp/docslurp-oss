/**
 * VM guest: count a text file's pages with the shared text rule (measuredTextPages over the whole decoded text).
 *
 * Runs only inside the credential-free parser VM in the service profile (`scripts/text-pages.mjs`); the host never decodes
 * a text source there (lib/text-page-count.ts refuses). The result is one page count and the byte length the guest read,
 * which the host checks against the staged file's own size and the most pages that many bytes can hold before it records
 * the count. Outside the service profile the host runs this same function in-process.
 */
import { open } from "node:fs/promises";

import { decodeTextBytes, type FileEncoding } from "@docslurp/shared/file-sniff";
import { measuredTextPages } from "@docslurp/shared/text-page-rule";

/**
 * Largest text source measured in full: the whole decoded text is held once in memory. A larger text file is refused
 * (failed, never billed) rather than billed on an estimate.
 */
export const TEXT_MEASURE_MAX_BYTES = 128 * 1024 * 1024;

export const TEXT_PAGE_ENCODINGS: ReadonlySet<FileEncoding> = new Set<FileEncoding>(["utf-8", "utf-8-bom", "utf-16le", "utf-16be", "8-bit"]);

export interface TextPagesOptions {
  /** The encoding the quarantine sniff recorded; null lets the decoder detect it from the bytes. */
  encoding: FileEncoding | null;
  /** HTML: tags, scripts and styles are removed and only non-blank lines count. */
  markup: boolean;
}

export interface TextPagesResult {
  pages: number;
  bytes: number;
}

/** Options as the host wrote them, refused when anything is unexpected. */
export function parseTextPagesOptions(raw: unknown): TextPagesOptions {
  const value = raw as Partial<TextPagesOptions> | null;
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => key !== "encoding" && key !== "markup")) throw new Error("invalid text pages options");
  if (typeof value.markup !== "boolean") throw new Error("invalid text pages options");
  if (!(value.encoding === null || (typeof value.encoding === "string" && TEXT_PAGE_ENCODINGS.has(value.encoding)))) throw new Error("invalid text pages options");
  return { encoding: value.encoding, markup: value.markup };
}

/** Pages of decoded `bytes` by the text rule; an empty file is one page. */
export function measureTextPagesBytes(bytes: Uint8Array, options: TextPagesOptions): TextPagesResult {
  if (bytes.length > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
  const pages = bytes.length === 0 ? 1 : measuredTextPages(decodeTextBytes(bytes, options.encoding ?? undefined), { markup: options.markup });
  return { pages, bytes: bytes.length };
}

/** Reads at most TEXT_MEASURE_MAX_BYTES + 1 bytes of `filePath` (a larger file is refused, never read in full). */
export async function measureTextPagesFile(filePath: string, options: TextPagesOptions): Promise<TextPagesResult> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error("text file changed while it was read");
    return measureTextPagesBytes(buffer, options);
  } finally {
    await handle.close();
  }
}
