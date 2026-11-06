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
