import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractStructuredJsonFile, StructuredJsonError, structuredJsonToMarkdown } from "./structured-json.js";

describe("structuredJsonToMarkdown", () => {
  it("renders a plain object as key paths", () => {
    const result = structuredJsonToMarkdown(JSON.stringify({ title: "Quarterly plan", count: 3, ok: false, missing: null }));
    expect(result.format).toBe("json");
    expect(result.markdown).toBe(
      ["- `title`: Quarterly plan", "- `count`: 3", "- `ok`: false", "- `missing`: null", ""].join("\n"),
    );
  });

  it("renders an array of similar objects as a table and keeps overflow values", () => {
    const longNote = "x".repeat(30) + " searchable-tail-token";
    const result = structuredJsonToMarkdown(
      JSON.stringify([
        { id: 1, name: "Alpha", meta: { region: "eu" }, note: longNote },
        { id: 2, name: "Beta | Gamma", meta: { region: "us" }, children: [{ k: "deep-value" }] },
      ]),
      { maxCellChars: 20 },
    );
    const lines = result.markdown.split("\n");
    expect(lines).toContain("| # | id | name | meta.region | note | children |");
    expect(lines).toContain("| 2 | 2 | Beta \\| Gamma | us |  | 1 item (below) |");
    // Shortened and nested cells are listed in full below the table.
    expect(result.markdown).toContain(`- \`[0].note\`: ${longNote}`);
    expect(result.markdown).toContain("- `[1].children[0].k`: deep-value");
  });

  it("splits large tables into bounded row blocks", () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: index, label: `row-${index}` }));
    const markdown = structuredJsonToMarkdown(JSON.stringify({ rows }), { maxTableRows: 2 }).markdown;
    expect(markdown).toContain("_rows rows 1–2 of 5_");
    expect(markdown).toContain("_rows rows 5–5 of 5_");
    expect(markdown.match(/^\| # \| id \| label \|$/gm)).toHaveLength(3);
    for (const row of rows) expect(markdown).toContain(row.label);
  });

  it("renders nested data as headings and falls back to key paths when deep or dissimilar", () => {
    const markdown = structuredJsonToMarkdown(
      JSON.stringify({
        org: { name: "Acme", address: { city: "Lyon", geo: { lat: 45.76, deeper: { zone: "z-9" } } } },
        tags: ["red", "blue"],
        mixed: [{ a: 1 }, { b: 2 }, "loose"],
        "odd key": { "inner key": "spaced" },
      }),
      { maxHeadingDepth: 2 },
    ).markdown;
    expect(markdown).toContain("## org\n\n- `org.name`: Acme");
    expect(markdown).toContain("### org.address\n\n- `org.address.city`: Lyon");
    // Past the heading budget, nested values become key paths.
    expect(markdown).toContain("- `org.address.geo.lat`: 45.76");
    expect(markdown).toContain("- `org.address.geo.deeper.zone`: z-9");
    expect(markdown).toContain("- `tags`: red, blue");
    expect(markdown).toContain("### mixed[0]\n\n- `mixed[0].a`: 1");
    expect(markdown).toContain("- `mixed[2]`: loose");
    expect(markdown).toContain('- `["odd key"]["inner key"]`: spaced');
  });

  it("renders JSONL as one section per record and notes skipped lines", () => {
    const result = structuredJsonToMarkdown(['{"id":1,"msg":"first"}', "{not json", "", '{"id":2,"msg":"second"}'].join("\n"));
    expect(result.format).toBe("jsonl");
    expect(result.recordCount).toBe(2);
    expect(result.skippedLines.map((entry) => entry.line)).toEqual([2]);
    expect(result.markdown).toContain("_JSON Lines · 2 records · 1 malformed line skipped_");
    expect(result.markdown).toContain("## Record 1 (line 1)\n\n- `id`: 1\n- `msg`: first");
    expect(result.markdown).toContain("## Record 2 (line 4)\n\n- `id`: 2\n- `msg`: second");
    expect(result.markdown).toMatch(/## Skipped lines\n\n- line 2: /);
  });

  it("throws a clear error for malformed JSON", () => {
    expect(() => structuredJsonToMarkdown('{"a": 1,')).toThrow(StructuredJsonError);
    expect(() => structuredJsonToMarkdown('{"a": 1,')).toThrow(/^structured-json: malformed JSON: /);
    expect(() => structuredJsonToMarkdown("{bad\n{worse")).toThrow(/malformed JSON/);
    expect(() => structuredJsonToMarkdown("  \n")).toThrow(/input is empty/);
  });

  it("bounds output for large inputs and never emits form feeds", () => {
    const records = Array.from({ length: 2_000 }, (_, index) => JSON.stringify({ id: index, text: `value\f${index}` }));
    const result = structuredJsonToMarkdown(records.join("\n"), { maxOutputChars: 5_000 });
    expect(result.truncated).toBe(true);
    expect(result.markdown.length).toBeLessThan(5_200);
    expect(result.markdown).toMatch(/_Output truncated at 5000 characters after \d+ of 2000 records\._/);
    expect(result.markdown).not.toContain("\f");
  });

  it("writes Markdown for a file on disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-structured-json-"));
    const source = path.join(dir, "source.json");
    await writeFile(source, JSON.stringify({ hello: "world" }));
    await extractStructuredJsonFile(source, `${source}.json.md`);
    expect(await readFile(`${source}.json.md`, "utf8")).toBe("- `hello`: world\n");
  });
});
