import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { csvCellText, textBodyPages } from "../lib/office-page-count.js";

const python = process.env.OFFICE_TEST_PYTHON ?? "python3";
const scripts = path.resolve(import.meta.dirname, "../../scripts");
const hasOfficeLibs = spawnSync(python, ["-c", "import pptx, openpyxl"]).status === 0;

describe.skipIf(!hasOfficeLibs)("office sidecar scripts on tricky inputs", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "office-scripts-"));
  const prefix = path.join(dir, "tricky");
  beforeAll(() => { execFileSync(python, [path.join(scripts, "make_tricky_office_fixture.py"), prefix]); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const run = (script: string, input: string, output: string, extra: string[] = []) =>
    execFileSync(python, [path.join(scripts, script), "--input", input, "--output", output, ...extra]);

  it("extracts a deck with groups, charts, pictures, tables, placeholders and a shape whose shape_type raises", () => {
    run("pptx_extract.py", `${prefix}.pptx`, `${prefix}.pptx.json`);
    const deck = JSON.parse(readFileSync(`${prefix}.pptx.json`, "utf8")) as { slides: { title: string; notes: string; shapes: { text: string; box: unknown }[] }[] };
    expect(deck.slides).toHaveLength(2);
    const texts = deck.slides[0]!.shapes.map(s => s.text);
    expect(texts).toEqual(expect.arrayContaining(["Quarterly results", "Plain text box about headcount", "Grouped note on churn", "Odd freeform label"]));
    expect(texts.some(t => t.includes("EMEA | 42"))).toBe(true);
    expect(deck.slides[0]!.title).toBe("Quarterly results");
    expect(deck.slides[0]!.notes).toContain("churn");
  });

  it("bounds the xlsx structure pass and keeps absolute rows around blank rows and merged cells", () => {
    run("xlsx_extract.py", `${prefix}.xlsx`, `${prefix}.xlsx.json`, ["--structure-only"]);
    const book = JSON.parse(readFileSync(`${prefix}.xlsx.json`, "utf8")) as { sheets: { name: string; headerRow: number; dataRows: number[]; truncated: boolean; csv: string }[] };
    const orders = book.sheets.find(s => s.name === "Orders")!;
    expect(orders.headerRow).toBe(1);
    expect(orders.dataRows).toEqual([2, 4, 6]); // blank rows 3 and 5 are skipped but numbering stays absolute
    expect(orders.csv.trim().split("\n")).toHaveLength(1); // header row only
    expect(book.sheets.find(s => s.name === "Wide")!.truncated).toBe(true); // A1:XFD1048576 does not run for the whole timeout
  });

  it("writes a run of empty rows as one blank line, so a stray cell far down a sheet is a page, not thousands", () => {
    const book = path.join(dir, "stray.xlsx");
    // An 11-cell sheet with a note at A100000: the old sidecar wrote 99,999 rows of commas for the gap (1,667 pages by the 60-line rule).
    execFileSync(python, ["-c", [
      "import openpyxl, sys",
      "wb = openpyxl.Workbook(); ws = wb.active",
      "for row in range(1, 11): ws.cell(row=row, column=1, value=f'cell {row}')",
      "ws['A100000'] = 'a note'",
      "wb.save(sys.argv[1])",
    ].join("\n"), book]);
    run("xlsx_extract.py", book, `${book}.json`);
    const sheet = (JSON.parse(readFileSync(`${book}.json`, "utf8")) as { sheets: { csv: string }[] }).sheets[0]!;
    expect(sheet.csv.split(/\r?\n/).length).toBeLessThan(20);
    expect(textBodyPages([sheet.csv])).toBe(1);
  });

  it("ends each row at its last filled cell, so a stray cell at XFD1 does not pad every row to 16,384 columns", () => {
    const book = path.join(dir, "far.xlsx");
    // The council's 12 KB file that measured 4,688 pages: 1,000 rows in column A and an "x" at XFD1.
    execFileSync(python, ["-c", [
      "import openpyxl, sys",
      "wb = openpyxl.Workbook(); ws = wb.active",
      "for row in range(1, 1001): ws.cell(row=row, column=1, value=f'row {row}')",
      "ws['XFD1'] = 'x'",
      "wb.save(sys.argv[1])",
    ].join("\n"), book]);
    run("xlsx_extract.py", book, `${book}.json`);
    const sheet = (JSON.parse(readFileSync(`${book}.json`, "utf8")) as { sheets: { csv: string; lastCol: number }[] }).sheets[0]!;
    const lines = sheet.csv.trim().split(/\r?\n/);
    expect(lines[0]!.endsWith(",x")).toBe(true); // the far cell is kept where it is
    expect(lines.slice(1).every((line) => !line.includes(","))).toBe(true);
    expect(sheet.lastCol).toBe(16_384);
    expect(textBodyPages([csvCellText(sheet.csv)])).toBe(17);
  });
});
