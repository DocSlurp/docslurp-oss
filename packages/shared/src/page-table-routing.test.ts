import { describe, expect, it } from "vitest";

import { PAGE_TABLE_ROUTING, isTableHeavy, markdownTables } from "./page-table-routing.js";

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
