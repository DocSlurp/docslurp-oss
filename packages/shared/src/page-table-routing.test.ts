import { describe, expect, it } from "vitest";

import { PAGE_TABLE_ROUTING, TABLE_SCAN_MAX_PAGE_CHARS, isTableHeavy, markdownTables, repairMarkdownTables, tableReliability } from "./page-table-routing.js";

const pipe = (rows: number) => ["| a | b | c |", "| --- | --- | --- |", ...Array.from({ length: rows - 1 }, (_, i) => `| ${i} | x | y |`)].join("\n");

describe("table-heavy pages (owner rule 2026-11-05)", () => {
  it("counts GFM and HTML table rows, the separator excluded", () => {
    expect(markdownTables(pipe(4))).toEqual([{ rows: 4, columns: 3 }]);
    expect(markdownTables("<table>\n<tr><th>a</th><th>b</th></tr>\n<tr><td>1</td><td>2</td></tr>\n</table>")).toEqual([{ rows: 2, columns: 2 }]);
    expect(markdownTables("Prose with a | pipe | in it.\n\nMore prose.")).toEqual([]);
  });

  it("five rows make a page table-heavy; four do not", () => {
    expect(isTableHeavy([{ rows: PAGE_TABLE_ROUTING.tableHeavyMinRows, columns: 3, coverage: 0.05 }])).toBe(true);
    expect(isTableHeavy([{ rows: 4, columns: 3, coverage: 0.14 }])).toBe(false);
  });

  it("a few-row table covering 40% of the page is table-heavy; the union coverage wins over the sum", () => {
    expect(isTableHeavy([{ rows: 4, columns: 3, coverage: 0.45 }])).toBe(true);
    expect(isTableHeavy([{ rows: 2, columns: 2, coverage: 0.25 }, { rows: 2, columns: 2, coverage: 0.2 }])).toBe(true);
    expect(isTableHeavy([{ rows: 2, columns: 2, coverage: 0.25 }, { rows: 2, columns: 2, coverage: 0.25 }], 0.3)).toBe(false);
    expect(isTableHeavy([{ rows: 4, columns: 3, coverage: null }])).toBe(false);
  });
});

describe("born-digital tables: structural repairs and reliability", () => {
  const table = (...rows: string[][]) => [`| ${rows[0]!.join(" | ")} |`, `| ${rows[0]!.map(() => "---").join(" | ")} |`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");

  it("merges a two-line header Doppler split into one header row", () => {
    const split = table(["", "Revenue", "", "Margin", ""], ["Region", "Q1", "Q2", "Q1", "Q2"], ["North", "1,200", "1,310", "18.0%", "19.2%"], ["South", "1,287", "1,401", "19.1%", "20.3%"]);
    const { markdown, repairs } = repairMarkdownTables(`Intro\n\n${split}\n`);
    expect(repairs).toEqual({ mergedHeaders: 1, listsRestored: 0 });
    expect(markdown).toContain("| Region | Revenue Q1 | Revenue Q2 | Margin Q1 | Margin Q2 |");
    expect(markdown).toContain("| North | 1,200 | 1,310 | 18.0% | 19.2% |");
    expect(markdown).not.toContain("| Region | Q1 |");
    expect(tableReliability(markdown)).toEqual([]);
  });

  it("restores a bulleted or numbered list Doppler laid out as a table", () => {
    const bullets = table(["-", "Approve the minutes", "Chair", "5 min"], ["-", "Review the results", "Planning", "20 min"], ["-", "Any other business", "All", "10 min"]);
    expect(repairMarkdownTables(bullets).markdown.split("\n")).toEqual(["- Approve the minutes — Chair — 5 min", "- Review the results — Planning — 20 min", "- Any other business — All — 10 min"]);
    const numbered = table(["1.", "Open", "Chair"], ["2.", "Review", "Planning"], ["3)", "Close", "Chair"]);
    expect(repairMarkdownTables(numbered).markdown.split("\n")).toEqual(["1. Open — Chair", "2. Review — Planning", "3. Close — Chair"]);
  });

  it("leaves sound tables, and tables that only look similar, as they are", () => {
    const sound = table(["Account", "2024", "2025"], ["Revenue", "48,210", "52,934"], ["Cost", "21,877", "23,015"]);
    // One dash row among real rows is a value, not a list.
    const dash = table(["Item", "Qty"], ["-", "3"], ["Bolts", "12"], ["Nuts", "30"]);
    // An empty header cell over numbers is not a split header (its next row is numbers, not labels).
    const corner = table(["", "2024", "2025"], ["Revenue", "48,210", "52,934"], ["Cost", "21,877", "23,015"]);
    for (const markdown of [sound, dash, corner]) {
      expect(repairMarkdownTables(markdown)).toEqual({ markdown, repairs: { mergedHeaders: 0, listsRestored: 0 } });
    }
    // Page breaks survive.
    expect(repairMarkdownTables(`a\f${sound}\fb`).markdown.split("\f")).toHaveLength(3);
  });

  it("flags tables that stay unreliable: inconsistent column counts, mostly empty cells", () => {
    expect(tableReliability(table(["A", "B", "C"], ["1", "2"], ["3", "4", "5"]))).toEqual(["table:inconsistent-columns"]);
    expect(tableReliability(table(["A", "B", "C"], ["1", "", ""], ["", "", "6"], ["", "", ""]))).toEqual(["table:mostly-empty-cells"]);
    expect(tableReliability("Prose only.")).toEqual([]);
    // Row-spanning labels (blank first cells under a filled one, the rest of each row filled) are sound.
    expect(tableReliability(table(["Italian B", "Higher", "7", "ITAL 2110"], ["", "Higher", "4", "ITAL 2110"], ["", "Standard", "6", "ITAL 1020"], ["", "Standard", "5", "ITAL 1010"]))).toEqual([]);
  });
});

describe("HTML table scanning is linear on hostile page text (council G M1)", () => {
  const elapsed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
  const unclosed = (chars: number, unit = "<table>x") => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

  it("a page just under the cap of unclosed tables, rows or cells scans in well under 50 ms", () => {
    for (const unit of ["<table>x", "<TABLE x>y", "<table><tr>x", "<table><tr><td>x", "<table><tr><th>a<td>b"]) {
      const page = unclosed(TABLE_SCAN_MAX_PAGE_CHARS - 16, unit) + (unit.includes("<tr") ? "</table>" : "");
      repairMarkdownTables(page); // warm
      expect(elapsed(() => { repairMarkdownTables(page); tableReliability(page); })).toBeLessThan(50);
    }
  });

  it("1 MB of unclosed tables, as one page or as cap-sized pages, finishes in well under 50 ms", () => {
    const oneMb = unclosed(1024 * 1024);
    const paged = Array.from({ length: 4 }, () => unclosed(TABLE_SCAN_MAX_PAGE_CHARS - 16)).join("\f");
    repairMarkdownTables(paged);
    expect(elapsed(() => { repairMarkdownTables(oneMb); tableReliability(oneMb); })).toBeLessThan(50);
    expect(elapsed(() => repairMarkdownTables(paged))).toBeLessThan(50);
  });

  it("an oversized page is left as extracted and reported unreliable", () => {
    const page = `<table><tr><td>-</td><td>a</td></tr><tr><td>-</td><td>b</td></tr><tr><td>-</td><td>c</td></tr></table>\n${"x".repeat(TABLE_SCAN_MAX_PAGE_CHARS)}`;
    expect(repairMarkdownTables(page)).toEqual({ markdown: page, repairs: { mergedHeaders: 0, listsRestored: 0 } });
    expect(tableReliability(page)).toEqual(["table:oversized-page"]);
  });

  it("an unclosed element does not hide a later closed one of another kind, as the regex did not", () => {
    const page = "<table><tr><td>-<th>x</th><td>y</td></tr><tr><td>-</td><td>z</td></tr><tr><td>-</td><td>w</td></tr></table>";
    expect(repairMarkdownTables(page).repairs.listsRestored).toBe(0);
    expect(tableReliability("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table> <table>unclosed")).toEqual(["table:inconsistent-columns"]);
  });
});
