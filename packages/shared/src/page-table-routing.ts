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

const PIPE_ROW = /^\s*\|(.*)\|\s*$/;
const PIPE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/**
 * Tables in one page's Markdown: GFM pipe tables (a block of two or more pipe rows, the separator not counted) and HTML
 * tables (`<tr>` rows). Mirrors `markdown_tables` in pdf_layout_facts.py.
 */
export function markdownTables(page: string): Array<{ rows: number; columns: number }> {
  const tables: Array<{ rows: number; columns: number }> = [];
  for (const block of page.split(/\n\s*\n/)) {
    const html = /^\s{0,3}<table(?=\s|>|$)/i.exec(block);
    if (html) {
      const rows = block.split(/<tr[\s>]/i).slice(1);
      if (rows.length > 0) tables.push({ rows: rows.length, columns: Math.max(...rows.map((row) => (row.match(/<t[dh][\s>]/gi) ?? []).length)) });
      continue;
    }
    const lines = block.split("\n").filter((line) => line.trim());
    const pipe = lines.filter((line) => PIPE_ROW.test(line) && !PIPE_SEPARATOR.test(line));
    if (pipe.length >= 2 && pipe.length >= lines.length - 1) {
      tables.push({ rows: pipe.length, columns: Math.max(...pipe.map((line) => PIPE_ROW.exec(line)![1]!.split("|").length)) });
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

const SEPARATOR_LINE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const ROW_LINE = /^\s*\|(.*)\|\s*$/;
const NUMERIC_CELL = /^[-+(]?[$€£¥]?\d[\d,.:/%)]*$/;
const BULLET_CELL = /^(?:[-•*·▪◦–]|\d{1,2}[.)])$/;

function cells(line: string): string[] {
  return ROW_LINE.exec(line)![1]!.split("|").map((cell) => cell.trim());
}

function pipeTables(lines: string[]): PipeTable[] {
  const tables: PipeTable[] = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!ROW_LINE.test(lines[i]!) || !SEPARATOR_LINE.test(lines[i + 1]!)) continue;
    let end = i + 2;
    while (end < lines.length && ROW_LINE.test(lines[end]!) && !SEPARATOR_LINE.test(lines[end]!)) end += 1;
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
function mergedTwoLineHeader(table: PipeTable): string[] | null {
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
function isListAsTable(table: PipeTable): boolean {
  const rows = [table.header, ...table.body];
  return rows.length >= 3 && table.header.length >= 2 && rows.every((cells) => BULLET_CELL.test(cells[0] ?? ""));
}

export interface TableRepairs { mergedHeaders: number; listsRestored: number }

/**
 * Structural repairs of a born-digital PDF's tables, from the extractor's own Markdown (no model reads the page): a two-line
 * header Doppler split becomes one header row (`Revenue Q1`, `Revenue Q2`, ...); a bulleted or numbered list it laid out
 * in columns becomes a list again. Pages are separated by form feeds and keep their count. Measured structure only.
 */
export function repairMarkdownTables(markdown: string): { markdown: string; repairs: TableRepairs } {
  const repairs: TableRepairs = { mergedHeaders: 0, listsRestored: 0 };
  const pages = markdown.split("\f").map((page) => {
    const lines = page.split("\n");
    for (const table of pipeTables(lines).reverse()) {
      if (isListAsTable(table)) {
        const items = [table.header, ...table.body].map((cells) => {
          const marker = /^\d/.test(cells[0]!) ? `${cells[0]!.replace(/\)$/, ".")} ` : "- ";
          return marker + cells.slice(1).filter(Boolean).join(" — ");
        });
        lines.splice(table.start, table.end - table.start, ...items);
        repairs.listsRestored += 1;
        continue;
      }
      const header = mergedTwoLineHeader(table);
      if (header) {
        lines.splice(table.start, table.end - table.start, row(header), row(header.map(() => "---")), ...table.body.slice(1).map(row));
        repairs.mergedHeaders += 1;
      }
    }
    return lines.join("\n");
  });
  return { markdown: pages.join("\f"), repairs };
}

/** Body cells empty above this share make a table unreliable (merged or misplaced cells). */
export const TABLE_UNRELIABLE_EMPTY_CELL_SHARE = 0.4;

/**
 * Why a page's tables (after repairMarkdownTables) cannot be served as extracted: rows with different column counts, or most
 * body cells empty. Empty when every table looks sound. A table-heavy page with a text layer and any of these is read by a
 * model (classify-route); otherwise Doppler's table is served.
 */
export function tableReliability(page: string): string[] {
  const signals = new Set<string>();
  for (const table of pipeTables(page.split("\n"))) {
    if (table.body.length === 0) continue;
    if (table.body.some((cells) => cells.length !== table.header.length)) signals.add("table:inconsistent-columns");
    // A blank first cell on a row whose other cells are filled continues a row-spanning cell above (a merged label); it
    // is sound structure, not a missing value, and is not counted.
    const body = table.body.flatMap((cells) => (!cells[0] && cells.slice(1).every(Boolean) ? cells.slice(1) : cells));
    if (body.length > 0 && body.filter((cell) => !cell).length / body.length > TABLE_UNRELIABLE_EMPTY_CELL_SHARE) signals.add("table:mostly-empty-cells");
  }
  return [...signals];
}
