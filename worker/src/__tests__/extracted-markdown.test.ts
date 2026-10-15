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
  it("converts supporting policy form lists into an html table", () => {
    const markdown = `# **ACTUARIAL MEMORANDUM**

**Supporting Policy Form:**

**ICC18 ENT-06 1805** **Single Premium Deferred Annuity Contract with Market**
**Value Adjustment Feature**
**ICC18 ENT-06 1805 DP** **Data Page**
**ICC22 EE.48 2208** **Account Value Band Interest Rate Endorsement**
`;

    const normalized = normalizeExtractedMarkdown({
      markdown,
      preserveTables: true,
    });

    expect(normalized).toContain("<table>");
    expect(normalized).toContain(
      "<td>ICC18 ENT-06 1805</td><td>Single Premium Deferred Annuity Contract with Market Value Adjustment Feature</td>",
    );
    expect(normalized).not.toContain("**ICC22 EE.48 2208** **Account Value Band Interest Rate Endorsement**");
  });

  it("expands collapsed four-column html tables into multiple rows", () => {
    const markdown = `<table>
<thead>
<tr><th>Class</th><th>Relativity</th><th>Class</th><th>Relativity</th></tr>
</thead>
<tbody>
<tr><td>8833 8837 8838 8858</td><td>1.08 'a' 0.87 0.41</td><td></td><td></td></tr>
</tbody>
</table>`;

    const normalized = normalizeExtractedMarkdown({
      markdown,
      preserveTables: true,
    });

    expect(normalized).toContain("<th>Class</th><th>Relativity</th><th>Class</th><th>Relativity</th>");
    expect(normalized).toContain("<tr><td>8833</td><td>1.08</td><td></td><td></td></tr>");
    expect(normalized).toContain("<tr><td>8837</td><td>'a'</td><td></td><td></td></tr>");
    expect(normalized).toContain("<tr><td>8838</td><td>0.87</td><td></td><td></td></tr>");
    expect(normalized).toContain("<tr><td>8858</td><td>0.41</td><td></td><td></td></tr>");
  });

  it("repairs supporting policy html tables that promoted the first row into headers", () => {
    const markdown = `## Supporting Policy Form:

<table>
<thead>
<tr><th>ICC18 ENT-06 1805</th><th>Single Premium Deferred Annuity Contract with Market Value Adjustment Feature</th></tr>
</thead>
<tbody>
<tr><td>ICC18 ENT-06 1805 DP ICC18 ENT-06 1805 DP-A ICC18 ENT-06 1805 DP-B ICC18 ENT-06 1805 DP-C ICC18 ENT-06 1805 DP-D ICC18 ENT-06 1805 DP-E ICC22 EE.48 2208</td><td>Data Page Data Page Data Page Data Page Data Page Data Page AccountValue BandInterestRate Endorsement</td></tr>
</tbody>
</table>`;

    const normalized = normalizeExtractedMarkdown({
      markdown,
      preserveTables: true,
    });

    expect(normalized).toContain("<th>Supporting Policy Form</th><th>Supporting Policy Form</th>");
    expect(normalized).toContain("<td>ICC18 ENT-06 1805</td><td>Single Premium Deferred Annuity Contract with Market Value Adjustment Feature</td>");
    expect(normalized).toContain("<td>ICC18 ENT-06 1805 DP-A</td><td>Data Page</td>");
    expect(normalized).toContain("<td>ICC22 EE.48 2208</td><td>Account Value Band Interest Rate Endorsement</td>");
  });

  it("repairs supporting policy markdown tables before generic html conversion", () => {
    const markdown = `## Supporting Policy Form:

| ICC18 ENT-06 1805 | Single Premium Deferred Annuity Contract with Market Value Adjustment Feature |
| --- | --- |
| ICC18 ENT-06 1805 DP ICC18 ENT-06 1805 DP-A ICC18 ENT-06 1805 DP-B ICC18 ENT-06 1805 DP-C ICC18 ENT-06 1805 DP-D ICC18 ENT-06 1805 DP-E ICC22 EE.48 2208 | Data Page Data Page Data Page Data Page Data Page Data Page AccountValue BandInterestRate Endorsement |
`;

    const normalized = normalizeExtractedMarkdown({
      markdown,
      preserveTables: true,
    });

    expect(normalized).toContain("<th>Supporting Policy Form</th><th>Supporting Policy Form</th>");
    expect(normalized).toContain("<td>ICC18 ENT-06 1805 DP</td><td>Data Page</td>");
    expect(normalized).toContain("<td>ICC22 EE.48 2208</td><td>Account Value Band Interest Rate Endorsement</td>");
  });

  it("leaves markdown unchanged when table preservation is disabled", () => {
    const markdown = `| Class | Relativity |
| --- | --- |
| 8833 | 1.08 |
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
