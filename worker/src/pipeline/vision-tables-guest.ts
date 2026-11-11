/**
 * VM guest: find the HTML tables in vision-model page transcriptions and read them into typed rows.
 *
 * Runs only inside the credential-free parser VM in the service profile (`scripts/vision-tables.mjs`); the host never
 * tokenizes, entity-decodes or builds a tree from model output. The result is a typed segment list per page that the
 * host validates (offsets, integers, string bounds) and renders itself (`vision-tables-vm.ts`): no HTML from the guest
 * is ever copied into the page.
 *
 * Region rules (so a broken table never deletes page content):
 * - a table starts at an ASCII case-insensitive `<table` outside fenced code, inline code spans and GFM pipe-table rows;
 * - it ends after the `>` of its own matching `</table>`, or, when the model never closed it, before the first blank line
 *   that is followed by a line not starting with `<`, or at MAX_REGION_CHARS; text after that is kept verbatim;
 * - a `</table>` that ends its line, followed by a line not starting with `<`, also ends the region at any nesting depth
 *   (an unbalanced inner `<table>` cannot pull the following prose into a cell);
 * - parse5 parses only that region, so a void, raw-text or unclosed element inside it (`<embed>`, `<script>`, `<xmp>`)
 *   can only affect the region itself;
 * - table-family tags outside any region (a stray `</table>` or `<td>`) are marked for escaping.
 * Case folding is ASCII-only, so offsets into the original text stay valid for every script.
 *
 * Text rules (the owner's rule: a rebuilt table never loses text the region had):
 * - every text node is kept, whatever element holds it: the contents of `<script>`, `<style>`, `<template>`,
 *   `<textarea>`, `<xmp>`, `<plaintext>`, `<noscript>`, `<iframe>`, `<select>` and foreign (SVG/MathML) elements become
 *   cell text, which the host escapes, so it is inert. Comment text and an image's `alt` text are kept the same way;
 * - nothing is ever truncated. A region that would need truncating or dropping (a cell or text run over
 *   VISION_TABLE_MAX_TEXT_CHARS, more than VISION_TABLE_MAX_ROWS rows or VISION_TABLE_MAX_CELLS cells, more than
 *   VISION_TABLE_MAX_EXTRA text runs outside cells, nesting deeper than VISION_TABLE_MAX_NESTING, or a region cut at
 *   VISION_TABLE_MAX_REGION_CHARS) is returned as a `raw` segment with its reason: the host keeps that region's source
 *   unchanged as inert, escaped text and records the reason.
 */
import { parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5";

export const VISION_TABLE_MAX_PAGE_CHARS = 1024 * 1024;
export const VISION_TABLE_MAX_REGION_CHARS = 256 * 1024;
export const VISION_TABLE_MAX_ROWS = 2_000;
export const VISION_TABLE_MAX_CELLS = 20_000;
export const VISION_TABLE_MAX_SPAN = 100;
export const VISION_TABLE_MAX_TEXT_CHARS = 16 * 1024;
export const VISION_TABLE_MAX_PAGES = 512;
export const VISION_TABLE_MAX_NESTING = 16;
/** Text runs outside cells (captions, foster-parented text, trailing content) a rebuilt region may carry. */
export const VISION_TABLE_MAX_EXTRA = 4096;

/** Why a region is kept as its own source (escaped) instead of rebuilt. */
export const VISION_TABLE_RAW_REASONS = ["cell-text", "extra-text", "rows", "cells", "extra-count", "nesting", "region-size"] as const;
export type VisionTableRawReason = (typeof VISION_TABLE_RAW_REASONS)[number];

export interface VisionTableCell { h: boolean; rs: number; cs: number; t: string }
export interface VisionTableRow { head: boolean; cells: VisionTableCell[] }
export type VisionTableSegment =
  | { k: "keep"; from: number; to: number }
  | { k: "lt"; from: number; to: number }
  | { k: "table"; from: number; to: number; rows: VisionTableRow[]; extra: string[] }
  | { k: "raw"; from: number; to: number; reason: VisionTableRawReason };
/**
 * Per page: its segments; null when the page holds no table markup (returned unchanged); false when the guest could not
 * read it (the host then escapes every table tag in it: fail closed).
 */
export type VisionTablePageResult = VisionTableSegment[] | null | false;

const TABLE_FAMILY = /<(\/?)(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)(?=[\s/>])/gi;
const HAS_TABLE_MARKUP = /<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)[\s/>]/i;

/** Lowercase A–Z only: one UTF-16 unit in, one out, so indexes match the original string. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (s) => s.toLowerCase());
}

const isDelimiter = (code: number) => Number.isNaN(code) || code === 62 || code === 47 || code === 32 || (code >= 9 && code <= 13);

/** Ranges [from, to) of the input that are code (fences, inline code spans) or GFM pipe-table rows. */
function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const paragraphs: Array<[number, number]> = [];
  let fence: { char: string; length: number; start: number } | null = null;
  let paragraph = -1;
  const endParagraph = (at: number) => { if (paragraph !== -1) paragraphs.push([paragraph, at]); paragraph = -1; };
  for (let lineStart = 0; lineStart <= text.length;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.char && fenceMatch[1]!.length >= fence.length && !line.slice(fenceMatch[0].length).trim()) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
      }
    } else if (fenceMatch && !(fenceMatch[1]![0] === "`" && line.slice(fenceMatch[0].length).includes("`"))) {
      endParagraph(lineStart);
      fence = { char: fenceMatch[1]![0]!, length: fenceMatch[1]!.length, start: lineStart };
    } else if (!line.trim()) {
      endParagraph(lineStart);
    } else {
      if (/^ {0,3}\|/.test(line)) ranges.push([lineStart, lineEnd]);
      if (paragraph === -1) paragraph = lineStart;
    }
    if (newline === -1) { endParagraph(text.length); break; }
    lineStart = newline + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  // Inline code spans: a run of N backticks closes at the next run of exactly N in the same paragraph. A length with no
  // closer is remembered, so the scan stays linear in the paragraph.
  // Forward-only backtick search shared by all paragraphs, so a page with no backticks is scanned once, not per paragraph.
  let cachedFrom = -1, cachedTick = -1;
  const nextTick = (from: number) => {
    if (cachedFrom === -1 || from < cachedFrom || (cachedTick !== -1 && cachedTick < from)) { cachedFrom = from; cachedTick = text.indexOf("`", from); }
    return cachedTick;
  };
  for (const [start, end] of paragraphs) {
    const failed = new Set<number>();
    let at = start;
    while (at < end) {
      const tick = nextTick(at);
      if (tick === -1 || tick >= end) break;
      let runEnd = tick;
      while (runEnd < end && text.charCodeAt(runEnd) === 96) runEnd += 1;
      const length = runEnd - tick;
      if (failed.has(length)) { at = runEnd; continue; }
      let search = runEnd, close = -1;
      while (search < end) {
        const next = nextTick(search);
        if (next === -1 || next >= end) break;
        let stop = next;
        while (stop < end && text.charCodeAt(stop) === 96) stop += 1;
        if (stop - next === length) { close = stop; break; }
        search = stop;
      }
      if (close === -1) { failed.add(length); at = runEnd; continue; }
      ranges.push([tick, close]);
      at = close;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** Skip-list over protected ranges, queried with increasing positions. */
class Protected {
  private index = 0;
  constructor(private readonly ranges: Array<[number, number]>) {}
  /** The end of the protected range holding `at`, or -1. */
  covering(at: number): number {
    while (this.index < this.ranges.length && this.ranges[this.index]![1] <= at) this.index += 1;
    const range = this.ranges[this.index];
    return range && range[0] <= at && at < range[1] ? range[1] : -1;
  }
}

/** Forward-only search for blank lines, shared by every region of a page so the whole page is scanned once. */
class BlankLines {
  private readonly pattern = /\n[ \t]*\n[ \t\n]*/g;
  private found: RegExpExecArray | null = null;
  private searchedFrom = -1;
  constructor(private readonly text: string) {}
  next(from: number): RegExpExecArray | null {
    if (this.searchedFrom !== -1 && this.searchedFrom <= from && (this.found === null || this.found.index >= from)) return this.found;
    this.pattern.lastIndex = from;
    this.found = this.pattern.exec(this.text);
    this.searchedFrom = from;
    return this.found;
  }
}

/** A limit that would force truncating or dropping region text: the region is kept as source instead. */
class RegionLimit extends Error {
  constructor(readonly reason: VisionTableRawReason) { super(reason); }
}

/**
 * The end (exclusive) of a table region that starts at `start`, and whether the region was cut at
 * VISION_TABLE_MAX_REGION_CHARS (or nested too deep) before its table ended. Linear: every search moves forward.
 */
function regionEnd(text: string, lower: string, start: number, blanks: BlankLines): { end: number; cut: VisionTableRawReason | null } {
  const result = regionEndInner(text, lower, start, blanks);
  return typeof result === "number" ? { end: result, cut: null } : result;
}

function regionEndInner(text: string, lower: string, start: number, blanks: BlankLines): number | { end: number; cut: VisionTableRawReason } {
  const cutAtLimit = (limit: number) => (limit < text.length ? { end: limit, cut: "region-size" as const } : limit);
  const limit = Math.min(text.length, start + VISION_TABLE_MAX_REGION_CHARS);
  const nextBlank = (from: number) => { const found = blanks.next(from); return found && found.index < limit ? found : null; };
  let depth = 0;
  let at = start;
  while (at < limit) {
    const lt = lower.indexOf("<", at);
    const gap = nextBlank(at);
    if (gap && (lt === -1 || gap.index < lt)) {
      // A blank line followed by a line that is not markup ends an unclosed table.
      const next = gap.index + gap[0].length;
      if (next >= text.length || text[next] !== "<") return gap.index;
      at = next;
      continue;
    }
    if (lt === -1 || lt >= limit) return cutAtLimit(limit);
    if (lower.startsWith("<table", lt) && isDelimiter(lower.charCodeAt(lt + 6))) {
      depth += 1;
      // Real transcriptions nest a table or two; deeper nesting is degenerate output (and parse5's scope checks grow with
      // depth): the region up to its end is kept as source, so no text is lost.
      if (depth > VISION_TABLE_MAX_NESTING) return { end: nestedRegionEnd(text, lt, limit), cut: "nesting" };
    }
    else if (lower.startsWith("</table", lt) && isDelimiter(lower.charCodeAt(lt + 7))) {
      depth -= 1;
      const gt = text.indexOf(">", lt);
      if (gt === -1 || gt >= limit) return cutAtLimit(limit);
      if (depth <= 0) return gt + 1;
      // An unbalanced inner `<table>`: a close that ends its line before a line of prose ends the region anyway.
      const lineEnd = /^[ \t]*\r?\n/.exec(text.slice(gt + 1, gt + 1 + 256));
      if (lineEnd) {
        const next = gt + 1 + lineEnd[0].length;
        if (next < text.length && text[next] !== "<" && text[next] !== "\n" && !/^[ \t]+</.test(text.slice(next, next + 256))) return gt + 1;
      }
    }
    at = lt + 1;
  }
  return cutAtLimit(limit);
}

/** Where a too-deeply nested region ends: its first blank line before non-markup text, else the region limit. */
function nestedRegionEnd(text: string, from: number, limit: number): number {
  const blank = /\n[ \t]*\n[ \t\n]*(?=[^<\s])/g;
  blank.lastIndex = from;
  const found = blank.exec(text);
  return found && found.index < limit ? found.index : limit;
}

/** Elements that separate words (block boundaries, line breaks, cell edges); every other element joins its text. */
const BREAKS = new Set(["br", "p", "div", "li", "ul", "ol", "tr", "td", "th", "table", "thead", "tbody", "tfoot", "caption", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "dt", "dd", "dl", "section", "article", "header", "footer", "figure", "figcaption"]);

const isElement = (node: Tree.Node): node is Tree.Element => "tagName" in node;

/**
 * Every character of text under `node`, in source order: text nodes of every element (raw-text and RCDATA elements
 * included; the host escapes it all), template contents, comments and image alt text. Nothing is skipped or cut.
 */
function textOf(node: Tree.Node, out: string[]): void {
  if (node.nodeName === "#text") { out.push((node as Tree.TextNode).value); return; }
  if (node.nodeName === "#comment") { out.push(" ", (node as Tree.CommentNode).data, " "); return; }
  if (!isElement(node)) return;
  const breaks = BREAKS.has(node.tagName) || node.tagName === "img";
  if (breaks) out.push(" ");
  if (node.tagName === "img") {
    const alt = node.attrs.find((attr) => attr.name === "alt")?.value;
    if (alt) out.push(alt);
  }
  const children = node.tagName === "template" ? (node as Tree.Template).content.childNodes : node.childNodes;
  for (const child of children) textOf(child, out);
  if (breaks) out.push(" ");
}

/** The text of a node; a run longer than VISION_TABLE_MAX_TEXT_CHARS keeps the whole region as source. */
const plainText = (node: Tree.Node, reason: VisionTableRawReason) => {
  const out: string[] = [];
  textOf(node, out);
  // Trimmed: the separators added at block edges are not the region's text.
  const text = out.join("").trim();
  if (text.length > VISION_TABLE_MAX_TEXT_CHARS) throw new RegionLimit(reason);
  return text;
};

function spanOf(element: Tree.Element, name: "rowspan" | "colspan"): number {
  const value = element.attrs.find((attr) => attr.name === name)?.value.trim() ?? "";
  if (!/^[1-9]\d{0,2}$/.test(value)) return 1;
  const n = Number(value);
  return n <= VISION_TABLE_MAX_SPAN ? n : 1;
}

/** Text outside any cell: kept after the table. */
function pushExtra(extra: string[], node: Tree.Node): void {
  const text = plainText(node, "extra-text");
  if (!text.trim()) return;
  if (extra.length >= VISION_TABLE_MAX_EXTRA) throw new RegionLimit("extra-count");
  extra.push(text);
}

/** Rows of one parsed table, in source order; text outside cells goes to `extra`. Throws RegionLimit past a cap. */
function readRows(table: Tree.Element, extra: string[]): VisionTableRow[] {
  const rows: VisionTableRow[] = [];
  let cells = 0;
  const visitRow = (tr: Tree.Element, head: boolean) => {
    const row: VisionTableRow = { head, cells: [] };
    for (const child of tr.childNodes) {
      if (!isElement(child) || (child.tagName !== "td" && child.tagName !== "th")) { pushExtra(extra, child); continue; }
      const text = plainText(child, "cell-text");
      if (cells >= VISION_TABLE_MAX_CELLS) throw new RegionLimit("cells");
      row.cells.push({ h: child.tagName === "th", rs: spanOf(child, "rowspan"), cs: spanOf(child, "colspan"), t: text });
      cells += 1;
    }
    if (!row.cells.length) return;
    if (rows.length >= VISION_TABLE_MAX_ROWS) throw new RegionLimit("rows");
    rows.push(row);
  };
  for (const child of table.childNodes) {
    if (!isElement(child) || child.tagName === "caption") { pushExtra(extra, child); continue; }
    if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
      for (const tr of child.childNodes) {
        if (isElement(tr) && tr.tagName === "tr") visitRow(tr, child.tagName === "thead");
        else pushExtra(extra, tr);
      }
      continue;
    }
    if (child.tagName === "tr") { visitRow(child, false); continue; }
    pushExtra(extra, child);
  }
  return rows;
}

function readRegion(region: string): { rows: VisionTableRow[]; extra: string[] } {
  const extra: string[] = [];
  const root = parseFragment(region);
  let rows: VisionTableRow[] = [];
  let found = false;
  for (const node of root.childNodes) {
    if (!found && isElement(node) && node.tagName === "table") { found = true; rows = readRows(node, extra); continue; }
    // Foster-parented or trailing content, and any further table, stays as text after the table.
    pushExtra(extra, node);
  }
  return { rows, extra };
}

/** Segments for one page, or null when it holds no table markup outside code. */
export function readVisionTables(text: string): VisionTablePageResult {
  if (!HAS_TABLE_MARKUP.test(text)) return null;
  if (text.length > VISION_TABLE_MAX_PAGE_CHARS) return false;
  const lower = asciiLower(text);
  const guard = new Protected(protectedRanges(text));
  const blanks = new BlankLines(text);
  const segments: VisionTableSegment[] = [];
  let kept = 0;
  const keepTo = (to: number) => { if (to > kept) segments.push({ k: "keep", from: kept, to }); kept = Math.max(kept, to); };
  TABLE_FAMILY.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TABLE_FAMILY.exec(text)) !== null) {
    const at = match.index;
    if (at < kept) continue;
    const covered = guard.covering(at);
    if (covered !== -1) { TABLE_FAMILY.lastIndex = Math.max(TABLE_FAMILY.lastIndex, covered); continue; }
    const isTableOpen = !match[1] && lower.startsWith("<table", at) && isDelimiter(lower.charCodeAt(at + 6));
    if (!isTableOpen) {
      // A stray table-family tag outside any table: its `<` is escaped so it renders as text.
      keepTo(at);
      segments.push({ k: "lt", from: at, to: at + 1 });
      kept = at + 1;
      continue;
    }
    const { end, cut } = regionEnd(text, lower, at, blanks);
    keepTo(at);
    if (cut) segments.push({ k: "raw", from: at, to: end, reason: cut });
    else {
      try {
        const { rows, extra } = readRegion(text.slice(at, end));
        segments.push({ k: "table", from: at, to: end, rows, extra });
      } catch (error) {
        if (!(error instanceof RegionLimit)) throw error;
        segments.push({ k: "raw", from: at, to: end, reason: error.reason });
      }
    }
    kept = end;
    TABLE_FAMILY.lastIndex = end;
  }
  keepTo(text.length);
  return segments;
}

/** One VM job: every page of a document. */
export function readVisionTablesBatch(pages: unknown): VisionTablePageResult[] {
  if (!Array.isArray(pages) || pages.length > VISION_TABLE_MAX_PAGES || pages.some((page) => typeof page !== "string")) throw new Error("invalid vision table batch");
  return (pages as string[]).map((page) => {
    try { return readVisionTables(page); } catch { return false; }
  });
}
