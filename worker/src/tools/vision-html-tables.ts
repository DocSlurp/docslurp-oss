/**
 * HTML tables in a vision model's page transcription, rebuilt from a strict allow-list.
 *
 * The page transcription prompts let a model write a table with merged cells or a multi-row header as an HTML `<table>`
 * with `rowspan`/`colspan`, which a GFM pipe table cannot hold. Model output is untrusted: the page image can carry
 * instructions, and models emit invalid or looping markup. Nothing a model writes inside or around a table reaches the
 * page as markup. Each table region is tokenized by hand (linear, no regex backtracking over model text) and rebuilt
 * from scratch:
 *
 * - elements: only `table`, `thead`, `tbody`, `tr`, `th`, `td` (`tfoot` folds into the body); every other tag is
 *   dropped and its text kept, except script-like elements (`script`, `style`, `template`, ...), whose content is dropped;
 * - attributes: only `rowspan` and `colspan` on `th`/`td`, as a plain integer from 1 to MAX_TABLE_SPAN (the bound the
 *   app's renderer accepts); any other value is dropped (span 1), a rowspan is cut to the rows left in its section and a
 *   colspan to MAX_TABLE_COLUMNS columns;
 * - text: entities decoded once and every `&`, `<`, `>` and `"` escaped, whitespace collapsed;
 * - a table nested in a cell is flattened into that cell's text; text between cells (outside any cell) is kept after the
 *   table as plain escaped text; a table the model never closed ends at the end of the output;
 * - rows and cells past MAX_TABLE_ROWS / MAX_TABLE_CELLS stop being structure; their text follows the table.
 *
 * Table markup outside a `<table>` region (a stray `<tr>`, `</table>`, `<td>`) is escaped, so it renders as text.
 * Fenced code is not exempt: a table in a code sample is rebuilt in place (still shown as code), so no fence a model
 * opens or forgets to close can carry raw table markup past this pass.
 */

export const MAX_TABLE_SPAN = 100;
export const MAX_TABLE_COLUMNS = 100;
export const MAX_TABLE_ROWS = 2_000;
export const MAX_TABLE_CELLS = 20_000;
/** Output past this size is not parsed for tables: every table tag in it is escaped instead (bounded work). */
export const MAX_SANITIZE_CHARS = 1024 * 1024;

const TABLE_TAGS = new Set(["table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col"]);
/** Elements whose content is never page text. */
const DROP_CONTENT = new Set(["script", "style", "template", "iframe", "object", "embed", "noscript", "textarea", "xmp", "title", "head", "noembed", "noframes", "plaintext", "select"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6}|#39);/gi, (match, name: string) => {
    const lower = name.toLowerCase();
    if (lower.startsWith("#x") || /^#\d/.test(lower)) {
      const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      // Controls, surrogates and out-of-range code points stay as written (then escaped as text).
      return code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 127 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[lower] ?? match;
  });
}

export const escapeHtmlText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const cleanText = (text: string) => escapeHtmlText(decodeEntities(text)).replace(/\s+/g, " ").trim();

interface Tag { name: string; closing: boolean; attributes: string; end: number }

/**
 * Forward-only search for the next `>`: positions only move forward, so the last answer is reused while it is still
 * ahead, and a search that found none answers every later one. Keeps tag reading linear on `<a<a<a…` with no `>`.
 */
class GtScanner {
  private last = -2;
  constructor(private readonly text: string) {}
  next(from: number): number {
    if (this.last === -1 || (this.last >= from)) return this.last;
    this.last = this.text.indexOf(">", from);
    return this.last;
  }
}

const isNameStart = (code: number) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isNameChar = (code: number) => isNameStart(code) || (code >= 48 && code <= 57) || code === 45 || code === 58;

/**
 * The tag starting at `text[at] === "<"`, or null when it is not a tag (then the `<` is text). `end` is the index after
 * its `>`. Linear: one forward scan to the first `>`; quoted `>` inside attribute values are not honoured (the tag simply
 * ends there and the rest is text), which is safe because attributes are re-derived, never copied.
 */
function readTag(text: string, at: number, gt: GtScanner): Tag | null {
  let i = at + 1;
  const closing = text.charCodeAt(i) === 47;
  if (closing) i += 1;
  if (!isNameStart(text.charCodeAt(i))) return null;
  const nameStart = i;
  while (i < text.length && isNameChar(text.charCodeAt(i))) i += 1;
  const name = text.slice(nameStart, i).toLowerCase();
  const close = gt.next(i);
  if (close === -1) return null;
  const next = text.charCodeAt(i);
  // `<tablex>` is not `<table>`: the name must end at whitespace, `/` or `>`.
  if (!(next === 62 || next === 47 || next === 32 || (next >= 9 && next <= 13))) return null;
  return { name, closing, attributes: text.slice(i, close), end: close + 1 };
}

/** `rowspan`/`colspan` as a plain integer 1..MAX_TABLE_SPAN; anything else is ignored. */
function span(attributes: string, name: "rowspan" | "colspan"): number {
  const match = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*(?:"([^"]{0,16})"|'([^']{0,16})'|([^\\s"'>/]{1,16}))`, "i").exec(attributes.slice(0, 4096));
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  if (!/^[1-9]\d{0,2}$/.test(value)) return 1;
  const n = Number(value);
  return n <= MAX_TABLE_SPAN ? n : 1;
}

interface Cell { header: boolean; rowspan: number; colspan: number; text: string[] }
interface Row { head: boolean; cells: Cell[] }

/** Sanitize one table region starting at `start` (`<table`); returns the rebuilt HTML and the index after the region. */
function sanitizeTable(text: string, lower: string, start: number, gt: GtScanner): { html: string; end: number } {
  const rows: Row[] = [];
  const overflow: string[] = [];
  let cells = 0;
  let depth = 0;
  let head = false;
  let row: Row | null = null;
  let cell: Cell | null = null;
  let at = start;
  const closeCell = () => { cell = null; };
  const closeRow = () => { closeCell(); row = null; };
  const emitText = (value: string) => {
    if (!value.trim()) return;
    if (cell) (cell as Cell).text.push(value);
    else overflow.push(value);
  };
  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt === -1) { emitText(text.slice(at)); at = text.length; break; }
    if (lt > at) emitText(text.slice(at, lt));
    // Comments and declarations: dropped.
    if (text.startsWith("<!--", lt)) {
      const close = text.indexOf("-->", lt + 4);
      at = close === -1 ? text.length : close + 3;
      continue;
    }
    if (text.charCodeAt(lt + 1) === 33 || text.charCodeAt(lt + 1) === 63) { // <! or <?
      const close = gt.next(lt);
      at = close === -1 ? text.length : close + 1;
      continue;
    }
    const tag = readTag(text, lt, gt);
    if (!tag) { emitText("<"); at = lt + 1; continue; }
    at = tag.end;
    if (DROP_CONTENT.has(tag.name)) {
      if (!tag.closing) {
        const close = lower.indexOf(`</${tag.name}`, at);
        const gtAfter = close === -1 ? -1 : gt.next(close);
        at = gtAfter === -1 ? text.length : gtAfter + 1;
      }
      continue;
    }
    if (!TABLE_TAGS.has(tag.name)) {
      // Inline markup: dropped, its text kept; a line break separates words.
      if (cell) (cell as Cell).text.push(" ");
      continue;
    }
    if (tag.name === "table") {
      depth += tag.closing ? -1 : 1;
      if (depth <= 0) break;
      if (depth > 1 && cell) (cell as Cell).text.push(" ");
      continue;
    }
    // Structure inside a nested table only separates words in the enclosing cell.
    if (depth > 1) { if (cell) (cell as Cell).text.push(" "); continue; }
    switch (tag.name) {
      case "thead": closeRow(); head = !tag.closing; break;
      case "tbody": case "tfoot": closeRow(); head = false; break;
      case "tr": closeRow(); if (!tag.closing && rows.length < MAX_TABLE_ROWS) { row = { head, cells: [] }; rows.push(row); } break;
      case "th": case "td":
        closeCell();
        if (tag.closing) break;
        if (!row && rows.length < MAX_TABLE_ROWS) { row = { head, cells: [] }; rows.push(row); }
        if (row && cells < MAX_TABLE_CELLS) {
          cell = { header: tag.name === "th", rowspan: span(tag.attributes, "rowspan"), colspan: span(tag.attributes, "colspan"), text: [] };
          (row as Row).cells.push(cell);
          cells += 1;
        }
        break;
      default: break; // caption, colgroup, col: no structure kept; caption text goes after the table
    }
  }
  const sections = [rows.filter((r) => r.head && r.cells.length > 0), rows.filter((r) => !r.head && r.cells.length > 0)];
  let html = "";
  if (sections[0]!.length + sections[1]!.length > 0) {
    const renderSection = (section: Row[]) => section.map((r, index) => {
      let width = 0;
      const rendered = r.cells.map((c) => {
        const colspan = Math.max(1, Math.min(c.colspan, MAX_TABLE_COLUMNS - width));
        width = Math.min(MAX_TABLE_COLUMNS, width + colspan);
        const rowspan = Math.min(c.rowspan, section.length - index);
        const tag = c.header ? "th" : "td";
        const attrs = `${rowspan > 1 ? ` rowspan="${rowspan}"` : ""}${colspan > 1 ? ` colspan="${colspan}"` : ""}`;
        return `<${tag}${attrs}>${cleanText(c.text.join(""))}</${tag}>`;
      }).join("");
      return `<tr>${rendered}</tr>`;
    }).join("\n");
    html = "<table>\n";
    if (sections[0]!.length > 0) html += `<thead>\n${renderSection(sections[0]!)}\n</thead>\n`;
    if (sections[1]!.length > 0) html += `<tbody>\n${renderSection(sections[1]!)}\n</tbody>\n`;
    html += "</table>";
  }
  const loose = cleanText(overflow.join(" "));
  return { html: [html, loose].filter(Boolean).join("\n\n"), end: at };
}

/** Escape the `<` of table-family tags outside a table region, so they render as text. */
function escapeStrayTableTags(text: string): string {
  return text.replace(/<(\/?)(table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)(?=[\s/>])/gi, "&lt;$1$2");
}

/**
 * Rebuild every HTML table in a model's page transcription from the allow-list above. Text outside tables is returned
 * unchanged except for stray table tags, which are escaped. Returns the input itself when it holds no table markup.
 */
export function sanitizeVisionHtmlTables(text: string): string {
  if (!/<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)[\s/>]/i.test(text)) return text;
  if (text.length > MAX_SANITIZE_CHARS) return escapeStrayTableTags(text);
  const lower = text.toLowerCase();
  const gt = new GtScanner(text);
  const parts: string[] = [];
  let at = 0;
  let from = 0;
  // The last two characters written, for the blank lines around a table.
  let tail = "";
  while (at < text.length) {
    let start = -1;
    for (;;) {
      const found = lower.indexOf("<table", Math.max(from, at));
      if (found === -1) break;
      from = found + 1;
      if (readTag(text, found, gt)?.name === "table") { start = found; break; }
    }
    if (start === -1) { parts.push(escapeStrayTableTags(text.slice(at))); break; }
    const before = escapeStrayTableTags(text.slice(at, start));
    parts.push(before);
    if (before) tail = (tail + before).slice(-2);
    const table = sanitizeTable(text, lower, start, gt);
    at = Math.max(table.end, start + 1);
    if (table.html) {
      // A table is a block: a blank line on each side keeps it and the Markdown around it intact.
      const lead = tail === "" || tail === "\n\n" ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
      const rest = text.slice(at, at + 2);
      const trail = at >= text.length || rest.startsWith("\n\n") ? "" : rest.startsWith("\n") ? "\n" : "\n\n";
      parts.push(lead + table.html + trail);
      tail = (tail + lead + table.html + trail).slice(-2);
    }
  }
  return parts.join("");
}
