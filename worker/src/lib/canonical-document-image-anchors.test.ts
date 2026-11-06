import { describe, expect, it } from "vitest";
import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "./canonical-document.js";

const ref = (alt: string, page = 1, occurrence = 0) => `![${alt}](docslurp-artifact:doc-1:${"a".repeat(64)}.webp#p${page}o${occurrence})`;
const build = (text: string, pageCount: number) => buildCanonicalDocumentFromMarkdown({ documentId: "doc-1", text, pageCount, extractor: "vm-pdf" });

describe("image references in the canonical document", () => {
  const md = `Opening paragraph about revenue.\n\n${ref("Revenue by region")}\n\nClosing paragraph.\f${ref("")}\n\nPage two text.`;

  it("an image reference is its own block whose text is the alt text, never the link target", () => {
    const doc = build(md, 2);
    const image = doc.blocks.filter((b) => b.metadata.extractor === "embedded-image");
    expect(image.map((b) => [b.pageNumber, b.text, b.metadata.imageAnchor])).toEqual([[1, "Revenue by region", "p1o0"], [2, "", "p1o0"]]);
    expect(image[0]!.metadata.imageArtifactId).toBe(`doc-1:${"a".repeat(64)}.webp`);
    expect(doc.blocks.map((b) => b.text).join("\n")).not.toMatch(/docslurp-artifact|\.webp/);
    // Offsets still cover the whole Markdown line, so a citation can highlight it.
    expect(image[0]!.metadata.charEnd as number - (image[0]!.metadata.charStart as number)).toBe(ref("Revenue by region").length);
  });

  it("a reference directly under a paragraph does not become part of it", () => {
    const doc = build(`Text line one\n${ref("A figure")}\nText line two`, 1);
    expect(doc.blocks.map((b) => b.text)).toEqual(["Text line one", "A figure", "Text line two"]);
  });

  it("chunks and the raw fallback carry no artifact ids", () => {
    const chunks = buildCanonicalChunksFromDocument(build(md, 2), md);
    expect(chunks.map((c) => c.text).join("\n")).not.toMatch(/docslurp-artifact|\.webp|#p\d+o\d+/);
    const onlyImages = `${ref("")}\f${ref("", 2)}`;
    const fallback = buildCanonicalChunksFromDocument(build(onlyImages, 2), onlyImages);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]!.text).not.toMatch(/docslurp-artifact|\.webp/);
  });
});
