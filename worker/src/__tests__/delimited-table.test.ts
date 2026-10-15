import { describe, expect, it } from "vitest";
import { parseDelimitedRows, delimitedTableMarkdown } from "../lib/delimited-table.js";
describe("spreadsheet delimited content", () => {
  it("preserves quoted commas, newlines, escaped quotes, empty values and BOM", () => {
    expect(parseDelimitedRows('\uFEFFname,note,value\r\n"Park, North","line 1\nline ""2""",\r\n')).toEqual([["name", "note", "value"], ["Park, North", 'line 1\nline "2"', ""]]);
  });
  it("keeps table cells intact for knowledge retrieval", () => {
    const markdown = delimitedTableMarkdown('name,note,total\n"Park, North","a|b\nnext",42', "report.csv");
    expect(markdown).toContain('| Park, North | a\\|b<br>next | 42 |');
    expect(markdown).toContain('| name | note | total |');
  });
  it("handles TSV and header-only spreadsheets", () => {
    expect(delimitedTableMarkdown('name\ttotal\nTeam\t8', 'report.tsv')).toContain('| Team | 8 |');
    expect(delimitedTableMarkdown('name,total', 'report.csv')).toBe('| name | total |\n| --- | --- |');
  });
  it("rejects malformed quoting instead of silently corrupting cells", () => {
    expect(() => parseDelimitedRows('name\n"unfinished')).toThrow(/unterminated/);
  });
});
