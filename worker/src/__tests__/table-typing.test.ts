import { describe, expect, it } from "vitest";

import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { typeColumn } from "../lib/table-typing.js";

const typed = (values: string[]) => typeColumn(values).cells.map((cell) => cell.typedValue);
const types = (values: string[]) => typeColumn(values).cells.map((cell) => cell.valueType);

describe("table column typing", () => {
  it("never turns free text into a date", () => {
    // `new Date("Item 5")` is 2001-05-01 in V8.
    expect(types(["Item 5", "Item 12", "Room 3"])).toEqual(["string", "string", "string"]);
    expect(typed(["Item 5"])).toEqual(["Item 5"]);
    expect(types(["Spring 2026", "Q3 2025", "May", "13"])).toEqual(["string", "string", "string", "number"]);
  });

  it("reads decimal commas as decimals in a European column", () => {
    expect(typed(["€12,50", "€1.234,00", "€7,5"])).toEqual([12.5, 1234, 7.5]);
    expect(types(["€12,50", "€1.234,00"])).toEqual(["currency", "currency"]);
    expect(typed(["1,5", "2,25"])).toEqual([1.5, 2.25]);
    expect(typed(["12,50 €", "3 456,78 €"])).toEqual([12.5, 3456.78]);
  });

  it("reads thousands commas in a US column", () => {
    expect(typed(["$1,200.50", "$3,000,000.00", "$7"])).toEqual([1200.5, 3000000, 7]);
    expect(typed(["¥12,000", "¥3,000,000"])).toEqual([12000, 3000000]);
    expect(types(["¥12,000"])).toEqual(["currency"]);
  });

  it("leaves a lone ambiguous 1,234 as text instead of guessing a locale", () => {
    expect(types(["1,234"])).toEqual(["string"]);
    // ...but another cell can settle the column's locale.
    expect(typed(["1,234", "5,678.90"])).toEqual([1234, 5678.9]);
    expect(typed(["1,234", "5.678,90"])).toEqual([1.234, 5678.9]);
  });

  it("keeps a column that mixes conventions as text", () => {
    expect(types(["1,234.50", "5.678,90"])).toEqual(["string", "string"]);
  });

  it("reads percentages and negatives in the column locale", () => {
    expect(typed(["12,5 %", "3 %"])).toEqual([12.5, 3]);
    expect(types(["12,5 %", "3 %"])).toEqual(["percentage", "percentage"]);
    expect(typed(["-4,5", "(1.200,00)"])).toEqual([-4.5, -1200]);
  });

  it("does not make identifiers into numbers", () => {
    expect(types(["00123", "00456"])).toEqual(["string", "string"]);
    expect(types(["4111111111111111"])).toEqual(["string"]);
  });

  it("accepts unambiguous date formats and writes ISO dates without any time-zone shift", () => {
    expect(typed(["2026-04-13", "2026/04/14", "13.04.2026", "13 April 2026", "April 13, 2026", "2026年4月13日"]))
      .toEqual(["2026-04-13", "2026-04-14", "2026-04-13", "2026-04-13", "2026-04-13", "2026-04-13"]);
    expect(typed(["2026-04-13T00:00:00Z"])).toEqual(["2026-04-13"]);
  });

  it("rejects impossible calendar dates", () => {
    expect(types(["2026-02-30", "31.04.2026", "2026-13-01", "32 January 2026"])).toEqual(["string", "string", "string", "string"]);
    expect(typed(["29 February 2028"])).toEqual(["2028-02-29"]);
    expect(types(["29 February 2027"])).toEqual(["string"]);
  });

  it("infers day-first or month-first slash dates from the other cells in the column", () => {
    expect(typed(["13/04/2026", "05/06/2026"])).toEqual(["2026-04-13", "2026-06-05"]);
    expect(typed(["04/13/2026", "05/06/2026"])).toEqual(["2026-04-13", "2026-05-06"]);
    expect(typed(["13/04/2026", "04/13/2026"])).toEqual(["13/04/2026", "04/13/2026"]);
  });

  it("rejects an ambiguous slash date rather than guessing", () => {
    expect(types(["04/05/2026"])).toEqual(["string"]);
    expect(typed(["04/04/2026"])).toEqual(["2026-04-04"]);
  });

  it("keeps booleans and empties", () => {
    expect(types(["true", "No", ""])).toEqual(["boolean", "boolean", "empty"]);
  });

  it("is independent of the process time zone", () => {
    const original = process.env.TZ;
    try {
      for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
        process.env.TZ = tz;
        expect(typed(["13/04/2026", "2026-04-13", "April 13, 2026"])).toEqual(["2026-04-13", "2026-04-13", "2026-04-13"]);
      }
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });
});

describe("markdown tables in canonical documents", () => {
  const rowsOf = (markdown: string) => {
    const document = buildCanonicalDocumentFromMarkdown({ documentId: "t", text: markdown, pageCount: 1, extractor: "test" });
    return buildCanonicalChunksFromDocument(document, "fallback").filter((chunk) => chunk.tableGranularity === "row");
  };

  it("types a column from all of its cells", () => {
    const rows = rowsOf([
      "| Posten | Betrag | Datum |",
      "| --- | --- | --- |",
      "| Item 5 | €12,50 | 13/04/2026 |",
      "| Item 6 | 1,5 | 05/06/2026 |",
    ].join("\n"));
    expect(rows[0]!.tableColumnTypes).toEqual(["string", "string", "date"]);
    // 12,50 and 1,5 are decimals (never 1250 and 15); the column mixes currency and number, so it is "string".
    expect(rows[0]!.tableCells?.map((cell) => cell.typedValue)).toEqual(["Item 5", 12.5, "2026-04-13"]);
    expect(rows[1]!.tableCells?.map((cell) => cell.typedValue)).toEqual(["Item 6", 1.5, "2026-06-05"]);
  });

  it("keeps cells beyond the header width under generated column names", () => {
    const rows = rowsOf(["| A | B |", "| --- | --- |", "| 1 | 2 | 3 | 4 |", "| 5 | 6 |"].join("\n"));
    expect(rows[0]!.tableColumnNames).toEqual(["A", "B", "Column 3", "Column 4"]);
    expect(rows[0]!.tableCells?.map((cell) => cell.rawValue)).toEqual(["1", "2", "3", "4"]);
    expect(rows[1]!.tableCells?.map((cell) => cell.rawValue)).toEqual(["5", "6", "", ""]);
    expect(rows[0]!.text).toContain("Column 4: 4");
  });
});
