/** Cheap evidence, not a calibrated completeness score. PDF storage bytes and UTF-8 text
 * bytes are different quantities: fonts, vector commands and compression prevent a conversion.
 */
import { sanitizeExtractedMarkdown } from "./extracted-markdown.js";

export function pageTextYield(text: string, expectedCharacters: number) {
  const clean = sanitizeExtractedMarkdown(text).markdown
    .replace(/artifact:\/\/externalized-data-uri/g, "");
  const actualCharacters = clean.trim().length;
  const expected = Number.isSafeInteger(expectedCharacters) && expectedCharacters >= 0
    ? expectedCharacters : null;
  return {
    actualTextBytes: Buffer.byteLength(clean.trim(), "utf8"),
    actualCharacters,
    expectedCharacters: expected,
    // Only flag gross loss on substantial pages. Short titles, blank pages and unknown
    // expectations are not evidence of missing text. UTF-8 width must not penalize CJK.
    substantialDeficit: expected !== null && expected >= 500 && actualCharacters < expected * 0.2,
  };
}

/** Rounded, embedded stream sizes from pdfimages -list, never exported PNG/PPM sizes.
 * Masks count as storage; repeated object references count once per page. Shared images
 * on different pages are attributed to each page, so these totals must not be summed
 * and subtracted from document file size. Unknown/malformed rows make that page unknown.
 */
export function embeddedImageBytesByPage(stdout: string): Map<number, number | null> {
  const pages = new Map<number, { bytes: number; seen: Set<string>; unknown: boolean }>();
  let count = 0;
  for (const line of stdout.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (!/^\d+$/.test(f[0] ?? "")) continue;
    // Do not return apparently complete totals for a truncated hostile listing.
    if (++count > 100_000) return new Map();
    const page = Number(f[0]);
    if (!Number.isSafeInteger(page) || page < 1) continue;
    const entry = pages.get(page) ?? { bytes: 0, seen: new Set<string>(), unknown: false };
    pages.set(page, entry);
    const size = /^(\d+(?:\.\d+)?)([BKMG]?)$/.exec(f[14] ?? "");
    const bytes = size ? Math.round(Number(size[1]) * 1024 ** ("BKMG".indexOf(size[2] || "B"))) : NaN;
    if (!["image", "mask", "smask", "stencil"].includes(f[2] ?? "") || !Number.isSafeInteger(bytes) || bytes < 0) {
      entry.unknown = true;
      continue;
    }
    // Inline images have no reusable object identity: count each occurrence.
    const id = /^\d+$/.test(f[10] ?? "") && /^\d+$/.test(f[11] ?? "")
      ? `${f[10]}:${f[11]}` : `inline:${count}`;
    if (!entry.seen.has(id)) {
      entry.seen.add(id);
      entry.bytes += bytes;
      if (!Number.isSafeInteger(entry.bytes)) entry.unknown = true;
    }
  }
  return new Map([...pages].map(([page, entry]) => [page, entry.unknown ? null : entry.bytes]));
}
