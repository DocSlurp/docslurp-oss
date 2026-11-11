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
 * - parse5 parses only that region, so a void, raw-text or unclosed element inside it (`<embed>`, `<script>`, `<xmp>`)
 *   can only affect the region itself;
 * - table-family tags outside any region (a stray `</table>` or `<td>`) are marked for escaping.
 * Case folding is ASCII-only, so offsets into the original text stay valid for every script.
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

export interface VisionTableCell { h: boolean; rs: number; cs: number; t: string }
export interface VisionTableRow { head: boolean; cells: VisionTableCell[] }
export type VisionTableSegment =
  | { k: "keep"; from: number; to: number }
  | { k: "lt"; from: number; to: number }
  | { k: "table"; from: number; to: number; rows: VisionTableRow[]; extra: string[] };
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

/** The end (exclusive) of a table region that starts at `start`. Linear: every search moves forward. */
function regionEnd(text: string, lower: string, start: number, blanks: BlankLines): number {
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
    if (lt === -1 || lt >= limit) return limit;
    if (lower.startsWith("<table", lt) && isDelimiter(lower.charCodeAt(lt + 6))) {
      depth += 1;
      // Real transcriptions nest a table or two; deeper nesting is degenerate output (and parse5's scope checks grow with
      // depth): the page is refused, so the host escapes its table tags and keeps the text.
      if (depth > VISION_TABLE_MAX_NESTING) throw new Error("table nesting exceeds limit");
    }
    else if (lower.startsWith("</table", lt) && isDelimiter(lower.charCodeAt(lt + 7))) {
      depth -= 1;
      if (depth <= 0) {
        const gt = text.indexOf(">", lt);
        return gt === -1 || gt >= limit ? limit : gt + 1;
      }
    }
    at = lt + 1;
  }
  return limit;
}

const DROP = new Set(["script", "style", "template", "noscript", "textarea", "title", "iframe", "object", "embed", "noembed", "noframes", "xmp", "plaintext", "select", "head"]);
/** Elements that separate words (block boundaries, line breaks, cell edges); every other element joins its text. */
const BREAKS = new Set(["br", "p", "div", "li", "ul", "ol", "tr", "td", "th", "table", "thead", "tbody", "tfoot", "caption", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "dt", "dd", "dl", "section", "article", "header", "footer", "figure", "figcaption"]);

const isElement = (node: Tree.Node): node is Tree.Element => "tagName" in node;

function textOf(node: Tree.Node, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  if (node.nodeName === "#text") {
    const value = (node as Tree.TextNode).value;
    out.push(value.slice(0, budget.left));
    budget.left -= value.length;
    return;
  }
  if (!isElement(node)) return;
  if (DROP.has(node.tagName)) return;
  const breaks = BREAKS.has(node.tagName);
  if (breaks) out.push(" ");
  const children = node.tagName === "template" ? [] : node.childNodes;
  for (const child of children) textOf(child, out, budget);
  if (breaks) out.push(" ");
}

const plainText = (node: Tree.Node, limit = VISION_TABLE_MAX_TEXT_CHARS) => {
  const out: string[] = [];
  textOf(node, out, { left: limit });
  return out.join("");
};

function spanOf(element: Tree.Element, name: "rowspan" | "colspan"): number {
  const value = element.attrs.find((attr) => attr.name === name)?.value.trim() ?? "";
  if (!/^[1-9]\d{0,2}$/.test(value)) return 1;
  const n = Number(value);
  return n <= VISION_TABLE_MAX_SPAN ? n : 1;
}

/** Rows of one parsed table, in source order; text past the row/cell caps goes to `extra`. */
function readRows(table: Tree.Element, extra: string[]): VisionTableRow[] {
  const rows: VisionTableRow[] = [];
  let cells = 0;
  const visitRow = (tr: Tree.Element, head: boolean) => {
    const row: VisionTableRow = { head, cells: [] };
    for (const child of tr.childNodes) {
      if (!isElement(child)) { const t = plainText(child); if (t.trim()) extra.push(t); continue; }
      if (child.tagName !== "td" && child.tagName !== "th") { const t = plainText(child); if (t.trim()) extra.push(t); continue; }
      const text = plainText(child);
      if (rows.length >= VISION_TABLE_MAX_ROWS || cells >= VISION_TABLE_MAX_CELLS) { if (text.trim()) extra.push(text); continue; }
      row.cells.push({ h: child.tagName === "th", rs: spanOf(child, "rowspan"), cs: spanOf(child, "colspan"), t: text });
      cells += 1;
    }
    if (row.cells.length && rows.length < VISION_TABLE_MAX_ROWS) rows.push(row);
  };
  for (const child of table.childNodes) {
    if (!isElement(child)) { const t = plainText(child); if (t.trim()) extra.push(t); continue; }
    if (child.tagName === "caption") { const t = plainText(child); if (t.trim()) extra.push(t); continue; }
    if (child.tagName === "thead" || child.tagName === "tbody" || child.tagName === "tfoot") {
      for (const tr of child.childNodes) {
        if (isElement(tr) && tr.tagName === "tr") visitRow(tr, child.tagName === "thead");
        else { const t = plainText(tr); if (t.trim()) extra.push(t); }
      }
      continue;
    }
    if (child.tagName === "tr") { visitRow(child, false); continue; }
    const t = plainText(child);
    if (t.trim()) extra.push(t);
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
    const t = plainText(node);
    if (t.trim()) extra.push(t);
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
    const end = regionEnd(text, lower, at, blanks);
    keepTo(at);
    const { rows, extra } = readRegion(text.slice(at, end));
    segments.push({ k: "table", from: at, to: end, rows, extra: extra.map((t) => t.slice(0, VISION_TABLE_MAX_TEXT_CHARS)).filter((t) => t.trim()).slice(0, 4096) });
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
