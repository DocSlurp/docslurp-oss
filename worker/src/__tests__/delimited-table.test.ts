import { describe, expect, it } from "vitest";
import { parseDelimitedRows, delimitedTableMarkdown, detectDelimiter, decodeDelimitedBytes } from "../lib/delimited-table.js";
import { parseJsonContent } from "../stages/embedding-runtime.js";
import type { Document } from "../models.js";
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

describe("delimiter detection", () => {
  const german = "Datum;Betrag;Beschreibung\n13.04.2026;12,50;Miete\n14.04.2026;1,5;Strom\n";

  it("splits a German semicolon CSV on semicolons, not on its decimal commas", () => {
    expect(detectDelimiter(german, "rechnung.csv")).toBe(";");
    const markdown = delimitedTableMarkdown(german, "rechnung.csv");
    expect(markdown).toContain("| Datum | Betrag | Beschreibung |");
    expect(markdown).toContain("| 13.04.2026 | 12,50 | Miete |");
  });

  it("detects tabs and pipes, ignores delimiters inside quotes, and defaults to the comma", () => {
    expect(detectDelimiter("a\tb\n1\t2\n")).toBe("\t");
    expect(detectDelimiter("a|b|c\n1|2|3\n")).toBe("|");
    expect(detectDelimiter('name,note\n"x;y;z",1\n"p;q;r",2\n')).toBe(",");
    expect(detectDelimiter("single column\nvalue\n")).toBe(",");
    expect(detectDelimiter("a;b\n1;2\n", "data.tsv")).toBe("\t");
  });

  it("decodes UTF-16 and Windows-1252 exports instead of mangling them", () => {
    expect(decodeDelimitedBytes(Buffer.from("\uFEFFname;total\nMüller;4", "utf16le"))).toBe("name;total\nMüller;4");
    expect(decodeDelimitedBytes(Buffer.from([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72]))).toBe("Müller");
    expect(decodeDelimitedBytes(Buffer.from("日本語"))).toBe("日本語");
  });
});

describe("JSON Lines flattening", () => {
  const document = { id: "doc", filename: "events.jsonl", mimeType: "application/jsonl+json" } as unknown as Document;

  it("serializes nested values as JSON, never [object Object]", () => {
    const raw = '{"id":1,"user":{"name":"Zoë","tags":["a","b"]},"ok":true}\n{"id":2,"user":null,"ok":false}\n';
    const { text } = parseJsonContent(raw, document);
    expect(text).not.toContain("[object Object]");
    expect(text.split("\n")[0]).toBe('id: 1, user: {"name":"Zoë","tags":["a","b"]}, ok: true');
    expect(text.split("\n")[1]).toBe("id: 2, user: null, ok: false");
  });
});

