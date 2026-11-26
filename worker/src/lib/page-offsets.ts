/**
 * Page offset index: where each page of a stored Markdown artifact starts and how long it is, so a reader can fetch
 * "pages 400 to 420" of a large artifact with one ranged GET.
 *
 * The Markdown joins pages with form feeds (N pages, N-1 form feeds; a producer that terminates every page leaves a
 * trailing form feed, which adds no page). Offsets are UTF-8 byte offsets into the stored bytes. Page breaks are found by
 * scanning for byte 0x0C, which never occurs inside a multi-byte UTF-8 sequence; the text is never decoded here.
 *
 * Format (JSON Lines, one object per `\n`-terminated line):
 *   {"type":"doc","schema":"page-offsets/1","documentId":"…","sourceUri":"…","sourceBytes":N,"pageCount":N}
 *   {"type":"page","page":1,"start":0,"bytes":4312}   (one per page, in order; `bytes` excludes the form feed)
 *   {"type":"end","pages":N}
 *
 * The index is derived from customer files and read back from storage, so the reader is strict and bounded: it checks
 * total size, line length and line count before it parses, accepts only safe non-negative integers, and returns null (never
 * throws) for anything malformed or not matching what the caller expects. A null index means "no page addressing".
 */

export const PAGE_OFFSETS_SCHEMA = "page-offsets/1";
/** Reader bounds. */
export const PAGE_OFFSETS_MAX_PAGES = 100_000;
export const PAGE_OFFSETS_MAX_LINE_BYTES = 4096; // the doc line carries a storage URI
/** A page line is ~80 bytes at the largest values; 128 per page plus the doc and end lines. */
export const PAGE_OFFSETS_MAX_BYTES = PAGE_OFFSETS_MAX_PAGES * 128 + PAGE_OFFSETS_MAX_LINE_BYTES + 256;

const FORM_FEED = 0x0c;
const NEWLINE = 0x0a;

export interface PageOffsetIndex {
  documentId: string;
  sourceUri: string;
  /** Byte length of the Markdown the offsets describe. */
  sourceBytes: number;
  pageCount: number;
  /** starts[i] and lengths[i] are page i+1's first byte and byte length (form feed excluded). */
  starts: number[];
  lengths: number[];
}

/** Storage key of the index that belongs to a summary-evidence key: `.../summary-evidence/<id>.json` → `.../summary-evidence/<id>.pages.jsonl`. */
export function pageOffsetsKey(evidenceKey: string): string {
  return `${evidenceKey.replace(/\.json$/, "")}.pages.jsonl`;
}

/**
 * The index as JSON Lines, or null when the text's form-feed page count does not equal `pageCount` (never invent page
 * numbers), or pageCount is not a positive safe integer, or it exceeds PAGE_OFFSETS_MAX_PAGES.
 */
export function buildPageOffsetsJsonl(args: { markdown: Buffer; pageCount: number; documentId: string; sourceUri: string }): string | null {
  const { markdown, pageCount } = args;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PAGE_OFFSETS_MAX_PAGES) return null;
  const total = markdown.length;
  const docLine = `${JSON.stringify({
    type: "doc", schema: PAGE_OFFSETS_SCHEMA, documentId: args.documentId, sourceUri: args.sourceUri, sourceBytes: total, pageCount,
  })}\n`;
  if (Buffer.byteLength(docLine) > PAGE_OFFSETS_MAX_LINE_BYTES) return null;

  const lines: string[] = [docLine];
  let start = 0;
  let pages = 0;
  for (;;) {
    const at = markdown.indexOf(FORM_FEED, start);
    if (at < 0) {
      // A trailing form feed terminates the last page; otherwise the rest is the last page.
      if (start < total || total === 0 || pages === 0) {
        pages++;
        if (pages > pageCount) return null;
        lines.push(`{"type":"page","page":${pages},"start":${start},"bytes":${total - start}}\n`);
      }
      break;
    }
    pages++;
    if (pages > pageCount) return null;
    lines.push(`{"type":"page","page":${pages},"start":${start},"bytes":${at - start}}\n`);
    start = at + 1;
  }
  if (pages !== pageCount) return null;
  lines.push(`{"type":"end","pages":${pages}}\n`);
  return lines.join("");
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseLine(bytes: Buffer, from: number, to: number): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8", from, to));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Strict, bounded reader. Returns null (never throws) for anything malformed, truncated, oversized, non-monotonic, out of range, or not matching `expect`. */
export function parsePageOffsets(bytes: Buffer, expect: { documentId: string; sourceUri: string; sourceBytes: number }): PageOffsetIndex | null {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > PAGE_OFFSETS_MAX_BYTES) return null;
    if (bytes[bytes.length - 1] !== NEWLINE) return null; // truncated mid-line

    let cursor = 0;
    const nextLine = (): [number, number] | null => {
      if (cursor >= bytes.length) return null;
      const end = bytes.indexOf(NEWLINE, cursor);
      if (end < 0 || end - cursor > PAGE_OFFSETS_MAX_LINE_BYTES) return null;
      const range: [number, number] = [cursor, end];
      cursor = end + 1;
      return range;
    };

    const docRange = nextLine();
    if (!docRange) return null;
    const doc = parseLine(bytes, docRange[0], docRange[1]);
    if (!doc || !hasExactKeys(doc, ["type", "schema", "documentId", "sourceUri", "sourceBytes", "pageCount"])) return null;
    if (doc.type !== "doc" || doc.schema !== PAGE_OFFSETS_SCHEMA) return null;
    if (doc.documentId !== expect.documentId || doc.sourceUri !== expect.sourceUri) return null;
    const { sourceBytes, pageCount } = doc;
    if (!isCount(sourceBytes) || sourceBytes !== expect.sourceBytes) return null;
    if (!isCount(pageCount) || pageCount < 1 || pageCount > PAGE_OFFSETS_MAX_PAGES) return null;

    const starts = new Array<number>(pageCount);
    const lengths = new Array<number>(pageCount);
    let floor = 0; // end of the previous page
    for (let page = 1; page <= pageCount; page++) {
      const range = nextLine();
      if (!range) return null;
      const line = parseLine(bytes, range[0], range[1]);
      if (!line || !hasExactKeys(line, ["type", "page", "start", "bytes"]) || line.type !== "page" || line.page !== page) return null;
      const { start, bytes: length } = line;
      if (!isCount(start) || !isCount(length)) return null;
      if (start < floor || start + length > sourceBytes) return null;
      starts[page - 1] = start;
      lengths[page - 1] = length;
      floor = start + length;
    }

    const endRange = nextLine();
    if (!endRange) return null;
    const end = parseLine(bytes, endRange[0], endRange[1]);
    if (!end || !hasExactKeys(end, ["type", "pages"]) || end.type !== "end" || end.pages !== pageCount) return null;
    if (cursor !== bytes.length) return null; // extra lines

    return { documentId: expect.documentId, sourceUri: expect.sourceUri, sourceBytes, pageCount, starts, lengths };
  } catch {
    return null;
  }
}

/** Inclusive byte range covering pages startPage..endPage (1-based, clamped to the index), form feeds between them included; null when the clamped range is empty. */
export function pageByteRange(index: PageOffsetIndex, startPage: number, endPage: number): { start: number; end: number } | null {
  if (!Number.isFinite(startPage) || !Number.isFinite(endPage)) return null;
  const first = Math.max(1, Math.floor(startPage));
  const last = Math.min(index.pageCount, Math.floor(endPage));
  if (first > last) return null;
  const start = index.starts[first - 1];
  const lastStart = index.starts[last - 1];
  const lastLength = index.lengths[last - 1];
  if (start === undefined || lastStart === undefined || lastLength === undefined) return null;
  const end = lastStart + lastLength - 1;
  return end >= start ? { start, end } : null;
}
