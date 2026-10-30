import { describe, expect, it } from "vitest";

import {
  buildCanonicalChunksFromDocument,
  buildCanonicalDocumentFromMarkdown,
  canonicalDocumentToText
} from "../lib/canonical-document.js";

describe("buildCanonicalDocumentFromMarkdown", () => {
  it("creates typed blocks with heading paths and explicit page numbers", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-1",
      text: "# Intro\nParagraph one.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\f## Code\n```ts\nconst x = 1;\n```",
      pageCount: 2,
      sourceArtifactUri: "s3://bucket/doc-1.md",
      extractor: "docling"
    });

    expect(document.stats.blockCount).toBe(5);
    expect(document.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "table",
      "heading",
      "code"
    ].slice(0, document.blocks.length));
    expect(document.blocks[0]?.headingPath).toEqual(["Intro"]);
    expect(document.blocks[1]?.pageNumber).toBe(1);
    expect(document.blocks.at(-1)?.pageNumber).toBe(2);
  });

  it("round-trips canonical text from the block tree", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-2",
      text: "# Intro\nParagraph one.\n\n- bullet",
      pageCount: 1,
      extractor: "pandoc"
    });

    const text = canonicalDocumentToText(document);
    expect(text).toContain("# Intro");
    expect(text).toContain("Paragraph one.");
    expect(text).toContain("- bullet");
  });

  it("applies the shared fallback page splitter when no form-feed exists", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-2b",
      text: "alpha beta gamma delta epsilon zeta",
      pageCount: 2,
      extractor: "pandoc"
    });

    expect(document.blocks.some((block) => block.pageNumber === 1)).toBe(true);
    expect(document.blocks.some((block) => block.pageNumber === 2)).toBe(true);
    expect(document.stats.pageCount).toBe(2);
  });
});

describe("buildCanonicalChunksFromDocument", () => {
  it("preserves block ids, types, and page provenance on chunks", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-3",
      text: "# Intro\nParagraph one.\n\n## Details\nParagraph two.",
      pageCount: 1,
      extractor: "pandoc"
    });

    const chunks = buildCanonicalChunksFromDocument(document, "fallback");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.blockIds.length).toBeGreaterThan(0);
    expect(chunks[0]?.blockTypes.length).toBeGreaterThan(0);
    expect(chunks[0]?.pageNumber).toBe(1);
  });

  it("carries page-region boxes from canonical block bboxes", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-3b",
      text: "# Intro\nParagraph one.",
      pageCount: 1,
      extractor: "pandoc"
    });
    const paragraph = document.blocks.find((block) => block.type === "paragraph");
    if (!paragraph) {
      throw new Error("expected paragraph block");
    }
    paragraph.bbox = { x: 15, y: 24, width: 210, height: 48 };
    paragraph.metadata.bboxCoordinateSpace = "page-top-left-points";

    const chunks = buildCanonicalChunksFromDocument(document, "fallback");

    expect(chunks[0]?.regionBoxes?.length).toBeGreaterThan(0);
    expect(chunks[0]?.regionBoxes?.[0]?.pageNumber).toBe(1);
    expect(chunks[0]?.regionCoordinateSpace).toBe("page-top-left-points");
  });

  it("adds overlap chunks when overlap is enabled", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-4",
      text: "# Intro\n" + "Sentence one. ".repeat(200),
      pageCount: 1,
      extractor: "pandoc"
    });

    const chunks = buildCanonicalChunksFromDocument(document, "fallback", { chunkOverlap: true, maxChars: 300 });
    expect(chunks.some((chunk) => chunk.overlapIndex === 1)).toBe(true);
  });

  it("preserves canonical HTML tables, bounded cell values, page provenance and overlap boundaries", () => {
    const table = '<table>\n<tr><td rowspan="2">shared</td><td>' + 'word '.repeat(100) + '</td></tr>\n<tr><td>last</td></tr>\n</table>';
    const document = buildCanonicalDocumentFromMarkdown({ documentId: "html-example", text: '# Parent\nIntro\n' + table + '\n# After\nend', pageCount: 1, extractor: "test" });
    expect(document.blocks.filter(b => b.type === "table")).toHaveLength(1);
    const chunks = buildCanonicalChunksFromDocument(document, "fallback", { maxChars: 180, chunkOverlap: true });
    const tables = chunks.filter(c => c.blockTypes.includes("table"));
    expect(tables.length).toBeGreaterThan(1);
    expect(tables.every(c => c.text.length <= 180 && c.overlapIndex === 0 && c.pageNumber === 1 && c.blockIds.length === 1)).toBe(true);
    const records = tables.flatMap(c => c.text.split("\n\n")).map(r => { const i = r.indexOf("\n"); return { context: r.slice(0, i), value: JSON.parse(r.slice(i + 1)) }; });
    expect(records.filter(r => r.context.includes("row 1 column 2")).map(r => r.value).join("")).toBe('word '.repeat(100));
    expect(records.filter(r => r.context.includes("row 2 column 2")).map(r => r.value)).toEqual(["last"]);
  });

  it("keeps unsupported CDATA source protected in canonical chunks", () => {
    const source = '<table><tr><td><svg><![CDATA[x> </table>]]></svg>\n' + 'A'.repeat(180) + '</td></tr>\n</table>';
    const document = buildCanonicalDocumentFromMarkdown({ documentId: "cdata", text: source, pageCount: 1, extractor: "test" });
    const chunks = buildCanonicalChunksFromDocument(document, "fallback", { maxChars: 128 });
    expect(chunks.every(c => c.text.length <= 128 && c.text.includes("unparsed source"))).toBe(true);
    expect(chunks.flatMap(c => c.text.split("\n\n")).map(r => JSON.parse(r.slice(r.indexOf("\n") + 1))).join("")).toBe(source);
  });

  it("emits table, row, and cell chunks with schema-aware metadata", () => {
    const document = buildCanonicalDocumentFromMarkdown({
      documentId: "doc-5",
      text: [
        "# Contracts",
        "| Vendor | Renewal Date | Active | Amount |",
        "| --- | --- | --- | --- |",
        "| Acme | 2025-01-05 | true | $1,200.50 |"
      ].join("\n"),
      pageCount: 1,
      extractor: "docling"
    });

    const chunks = buildCanonicalChunksFromDocument(document, "fallback");
    const rowChunk = chunks.find((chunk) => chunk.tableGranularity === "row");
    const cellChunk = chunks.find((chunk) => chunk.tableGranularity === "cell" && chunk.tableCell?.columnName === "Renewal Date");

    expect(chunks.some((chunk) => chunk.tableGranularity === "table")).toBe(true);
    expect(rowChunk?.tableRowIndex).toBe(0);
    expect(rowChunk?.tableColumnNames).toEqual(["Vendor", "Renewal Date", "Active", "Amount"]);
    expect(rowChunk?.tableColumnTypes).toEqual(["string", "date", "boolean", "currency"]);
    expect(rowChunk?.tableCells?.[1]?.typedValue).toBe("2025-01-05");
    expect(cellChunk?.tableCell?.typedValue).toBe("2025-01-05");
  });
});
