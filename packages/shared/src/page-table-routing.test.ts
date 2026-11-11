import { describe, expect, it } from "vitest";

import { PAGE_TABLE_ROUTING, TABLE_LEAK, TABLE_LEAK_PAGE_CAP, TABLE_LEAK_SIGNALS, TABLE_SCAN_MAX_PAGE_CHARS, isTableHeavy, markdownTables, repairMarkdownTables, tableLeakPageCap, tableReliability } from "./page-table-routing.js";

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

  it("a page just under the cap of unclosed tables, rows or cells scans in well under 500 ms (quadratic took 81 s)", () => {
    for (const unit of ["<table>x", "<TABLE x>y", "<table><tr>x", "<table><tr><td>x", "<table><tr><th>a<td>b"]) {
      const page = unclosed(TABLE_SCAN_MAX_PAGE_CHARS - 16, unit) + (unit.includes("<tr") ? "</table>" : "");
      repairMarkdownTables(page); // warm
      expect(elapsed(() => { repairMarkdownTables(page); tableReliability(page); })).toBeLessThan(500);
    }
  });

  it("1 MB of unclosed tables, as one page or as cap-sized pages, finishes in well under 500 ms", () => {
    const oneMb = unclosed(1024 * 1024);
    const paged = Array.from({ length: 4 }, () => unclosed(TABLE_SCAN_MAX_PAGE_CHARS - 16)).join("\f");
    repairMarkdownTables(paged);
    expect(elapsed(() => { repairMarkdownTables(oneMb); tableReliability(oneMb); })).toBeLessThan(500);
    expect(elapsed(() => repairMarkdownTables(paged))).toBeLessThan(500);
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

describe("pipe-table checks are linear on whitespace-heavy page text (council I #1)", () => {
  const elapsed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
  const near = TABLE_SCAN_MAX_PAGE_CHARS - 64;

  it.each([[" ", "space"], ["\t", "tab"], [" ", "NBSP"], ["　", "ideographic space"]])("a page at the cap of %j (%s) scans in well under 500 ms (quadratic took 81 s)", (ws) => {
    const pages = [
      `|${ws.repeat(near)}x`,                               // a row that never closes
      `${ws.repeat(near)}-`,                                // separator-looking, leading whitespace
      `|---${ws.repeat(near)}x`,                            // separator-looking, trailing whitespace
      `| a |\n|${ws.repeat(near / 2)}---${ws.repeat(near / 2)}x`,
      Array.from({ length: 64 }, () => `|${ws.repeat(near / 64 - 8)}:---${ws.repeat(2)}x`).join("\n"),
    ];
    for (const page of pages) {
      repairMarkdownTables(page); // warm
      expect(elapsed(() => { repairMarkdownTables(page); tableReliability(page); markdownTables(page); })).toBeLessThan(500);
    }
  });

  it("still reads pipe tables padded with any whitespace", () => {
    const page = ["　| a | b |\t", " |:---:| ---| ", "| 1 | 2 |"].join("\n");
    expect(markdownTables(page)).toEqual([{ rows: 2, columns: 2 }]);
  });
});

describe("table repair is one forward pass over a page of many small tables (council K #1)", () => {
  const elapsed = (fn: () => unknown) => { fn(); let best = Infinity; for (let i = 0; i < 3; i++) { const start = performance.now(); fn(); best = Math.min(best, performance.now() - start); } return best; };
  it("a page at the cap of small list-as-tables, HTML and pipe, repairs in well under 500 ms", () => {
    const html = "<table><tr><td>-</td><td>a</td></tr><tr><td>-</td><td>b</td></tr><tr><td>-</td><td>c</td></tr></table>\n";
    const pipe = "| - | a |\n| --- | --- |\n| - | b |\n| - | c |\n\n";
    const page = (html + pipe).repeat(Math.floor((TABLE_SCAN_MAX_PAGE_CHARS - 64) / (html.length + pipe.length)));
    const { repairs } = repairMarkdownTables(page);
    expect(repairs.listsRestored).toBeGreaterThan(2_000);
    expect(elapsed(() => repairMarkdownTables(page))).toBeLessThan(500);
  });
});

describe("tables that leaked out of the extracted tables (authored pages)", () => {
  const html = (...rows: string[][]) => `<table>\n${rows.map((cells, i) => `<tr>${cells.map((c) => (i === 0 ? `<th>${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`).join("\n")}\n</table>`;

  it("flags table rows written as text lines, dot leaders and placeholders included", () => {
    const page = [
      "Quarterly bookings by region",
      "",
      "North America . . . . . . 412.5 18.2 398.1 17.9 *–0.4",
      "Europe . . . . . . . . . 288.0 12.7 251.3 11.3 +1.4",
      "Asia Pacific 190.4 8.4 (X) – 2.1",
    ].join("\n");
    expect(tableReliability(page)).toEqual(["table:numeric-prose"]);
  });

  it("one numeric line, a sentence, chart ticks or a reference list are not leaked rows", () => {
    expect(tableReliability("Revenue grew 18.2 12.4 9.1 and 7.5 percent\n\nThe team closed 4 deals.")).toEqual([]);
    // Sentences that are mostly numbers still end like sentences.
    expect(tableReliability([
      "Orders rose to 1,240 from 980, 1,020 and 1,105 in prior years.",
      "Margins were 18.2, 17.9, 17.1 and 16.4 percent respectively.",
    ].join("\n"))).toEqual([]);
    // List items with measurements are a list.
    expect(tableReliability(["- Carry-on: 22 x 14 x 9 inches, 15 lbs", "- Checked bag: (62 + 30 + 20) 50 lbs"].join("\n"))).toEqual([]);
    // Axis tick labels carry no row label.
    expect(tableReliability("0 10 20 30 40 50\n2019 2020 2021 2022 2023")).toEqual([]);
    expect(tableReliability([
      "Lee, J. (2021). Scaling launches. Journal of Growth, 12(3), 45–67.",
      "Park, S. (2023). New markets. Expansion Review, 8(1), 101–119.",
    ].join("\n"))).toEqual([]);
  });

  it("rows inside a table are not counted as text, pipe or HTML", () => {
    const rows = [["Region", "2024", "2025", "Change", "Share"], ["North", "412.5", "398.1", "14.4", "18.2"], ["South", "288.0", "251.3", "36.7", "12.7"]];
    expect(tableReliability(html(...rows))).toEqual([]);
    const pipe = [`| ${rows[0]!.join(" | ")} |`, "| --- | --- | --- | --- | --- |", ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n");
    expect(tableReliability(pipe)).toEqual([]);
  });

  // Body rows written as text after the header: the corroboration header-only needs (council #338 routing Medium).
  const leakedBody = ["Enterprise 412.5 18.2% 398.1 17.9%", "Mid-market 288.0 12.7% 251.3 11.3%", "Startups 190.4 8.4% 170.2 7.1%"].join("\n");

  it("flags a header without its body only when the body's numbers leaked out as text", () => {
    const header = html(["", "All markets", "", "New markets", ""], ["Segment", "Revenue", "Margin", "Revenue", "Margin"]);
    expect(tableReliability(`${header}\n\n${leakedBody}`)).toEqual(expect.arrayContaining(["table:header-only"]));
    // ... or its body extracted as a separate table of numbers.
    expect(tableReliability(`${header}\n\n${html(["Enterprise", "412.5", "18.2", "398.1", "17.9"], ["Mid-market", "288.0", "12.7", "251.3", "11.3"], ["Startups", "190.4", "8.4", "170.2", "7.1"])}`))
      .toEqual(["table:header-only"]);
    // The same header alone (no numbers anywhere) is not evidence of a missing body.
    expect(tableReliability(header)).toEqual([]);
    // Two columns of long text (a glossary) is a table of its own.
    expect(tableReliability(html(["Term", "Meaning"], ["Launch", "The day a new product reaches its first customers in a market"]))).toEqual([]);
    // Short, but its numbers make it a body.
    expect(tableReliability(html(["Region", "Q1", "Q2"], ["North", "412", "398"]))).toEqual([]);
    // A form's label row over its filled-in values (a date, an identifier) is a table of its own.
    expect(tableReliability(html(["Received", "Reviewed by", "Status", "Receipt no."], ["02/19/2026", "A. Rivera", "Approved", "R-26-018842"]))).toEqual([]);
    // Three rows of labels is a body, not a header, even beside leaked numbers.
    expect(tableReliability(`${html(...Array.from({ length: TABLE_LEAK.headerOnlyMaxRows + 1 }, (_, i) => [`Office ${"ABCDE"[i]}`, "Opened", "Expanding"]))}\n\nIntro`)).toEqual([]);
  });

  // Council #338 routing Mediums: ordinary tables, forms and number-bearing text stay off the paid read.
  it("feature matrices, empty forms, status tables, measurements, phones, axes and enumerations are not leaks", () => {
    for (const page of [
      "| Feature | Basic | Pro |\n| --- | --- | --- |\n| Search | Yes | Yes |\n| Export | No | Yes |",
      "| Name | Date of birth | Signature |\n|---|---|---|\n",
      "| Product | Region | Quarter | Notes |\n|---|---|---|---|\n| Widget | West | Q1 | strong |",
      "Measurements: 12 24 36 48\nReadings: 10 20 30 40",
      "| Location | Coordinates |\n| --- | --- |\n| Sample | 12.34 56.78 90.12 |",
      "# Acme Expansion Partners\n\nPhone +1 415 555 0100\nFax +1 415 555 0101\nMain +1 415 555 0102\n\nDear Ms. Rivera,",
      "Revenue 0 20 40 60 80 100\nMargin 0 5 10 15 20 25\nGrowth 0 2.5 5.0 7.5 10.0\n\nFigure 2: Revenue and margin by quarter.",
      "Contents\n\nIntroduction 1 2 3 4\nMethods 5 6 7 8\nResults 9 10 11 12",
      "Results\n\nTeam A 3 1 2 0\nTeam B 2 2 1 1\nTeam C 1 3 0 2",
      "Release notes v 2 3 1 build 4567 8901\nPatch 1 2 3 4 notes",
      // Two number rows are not enough: three consecutive measured rows are.
      "Enterprise 412.5 18.2% 398.1 17.9%\nMid-market 288.0 12.7% 251.3 11.3%",
      // A prose line between number rows breaks the run.
      "Enterprise 412.5 18.2% 398.1 17.9%\nMid-market 288.0 12.7% 251.3 11.3%\nGrowth slowed in the second half for these segments\nStartups 190.4 8.4% 170.2 7.1%",
    ]) expect(tableReliability(page), page).toEqual([]);
    expect(tableReliability(leakedBody)).toEqual(["table:numeric-prose"]);
    // Blank lines between leaked rows do not break the run.
    expect(tableReliability(leakedBody.replace(/\n/g, "\n\n"))).toEqual(["table:numeric-prose"]);
  });

  it("flags two or more cells holding several numbers (columns collapsed into one)", () => {
    expect(tableReliability(html(["Region", "Bookings"], ["North", "412.5 398.1 14.4"], ["South", "288.0 251.3 36.7"], ["West", "190.4"]))).toEqual(["table:merged-numeric-cell"]);
    // One such cell (a coordinate triple, a range) is a value.
    expect(tableReliability(html(["Region", "Bookings"], ["North", "412.5 398.1 14.4"], ["South", "288.0"], ["West", "190.4"]))).toEqual([]);
    // Phone numbers and digit-per-box form fields are digit groups, not collapsed columns.
    expect(tableReliability(html(["Office", "Phone", "Postcode"], ["Lyon", "04 72 55 01 38", "6 9 0 0 7"], ["Paris", "01 44 20 10 10", "7 5 0 0 1"]))).toEqual([]);
    // A date or two numbers in a cell are values.
    expect(tableReliability(html(["Milestone", "Date", "Deals"], ["Launch", "12 Nov 2026", "40"], ["Expansion", "3 Mar 2027", "55"]))).toEqual([]);
  });

  it("caps the pages one document's leak signals may route: base plus a share of its pages, bounded", () => {
    expect([1, 10, 40, 100, 339, 340, 10_000].map((pages) => tableLeakPageCap(pages))).toEqual([3, 3, 5, 8, 19, 20, 20]);
    expect(tableLeakPageCap(0)).toBe(TABLE_LEAK_PAGE_CAP.base);
  });

  it("leak signals are the routing set; structural signals stay table-heavy only", () => {
    expect([...TABLE_LEAK_SIGNALS].sort()).toEqual(["table:header-only", "table:merged-numeric-cell", "table:numeric-prose"]);
  });

  it("leak checks are linear on hostile page text", () => {
    const elapsed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
    const near = TABLE_SCAN_MAX_PAGE_CHARS - 64;
    for (const page of [
      "1 ".repeat(near / 2),
      `a ${"-".repeat(near - 4)}`,
      "<table>".repeat(near / 7),
      `<table><tr><td>${"9 ".repeat(near / 2 - 40)}</td></tr></table>`,
      "x 1 2 3 4\n".repeat(near / 10),
      // Adversarial L4: a number row ending in one long lowercase token (SENTENCE_END is checked on its last 64 chars).
      Array.from({ length: Math.floor(near / 8_030) }, () => `Revenue 1.5 2.5 3.5 4.5 ${"a".repeat(8_000)}`).join("\n"),
    ]) {
      expect(elapsed(() => tableReliability(page))).toBeLessThan(500);
    }
  });
});
