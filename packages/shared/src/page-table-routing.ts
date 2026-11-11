/*
 * When a page is table-heavy (owner rule, 2026-11-05): some table on it has `tableHeavyMinRows` or more rows, or its tables
 * cover at least `tableHeavyMinCoverage` of the visible page. Measured from the extractor's own tables and, for coverage,
 * the layout walker's geometry (worker/scripts/pdf_layout_facts.py `markdown_tables`, `table_box`). Never from words that
 * name a table, and never from document metadata. The offline estimator mirrors this rule.
 */
export const PAGE_TABLE_ROUTING = {
  tableHeavyMinRows: 5,
  tableHeavyMinCoverage: 0.4,
} as const;

export interface PageTable {
  /** Rows, the separator line excluded. */
  rows: number;
  columns: number;
  /** Share of the visible page the table covers; null when its geometry is unknown. */
  coverage: number | null;
}

/**
 * Longest line read as a table row. Page text is customer text: the row and separator checks below are hand-written and
 * linear (trim, then fixed-shape tests), never regexes with adjacent optional whitespace, which backtrack quadratically on
 * long whitespace lines (council I: 81 s on a 256 KB page of spaces, worse with NBSP or U+3000).
 */
export const TABLE_MAX_LINE_CHARS = 8 * 1024;

/** `| a | b |` (after trimming): the text between the outer pipes, or null when the line is not a pipe row. */
function pipeRowInner(line: string): string | null {
  if (line.length > TABLE_MAX_LINE_CHARS) return null;
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : null;
}

const SEPARATOR_CELL = /^:?-{3,}:?$/;

/** A GFM separator line (`|---|:---:|`, outer pipes optional): every pipe-separated cell, trimmed, is 3+ dashes with optional colons. */
function isSeparatorLine(line: string): boolean {
  if (line.length > TABLE_MAX_LINE_CHARS) return false;
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").every((cell) => SEPARATOR_CELL.test(cell.trim()));
}

/** Blocks of lines separated by blank (whitespace-only) lines, without a regex over the page. */
function blankLineBlocks(page: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of page.split("\n")) {
    if (line.trim()) current.push(line);
    else if (current.length) { blocks.push(current.join("\n")); current = []; }
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

/**
 * Tables in one page's Markdown: GFM pipe tables (a block of two or more pipe rows, the separator not counted) and HTML
 * tables (`<tr>` rows). Mirrors `markdown_tables` in pdf_layout_facts.py.
 */
export function markdownTables(page: string): Array<{ rows: number; columns: number }> {
  const tables: Array<{ rows: number; columns: number }> = [];
  for (const block of blankLineBlocks(page)) {
    const html = /^\s{0,3}<table(?=\s|>|$)/i.exec(block);
    if (html) {
      const rows = block.split(/<tr[\s>]/i).slice(1);
      if (rows.length > 0) tables.push({ rows: rows.length, columns: Math.max(...rows.map((row) => (row.match(/<t[dh][\s>]/gi) ?? []).length)) });
      continue;
    }
    const lines = block.split("\n").filter((line) => line.trim());
    const pipe = lines.filter((line) => pipeRowInner(line) !== null && !isSeparatorLine(line));
    if (pipe.length >= 2 && pipe.length >= lines.length - 1) {
      tables.push({ rows: pipe.length, columns: Math.max(...pipe.map((line) => pipeRowInner(line)!.split("|").length)) });
    }
  }
  return tables;
}

/**
 * Whether a page's tables make it table-heavy: any table of `tableHeavyMinRows` rows, or tables covering the share.
 * `coverage` is the union of the page's table boxes (extracted tables and ruled grids, overlaps counted once) when known;
 * without it the tables' own known coverage is summed.
 */
export function isTableHeavy(tables: readonly PageTable[], coverage: number | null = null, routing: typeof PAGE_TABLE_ROUTING = PAGE_TABLE_ROUTING): boolean {
  if (tables.some((table) => table.rows >= routing.tableHeavyMinRows)) return true;
  const covered = coverage ?? tables.reduce((sum, table) => sum + (table.coverage ?? 0), 0);
  return covered >= routing.tableHeavyMinCoverage;
}

// ---- Born-digital tables: repair what Doppler gets structurally wrong, escalate what stays unreliable -------------------

/** A GFM pipe table in one page's Markdown: its line span and its rows' cells (the separator line excluded). */
interface PipeTable { start: number; end: number; header: string[]; body: string[][] }

const NUMERIC_CELL = /^[-+(]?[$€£¥]?\d[\d,.:/%)]*$/;
const BULLET_CELL = /^(?:[-•*·▪◦–]|\d{1,2}[.)])$/;

function cells(line: string): string[] {
  return pipeRowInner(line)!.split("|").map((cell) => cell.trim());
}

function pipeTables(lines: string[]): PipeTable[] {
  const tables: PipeTable[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (pipeRowInner(lines[i]!) === null || !isSeparatorLine(lines[i + 1]!)) continue;
    let end = i + 2;
    while (end < lines.length && pipeRowInner(lines[end]!) !== null && !isSeparatorLine(lines[end]!)) end += 1;
    tables.push({ start: i, end, header: cells(lines[i]!), body: lines.slice(i + 2, end).map(cells) });
    i = end - 1;
  }
  return tables;
}

const row = (values: string[]) => `| ${values.join(" | ")} |`;

/**
 * A two-line header Doppler split: group labels over empty cells in the header row (`| | Revenue | | Margin | |`), the
 * sub-labels as the first body row, numbers below. Null when the table is not that shape.
 */
function mergedTwoLineHeader(table: Pick<PipeTable, "header" | "body">): string[] | null {
  const [labels, ...data] = table.body;
  const width = table.header.length;
  if (!labels || data.length < 2 || labels.length !== width || table.body.some((cells) => cells.length !== width)) return null;
  const emptyHeader = table.header.filter((cell) => !cell).length;
  if (emptyHeader === 0 || emptyHeader === width) return null;
  if (labels.slice(1).some((cell) => !cell || NUMERIC_CELL.test(cell))) return null;
  if (data.filter((cells) => cells.slice(1).some((cell) => NUMERIC_CELL.test(cell))).length < Math.ceil(data.length / 2)) return null;
  let group = "";
  return table.header.map((cell, index) => {
    if (cell) group = cell;
    else if (index === 0) group = "";
    return [index === 0 ? cell : group, labels[index]].filter(Boolean).join(" ");
  });
}

/** A list Doppler laid out as a table: every row's first cell is a bullet or an item number. */
function isListAsTable(table: Pick<PipeTable, "header" | "body">): boolean {
  const rows = [table.header, ...table.body];
  return rows.length >= 3 && table.header.length >= 2 && rows.every((cells) => BULLET_CELL.test(cells[0] ?? ""));
}

export interface TableRepairs { mergedHeaders: number; listsRestored: number }

/**
 * An HTML table in one page's Markdown (Doppler's `--html` output, which the VM guest emits): its character span and its
 * rows' cell texts, the first row as the header. `simple` is false when a cell spans rows or columns or holds markup other
 * than text, which the repairs leave alone (its geometry cannot be read from the row list).
 */
interface HtmlTable { start: number; end: number; header: string[]; body: string[][]; simple: boolean }

/** Pages larger than this skip HTML table repair and are reported unreliable: their text is not scanned for tables. */
export const TABLE_SCAN_MAX_PAGE_CHARS = 256 * 1024;

/** ASCII-only lower case, so indexes stay aligned with the original text (String#toLowerCase can change its length). */
const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/**
 * Elements `<tag ...>inner</tag>` of one of `tags` in `text`, left to right, each closed by the first matching close tag (no
 * nesting). Linear: each search resumes after the previous element, and a tag with no close tag after some position has
 * none after any later one, so it is never searched for again. The page is customer text (Doppler passes PDF prose
 * through `--html` unescaped), so a lazy regex here would be quadratic on `<table>` repeated without a close.
 */
function htmlElements(text: string, tags: readonly string[]): Array<{ tag: string; start: number; end: number; attributes: string; inner: string }> {
  const lower = asciiLower(text);
  const open = new Set(tags);
  const elements: Array<{ tag: string; start: number; end: number; attributes: string; inner: string }> = [];
  let cursor = 0;
  while (open.size > 0) {
    let start = -1, tag = "";
    for (let at = lower.indexOf("<", cursor); at !== -1; at = lower.indexOf("<", at + 1)) {
      const name = [...open].find((candidate) => lower.startsWith(candidate, at + 1));
      const next = name === undefined ? "" : lower[at + 1 + name.length] ?? "";
      if (name !== undefined && (next === ">" || /\s/.test(next))) { start = at; tag = name; break; }
    }
    if (start === -1) break;
    const openEnd = lower.indexOf(">", start);
    if (openEnd === -1) break;
    const close = lower.indexOf(`</${tag}>`, openEnd + 1);
    if (close === -1) { open.delete(tag); cursor = start + 1; continue; }
    const end = close + tag.length + 3;
    elements.push({ tag, start, end, attributes: text.slice(start + 1 + tag.length, openEnd), inner: text.slice(openEnd + 1, close) });
    cursor = end;
  }
  return elements;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };

function htmlText(value: string): string {
  return value.replace(/<br\s*\/?>/gi, " ").replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!)
    .replace(/\s+/g, " ").trim();
}

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function htmlTables(page: string): HtmlTable[] {
  const tables: HtmlTable[] = [];
  for (const table of htmlElements(page, ["table"])) {
    let simple = true;
    const rows = htmlElements(table.inner, ["tr"]).map((row) => htmlElements(row.inner, ["td", "th"]).map((cell) => {
      if (/\b(?:colspan|rowspan)\s*=/i.test(cell.attributes) || /<(?!br\s*\/?>)[a-z]/i.test(cell.inner)) simple = false;
      return htmlText(cell.inner);
    }));
    if (rows.length === 0) continue;
    tables.push({ start: table.start, end: table.end, header: rows[0]!, body: rows.slice(1), simple });
  }
  return tables;
}

const htmlRow = (values: string[], cell: "td" | "th") => `<tr>${values.map((value) => `<${cell}>${escapeHtml(value)}</${cell}>`).join("")}</tr>`;

/**
 * Structural repairs of a born-digital PDF's tables, from the extractor's own Markdown (no model reads the page): a two-line
 * header Doppler split becomes one header row (`Revenue Q1`, `Revenue Q2`, ...); a bulleted or numbered list it laid out
 * in columns becomes a list again. Pages are separated by form feeds and keep their count. Measured structure only.
 */
export function repairMarkdownTables(markdown: string): { markdown: string; repairs: TableRepairs } {
  const repairs: TableRepairs = { mergedHeaders: 0, listsRestored: 0 };
  const pages = markdown.split("\f").map((raw) => {
    // An oversized page is left as extracted; tableReliability reports it unreliable.
    if (raw.length > TABLE_SCAN_MAX_PAGE_CHARS) return raw;
    // HTML tables (Doppler --html, the VM guest's output) get the same repairs as pipe tables, as HTML. One forward pass
    // over the page (tables are in order and do not overlap): never a splice or re-slice per table, which is quadratic
    // on a page of many small tables (council K #1).
    const parts: string[] = [];
    let at = 0;
    for (const table of htmlTables(raw)) {
      if (!table.simple) continue;
      let replacement: string | null = null;
      if (isListAsTable(table)) {
        replacement = [table.header, ...table.body].map((cells) => {
          const marker = /^\d/.test(cells[0]!) ? `${cells[0]!.replace(/\)$/, ".")} ` : "- ";
          return marker + cells.slice(1).filter(Boolean).join(" — ");
        }).join("\n");
        repairs.listsRestored += 1;
      } else {
        const header = mergedTwoLineHeader(table);
        if (header) {
          replacement = `<table>\n<thead>\n${htmlRow(header, "th")}\n</thead>\n<tbody>\n${table.body.slice(1).map((cells) => htmlRow(cells, "td")).join("\n")}\n</tbody>\n</table>`;
          repairs.mergedHeaders += 1;
        }
      }
      if (replacement !== null) { parts.push(raw.slice(at, table.start), replacement); at = table.end; }
    }
    parts.push(raw.slice(at));
    const page = parts.join("");
    const source = page.split("\n");
    const lines: string[] = [];
    let next = 0;
    for (const table of pipeTables(source)) {
      let replacement: string[] | null = null;
      if (isListAsTable(table)) {
        replacement = [table.header, ...table.body].map((cells) => {
          const marker = /^\d/.test(cells[0]!) ? `${cells[0]!.replace(/\)$/, ".")} ` : "- ";
          return marker + cells.slice(1).filter(Boolean).join(" — ");
        });
        repairs.listsRestored += 1;
      } else {
        const header = mergedTwoLineHeader(table);
        if (header) {
          replacement = [row(header), row(header.map(() => "---")), ...table.body.slice(1).map(row)];
          repairs.mergedHeaders += 1;
        }
      }
      if (replacement === null) continue;
      for (; next < table.start; next++) lines.push(source[next]!);
      for (const line of replacement) lines.push(line);
      next = table.end;
    }
    for (; next < source.length; next++) lines.push(source[next]!);
    return lines.join("\n");
  });
  return { markdown: pages.join("\f"), repairs };
}

/** Body cells empty above this share make a table unreliable (merged or misplaced cells). */
export const TABLE_UNRELIABLE_EMPTY_CELL_SHARE = 0.4;

/**
 * A table that leaked out of the extractor's tables (Doppler cut a borderless table at a gap between row groups, wrote its
 * rows as text, kept only its header, or merged numeric columns into one cell). Each signal is a document class seen in
 * financial, statistical and government tables, measured from the page's own Markdown:
 *
 * - `table:numeric-prose`: at least `numericProseMinLines` text lines outside every table that each hold at least
 *   `numericProseMinNumbers` numeric tokens making up at least `numericProseMinShare` of the line's tokens, beside at least
 *   one word (a row label), and that neither end a sentence nor are list items. Dot leaders do not count as tokens. Table
 *   rows written as text.
 * - `table:header-only`: a table of at most `headerOnlyMaxRows` rows and at least `headerOnlyMinColumns` columns, no
 *   cell mostly made of numbers, no value-like cell (a date or an identifier: digits joined by `/` or `-`, or a run of five
 *   or more digits) and only short cells (at most `headerOnlyMaxCellWords` words): a header separated from its body. A form's
 *   label row over its filled-in values is not one.
 * - `table:merged-numeric-cell`: a cell holding at least `mergedCellMinNumbers` numeric tokens that make up at least half
 *   its tokens, two of them measured values (a decimal or thousands separator, a percent or parentheses): columns
 *   collapsed into one. Phone numbers and digit-per-box form fields are plain digit groups and do not count.
 *
 * These signals qualify any page with a text layer for a model read, table-heavy or not (classify-route).
 */
export const TABLE_LEAK = {
  numericProseMinLines: 2,
  numericProseMinNumbers: 4,
  numericProseMinShare: 0.5,
  headerOnlyMaxRows: 4,
  headerOnlyMinColumns: 3,
  headerOnlyMaxCellWords: 8,
  mergedCellMinNumbers: 3,
} as const;

export const TABLE_LEAK_SIGNALS: ReadonlySet<string> = new Set(["table:numeric-prose", "table:header-only", "table:merged-numeric-cell"]);

/**
 * A number as statistical tables print it: optional sign, currency, parentheses, footnote star or percent around digits
 * with separators (`-1,234.5`, `(12)`, `$4.2`, `*–0.5`, `18%`), or a missing-value placeholder (`–`, `—`, `(X)`, `n.a.`).
 */
const LEAK_NUMBER = /^[-+−–—(*$€£¥]{0,3}\d[\d,.]*[)%*]{0,2}$|^[-–—]$|^\(x\)$|^n\.?a\.?$/i;
const isLeakNumber = (token: string) => token.length <= 32 && LEAK_NUMBER.test(token);
const LETTERS = /\p{L}{2,}/u;
const DOT_LEADER = /^[.·…]+$/;
const SENTENCE_END = /\p{Ll}{2,}[.!?]["'”’)]?$/u;
const LIST_MARKER = /^(?:[-*+•·▪◦–—]|\d{1,3}[.)]|\(?[a-z]\))$/i;
/** A measured value as tables print it: a decimal or thousands separator, a percent, or parentheses (`1,409`, `0.3`, `(12)`). */
const MEASURED_NUMBER = /\d[.,]\d|%|^[-+−–—*$€£¥]{0,3}\(/;
/** A date or identifier (`02/19/2026`, `R-26-018842`, `20211694530`): a value, never a header label. */
const VALUE_TOKEN = /\d[/-]\d|\d{5,}/;

/** Text lines outside every HTML and pipe table: the page with HTML table spans removed, then pipe rows dropped. */
function nonTableLines(page: string): string[] {
  const parts: string[] = [];
  let at = 0;
  for (const table of htmlElements(page, ["table"])) { parts.push(page.slice(at, table.start)); at = table.end; }
  parts.push(page.slice(at));
  return parts.join("\n").split("\n").filter((line) => line.trim() && pipeRowInner(line) === null && !isSeparatorLine(line));
}

function isNumericProseLine(line: string, rules: typeof TABLE_LEAK): boolean {
  if (line.length > TABLE_MAX_LINE_CHARS) return false;
  const tokens = line.trim().split(/\s+/).filter((token) => !DOT_LEADER.test(token));
  if (tokens.length === 0 || LIST_MARKER.test(tokens[0]!)) return false;
  const numbers = tokens.filter(isLeakNumber).length;
  if (numbers < rules.numericProseMinNumbers || numbers / tokens.length < rules.numericProseMinShare) return false;
  // A row label: without one, a run of numbers is more often a chart's tick labels or an equation than a table row.
  if (!tokens.some((token) => !isLeakNumber(token) && LETTERS.test(token))) return false;
  return !SENTENCE_END.test(tokens[tokens.length - 1]!);
}

function leakSignals(page: string, tables: ReadonlyArray<{ header: string[]; body: string[][] }>, rules: typeof TABLE_LEAK): string[] {
  const signals: string[] = [];
  let numericLines = 0;
  for (const line of nonTableLines(page)) {
    if (isNumericProseLine(line, rules) && ++numericLines >= rules.numericProseMinLines) { signals.push("table:numeric-prose"); break; }
  }
  const tokens = (cell: string) => cell.split(/\s+/).filter(Boolean);
  const words = (cell: string) => tokens(cell).length;
  for (const table of tables) {
    const rows = [table.header, ...table.body];
    const columns = Math.max(...rows.map((cells) => cells.length));
    if (rows.length <= rules.headerOnlyMaxRows && columns >= rules.headerOnlyMinColumns &&
        rows.every((cells) => cells.every((cell) => !VALUE_TOKEN.test(cell) && words(cell) <= rules.headerOnlyMaxCellWords &&
          tokens(cell).filter(isLeakNumber).length * 2 <= words(cell) && !isLeakNumber(cell))) &&
        rows.some((cells) => cells.some((cell) => LETTERS.test(cell)))) {
      signals.push("table:header-only");
    }
    if (rows.some((cells) => cells.some((cell) => {
      const numbers = tokens(cell).filter(isLeakNumber);
      return numbers.length >= rules.mergedCellMinNumbers && numbers.length * 2 >= words(cell) &&
        numbers.filter((token) => MEASURED_NUMBER.test(token)).length >= 2;
    }))) signals.push("table:merged-numeric-cell");
  }
  return signals;
}

/**
 * Why a page's tables (after repairMarkdownTables) cannot be served as extracted: rows with different column counts, most
 * body cells empty, or a table that leaked out of the extracted tables (TABLE_LEAK). Empty when every table looks sound. A
 * page with a text layer is read by a model (classify-route) when it is table-heavy and has any of these, or has a leak
 * signal (TABLE_LEAK_SIGNALS) whether or not it is table-heavy; otherwise Doppler's table is served.
 */
export function tableReliability(page: string, rules: typeof TABLE_LEAK = TABLE_LEAK): string[] {
  // An oversized page is not scanned (customer text; bounded work): its tables are unknown, so it is a model's to read.
  if (page.length > TABLE_SCAN_MAX_PAGE_CHARS) return ["table:oversized-page"];
  const signals = new Set<string>();
  // A spanning HTML table's row lengths do not show its columns; it is judged only by its empty cells.
  const tables = [...pipeTables(page.split("\n")).map((table) => ({ ...table, simple: true })), ...htmlTables(page)];
  for (const table of tables) {
    if (table.body.length === 0) continue;
    if (table.simple && table.body.some((cells) => cells.length !== table.header.length)) signals.add("table:inconsistent-columns");
    // A blank first cell on a row whose other cells are filled continues a row-spanning cell above (a merged label); it
    // is sound structure, not a missing value, and is not counted.
    const body = table.body.flatMap((cells) => (!cells[0] && cells.slice(1).every(Boolean) ? cells.slice(1) : cells));
    if (body.length > 0 && body.filter((cell) => !cell).length / body.length > TABLE_UNRELIABLE_EMPTY_CELL_SHARE) signals.add("table:mostly-empty-cells");
  }
  for (const signal of leakSignals(page, tables, rules)) signals.add(signal);
  return [...signals];
}
