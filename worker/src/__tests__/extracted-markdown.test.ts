import { describe, expect, it } from "vitest";

import {
  normalizeExtractedMarkdown,
  sanitizeExtractedMarkdown,
  scoreExtractionPlausibility,
  scoreMarkdownCandidate,
} from "../lib/extracted-markdown.js";

describe("extraction plausibility", () => {
  it("names the legacy score as plausibility rather than quality", () => {
    const signals = scoreExtractionPlausibility("A useful paragraph of text.", 1);
    expect(signals.plausibilityScore).toBeGreaterThan(0);
    expect(signals).toMatchObject({ charCount: 27, wordCount: 5 });
  });

  it("externalizes base64 data URIs", () => {
    const sanitized = sanitizeExtractedMarkdown(
      `before ![](data:image/png;base64,${"a".repeat(200)}) after`,
    );
    expect(sanitized.markdown).toBe(
      "before ![](artifact://externalized-data-uri) after",
    );
    expect(sanitized.strippedDataUriCount).toBe(1);
    expect(sanitized.strippedDataUriBytes).toBeGreaterThan(200);
  });
});

describe("normalizeExtractedMarkdown", () => {
  it("converts markdown pipe tables to html when tables are preserved", () => {
    const markdown = `Recovery targets:

| Service | RTO |
| --- | --- |
| Checkout | 15 min |
| Search | 1 h |
`;

    const normalized = normalizeExtractedMarkdown({ markdown, preserveTables: true });

    expect(normalized).toContain("<th>Service</th><th>RTO</th>");
    expect(normalized).toContain("<tr><td>Checkout</td><td>15 min</td></tr>");
    expect(normalized).not.toContain("| --- |");
  });

  it("leaves html tables exactly as extracted", () => {
    const markdown = `<table>
<thead><tr><th>A</th><th>B</th><th>A</th><th>B</th></tr></thead>
<tbody><tr><td>1 2 3 4</td><td>w x y z</td><td></td><td></td></tr></tbody>
</table>`;

    expect(normalizeExtractedMarkdown({ markdown, preserveTables: true })).toBe(markdown);
  });

  it("leaves markdown unchanged when table preservation is disabled", () => {
    const markdown = `| Service | RTO |
| --- | --- |
| Checkout | 15 min |
`;

    const normalized = normalizeExtractedMarkdown({
      markdown,
      preserveTables: false,
    });

    expect(normalized).toBe(markdown);
  });
});

describe("scoreMarkdownCandidate", () => {
  it("rewards table-rich markdown", () => {
    const plain = scoreMarkdownCandidate({ markdown: "plain text only" });
    const tabled = scoreMarkdownCandidate({
      markdown: "<table><thead><tr><th>A</th></tr></thead><tbody><tr><td>B</td></tr></tbody></table>",
    });

    expect(tabled.htmlTableCount).toBe(1);
    expect(tabled.selectionScore).toBeGreaterThan(plain.selectionScore);
  });

  it("rewards formatting-rich markdown when extraction quality ties", () => {
    const plain = scoreMarkdownCandidate({
      markdown: "Title\nPlain paragraph text with enough words to score well.",
    });
    const formatted = scoreMarkdownCandidate({
      markdown:
        "# Title\n\n**Plain paragraph text** with enough words to score well.",
    });

    expect(formatted.plausibilityScore).toBeGreaterThanOrEqual(
      plain.plausibilityScore,
    );
    expect(formatted.formattingScore).toBeGreaterThan(plain.formattingScore);
    expect(formatted.selectionScore).toBeGreaterThan(plain.selectionScore);
  });
});
