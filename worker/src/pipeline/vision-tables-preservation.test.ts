/**
 * Council #338 re-check: a rebuilt table never loses text the original region had, and nothing derived from a table
 * region can render as markup. Rendering goes through remark-parse + remark-gfm, the Markdown parser stack the app's
 * react-markdown renderer uses, so "renders as text" is checked on a real CommonMark/GFM tree, not on string shapes.
 */
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";

import { readTableCells } from "./table-cells-guest.js";
import { readVisionTables, VISION_TABLE_MAX_PAGE_CHARS, VISION_TABLE_MAX_TEXT_CHARS, type VisionTableSegment } from "./vision-tables-guest.js";
import { escapeMarkdownText, RENDER_MAX_CHARS, sanitizeVisionPageTables, type VisionTableStats } from "./vision-tables-vm.js";

interface MdNode { type: string; value?: string; url?: string; lang?: string | null; meta?: string | null; children?: MdNode[]; position?: { start: { offset: number }; end: { offset: number } } }
const markdown = unified().use(remarkParse).use(remarkGfm);
const parse = (text: string) => markdown.parse(text) as unknown as MdNode;
const walk = (node: MdNode, visit: (node: MdNode) => void) => { visit(node); for (const child of node.children ?? []) walk(child, visit); };

async function clean(text: string): Promise<{ out: string; stats: VisionTableStats }> {
  const { texts, stats } = await sanitizeVisionPageTables([text], null, { vmOnly: false });
  return { out: texts[0]!, stats };
}

/** A rebuilt table: only the allow-listed tags, span attributes, and escaped text. */
const STRICT_TABLE = /^<table>\n(?:<\/?(?:thead|tbody)>\n|<tr>(?:<(t[hd])(?: rowspan="[1-9]\d{0,2}")?(?: colspan="[1-9]\d{0,2}")?>[^<>]*<\/\1>)*<\/tr>\n)*<\/table>$/;
const decode = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** The text a reader sees: text, code and math values, plus the decoded cell text of rebuilt tables. */
function renderedText(out: string): string {
  const parts: string[] = [];
  walk(parse(out), (node) => {
    if (node.type === "html") parts.push(STRICT_TABLE.test(node.value!) ? decode(node.value!) : node.value!);
    else if (typeof node.value === "string") parts.push(node.value);
    else if (node.type === "break") parts.push("\n");
    // A code fence's info string is page text too (kept verbatim; a renderer shows it as the language label).
    if (node.type === "code") parts.push(node.lang ?? "", node.meta ?? "");
  });
  return parts.join(" ");
}

/**
 * No markup from a table region: every html node is a strict rebuilt table, or consists only of tags that were outside
 * every table region in the input (passed through verbatim, council finding I1, documented); links are http(s)/mailto.
 */
function expectNoRegionMarkup(input: string, out: string, segments: VisionTableSegment[] | null | false) {
  const outside = !segments ? [input] : segments.filter((s) => s.k === "keep").map((s) => input.slice(s.from, s.to));
  const fromOutside = (source: string) => outside.some((text) => text.includes(source));
  walk(parse(out), (node) => {
    const source = node.position ? out.slice(node.position.start.offset, node.position.end.offset) : "";
    if (node.type === "html" && !STRICT_TABLE.test(node.value!)) {
      for (const tag of node.value!.match(/<[^<>]*>?/g) ?? []) {
        expect(fromOutside(tag), `markup ${JSON.stringify(tag)} not from outside a table in ${JSON.stringify(out.slice(0, 300))}`).toBe(true);
      }
    }
    // A link or image may come only from text outside every table region, or be a GFM autolink literal (http/https/mailto).
    if ((node.type === "link" || node.type === "image" || node.type === "definition") && !fromOutside(source)) {
      expect(node.type, JSON.stringify(node)).toBe("link");
      expect(node.url, JSON.stringify(node)).toMatch(/^(?:https?:\/\/|mailto:)/);
    }
  });
  for (const table of out.match(/<table>[\s\S]*?<\/table>/g) ?? []) if (STRICT_TABLE.test(table)) expect(readTableCells(table), table.slice(0, 200)).not.toBeNull();
}

describe("re-check High: a cell over the text limit is never truncated", () => {
  it("keeps the whole region as escaped source, sentinel included, and records why", async () => {
    const input = `Intro\n\n<table><tr><th>Note</th></tr><tr><td>${"a".repeat(17_000)}END</td></tr></table>\n\nAfter`;
    const { out, stats } = await clean(input);
    expect(stats.rawRegions).toBe(1);
    expect(stats.rawReasons).toEqual({ "cell-text": 1 });
    expect(out).not.toMatch(/(?<!\\)<table/);
    expect(renderedText(out)).toContain(`${"a".repeat(17_000)}END`);
    expect(out.startsWith("Intro\n\n")).toBe(true);
    expect(out.endsWith("\n\nAfter")).toBe(true);
    expectNoRegionMarkup(input, out, readVisionTables(input));
  });

  it("a cell exactly at the limit is still rebuilt", async () => {
    const { out, stats } = await clean(`<table><tr><td>${"b".repeat(VISION_TABLE_MAX_TEXT_CHARS)}</td></tr></table>`);
    expect(stats.rawRegions).toBe(0);
    expect(out).toContain(`<td>${"b".repeat(VISION_TABLE_MAX_TEXT_CHARS)}</td>`);
  });

  it("row, cell and nesting caps keep the region as source instead of moving or cutting text", async () => {
    const rows = await clean(`<table>${Array.from({ length: 2_001 }, (_, i) => `<tr><td>r${i}x</td></tr>`).join("")}</table>`);
    expect(rows.stats.rawReasons).toEqual({ rows: 1 });
    for (const i of [0, 1_000, 2_000]) expect(renderedText(rows.out)).toContain(`r${i}x`);
    const deep = await clean(`${"<table><tr><td>".repeat(20)}deepest${"</td></tr></table>".repeat(20)}\n\nTail text`);
    expect(deep.stats.rawReasons).toEqual({ nesting: 1 });
    expect(renderedText(deep.out)).toContain("deepest");
    expect(deep.out.endsWith("Tail text")).toBe(true);
  }, 60_000);
});

describe("re-check High: the text of every element is kept, as inert text", () => {
  it.each([
    ["script", "<table><tr><td>Before<script>KEEP</script>After</td></tr></table>", "BeforeKEEPAfter"],
    ["style", "<table><tr><td>a<style>KEEP{}</style>b</td></tr></table>", "aKEEP{}b"],
    ["template", "<table><tr><td>a<template>KEEP</template>b</td></tr></table>", "aKEEPb"],
    ["textarea", "<table><tr><td>a<textarea>KEEP &amp; more</textarea>b</td></tr></table>", "aKEEP & moreb"],
    ["title", "<table><tr><td>a<title>KEEP</title>b</td></tr></table>", "aKEEPb"],
    ["iframe", "<table><tr><td>a<iframe>KEEP</iframe>b</td></tr></table>", "aKEEPb"],
    ["noscript", "<table><tr><td>a<noscript>KEEP</noscript>b</td></tr></table>", "aKEEPb"],
    ["xmp", "<table><tr><td>a<xmp>KEEP <b>x</b></xmp>b</td></tr></table>", "aKEEP <b>x</b>b"],
    ["select", "<table><tr><td>a<select><option>KEEP</option></select>b</td></tr></table>", "aKEEPb"],
    ["svg", "<table><tr><td>a<svg><text>KEEP</text><script>alert(1)</script></svg>b</td></tr></table>", "aKEEPalert(1)b"],
    ["comment", "<table><tr><td>a<!-- KEEP -->b</td></tr></table>", "a KEEP b"],
    ["img alt", '<table><tr><td>a<img src="x" alt="KEEP" onerror="alert(1)">b</td></tr></table>', "a KEEP b"],
    ["embed (void)", '<table><tr><td>Before<embed src="x">After</td></tr></table>', "BeforeAfter"],
  ])("%s", async (_name, input, text) => {
    const { out, stats } = await clean(input);
    expect(stats.rawRegions).toBe(0);
    expect(renderedText(out).replace(/\s+/g, " ")).toContain(text);
    expectNoRegionMarkup(input, out, readVisionTables(input));
  });
});

describe("re-check Medium: GFM fallback cells render as their own text", () => {
  const hostile = [
    "[label](https://example.com)", "**bold** _em_ ~~gone~~", "`code`", "<b>tag</b>", "<https://example.com/auto>",
    "![img](https://example.com/x.png)", "# heading", "> quote", "- item", "1. first", "a | pipe", "back\\slash",
    "&amp; &copy; entity", "$x^2$ math", "[ref]: https://example.com", "javascript:alert(1)", "<script>alert(1)</script>",
    "--- rule", "=== setext", "*", "+ plus",
  ];
  it("escapes every Markdown construct in an oversized table's cells", async () => {
    const filler = "x".repeat(400);
    const rows = Array.from({ length: 200 }, (_, i) => `<tr><td>${hostile[i % hostile.length]!.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</td><td>${filler}${i}</td></tr>`);
    const input = `<table><thead><tr><th>Cell</th><th>Pad</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
    const { out, stats } = await clean(input);
    expect(stats.gfm).toBe(1);
    const tree = parse(out);
    const kinds = new Set<string>();
    walk(tree, (node) => kinds.add(node.type));
    for (const kind of ["image", "emphasis", "strong", "delete", "inlineCode", "html", "heading", "list", "blockquote", "definition", "thematicBreak"]) expect(kinds.has(kind), kind).toBe(false);
    const table = tree.children!.find((node) => node.type === "table")!;
    expect(table.children).toHaveLength(201);
    const cellText = (cell: MdNode) => { const parts: string[] = []; walk(cell, (n) => { if (typeof n.value === "string") parts.push(n.value); }); return parts.join(""); };
    table.children!.slice(1).forEach((row, i) => {
      expect(cellText(row.children![0]!)).toBe(hostile[i % hostile.length]);
      expect(cellText(row.children![1]!)).toBe(`${filler}${i}`);
    });
    // Autolink literals are the one GFM construct applied after escapes: only http(s) and mailto, never javascript:.
    walk(tree, (node) => { if (node.type === "link") expect(node.url).toMatch(/^(?:https?:\/\/|mailto:)/); });
  });

  it("escapeMarkdownText round-trips through the parser as plain text", () => {
    for (const text of hostile) {
      const parts: string[] = [];
      walk(parse(escapeMarkdownText(text)), (node) => { if (typeof node.value === "string") parts.push(node.value); });
      expect(parts.join("")).toBe(text);
    }
  });
});

describe("original council reproducers (correctness reproduce.mjs, adversarial probes)", () => {
  it.each([
    ["voidElement", '<table><tr><td>Before<embed src="x">After</td></tr></table> Ending', ["BeforeAfter", "Ending"]],
    ["inlineCode", "Use `<table>` for markup. Keep these words.", null],
    ["gfm", "| Tag | Description |\n| --- | --- |\n| `<table>` | Keep words |\n\nFollowing prose", null],
    ["unicode", "İ<table><tr><td>Apple</td></tr></table> after", ["İ", "Apple", "after"]],
    ["entities", "<table><tr><td>&eacute; &alpha; &ndash; &#x1f600; &AMP; &Amp;</td></tr></table>", ["é α – 😀 & &Amp;"]],
    ["inlineText", "<table><tr><td>Con<b>tract</b></td></tr></table>", ["Contract"]],
    ["overlap", '<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td></tr></table>', ["A", "B", "C"]],
    ["wide", `<table><tr>${'<td colspan="100">x</td>'.repeat(105)}</tr></table>`, ["x"]],
  ])("correctness %s", async (_name, input, texts) => {
    const { out } = await clean(input);
    // Code and GFM rows keep their shape; only their table tags are escaped (council round 4 M1).
    if (texts === null) expect(out).toBe(input.replace(/<(\/?table[\s/>])/g, "&lt;$1"));
    else for (const text of texts) expect(renderedText(out)).toContain(text);
    expectNoRegionMarkup(input, out, readVisionTables(input));
  });

  it("correctness overlap and wide: geometry the strict downstream parser accepts", async () => {
    const overlap = (await clean('<table><tr><td>A</td><td rowspan="2">B</td></tr><tr><td colspan="2">C</td></tr></table>')).out;
    expect(readTableCells(overlap)).not.toBeNull();
    const wide = (await clean(`<table><tr>${'<td colspan="100">x</td>'.repeat(105)}</tr></table>`)).out;
    expect(wide.split(" \\| ")).toHaveLength(105);
  });

  /** Words that are not text in the input (attribute values, tag names, a fence's info string), per probe. */
  const notText: Record<string, string[]> = { "quoted gt": ["a", "b", "img", "src", "x", "onerror", "alert", "1"], "table no gt": ["table", "tr"], fence: ["html"] };
  const adversarial: Array<[string, string]> = [
    ["attr injection", `<table><tr><td onclick="x" colspan="2 onmouseover=alert(1)">a</td></tr></table>`],
    ["quoted gt", `<table><tr><td title="a>b<img src=x onerror=alert(1)>">c</td></tr></table>`],
    ["entity script", `<table><tr><td>&lt;script&gt;alert(1)&lt;/script&gt;</td></tr></table>`],
    ["double entity", `<table><tr><td>&amp;lt;img src=x onerror=alert(1)&amp;gt;</td></tr></table>`],
    ["numeric entity <", `<table><tr><td>&#60;img src=x onerror=alert(1)&#x3e;</td></tr></table>`],
    ["svg in cell", `<table><tr><td><svg><script>alert(1)</script></svg><math><mi xlink:href="javascript:alert(1)">x</mi></math></td></tr></table>`],
    ["cdata", `<table><tr><td><![CDATA[<img src=x onerror=alert(1)>]]></td></tr></table>`],
    ["comment trick", `<table><tr><td><!--><img src=x onerror=alert(1)>--></td></tr></table>`],
    ["unclosed script", `<table><tr><td>a<script>alert(1)</td></tr></table> after <b>bold</b>`],
    ["raw html outside", `<img src=x onerror=alert(1)>\n\n<table><tr><td>a</td></tr></table>\n\n<a href="javascript:alert(1)">x</a>`],
    ["case/whitespace", `<TaBlE\n><Tr\t><Td  ROWSPAN = '3' colspan=0x5>a</tD></tR></TABLE>`],
    ["tablex", `<tablex><tr><td>a</td></tr></tablex>`],
    ["table no gt", `<table <tr><td>a`],
    ["null in name", `<table\u0000><tr><td>a</td></tr></table>`],
    ["pipe/markdown in cell", `<table><tr><td>[x](javascript:alert(1)) | y |\n\n# h</td></tr></table>`],
    ["blank line break-out", `<table><tr><td>a\n\n<img src=x onerror=alert(1)></td></tr></table>`],
    ["C1 control", `<table><tr><td>a&#x85;b&#x9f;c\u0001d&#xFFFE;</td></tr></table>`],
    ["close-only", `</table><td onclick=x>`],
    ["caption text", `<table><caption><img src=x onerror=1>cap</caption><tr><td>a</td></tr></table>`],
    ["fence", "```html\n<table><tr><td>a</td></tr></table>\n```"],
    ["nested", `<table><tr><td>a<table><tr><td>b</td></tr></table>c</td><td>d</td></tr></table>`],
    ["rowspan overflow", `<table><tr><td rowspan=100 colspan=100>a</td><td colspan=100>b</td></tr><tr><td>c</td></tr></table>`],
    ["plaintext tag", `<table><tr><td><plaintext>a</td></tr></table><img src=x onerror=1>`],
    ["style drop", `<table><tr><td><style>td{}</style>a</td></tr></table>`],
    ["xmp", `<table><tr><td>a<xmp></td></tr></table><img src=x onerror=1></xmp>b`],
    ["textarea w/o close", `<table><tr><td>a<textarea>b</td></tr></table>`],
    ["entity bypass of escapeStray", `&lt;table&gt;<table><tr><td>x</td></tr></table>`],
    ["stray after", `<table><tr><td>a</td></tr></table><td>z</td></tr></table>`],
    ["katex in cell", `<table><tr><td>$\\href{javascript:alert(1)}{x}$</td></tr></table>`],
    ["unclosed (probe-unclosed 1)", "<table><tr><td>a</td></tr>\n\n## Results\n\n- Revenue rose 12%\n- Expansion to London\n\n```\ncode\n```\n\n$$x^2$$"],
    ["unbalanced (probe-unclosed 2)", "<table><tr><td>a <table> b</td></tr></table>\n\n## Next section\n\nParagraph one."],
    ["app c1", "<table><tr><td>a&#x85;b</td></tr></table>"],
    ["app ctrl", "<table><tr><td>a\u0001b</td></tr></table>"],
    ["app nonchar", "<table><tr><td>a&#xFFFE;b</td></tr></table>"],
    ["app nul", "<table><tr><td>a\u0000b</td></tr></table>"],
    ["app rows300", "<table>" + "<tr><td>1</td><td>2</td></tr>".repeat(300) + "</table>"],
    ["app overlap", "<table><tr><td rowspan=3>a</td><td>b</td></tr><tr><td colspan=100>c</td></tr><tr><td>d</td></tr></table>"],
  ];
  it.each(adversarial)("adversarial %s: no markup from a table region, no text lost", async (name, input) => {
    const { out } = await clean(input);
    const segments = readVisionTables(input);
    expectNoRegionMarkup(input, out, segments);
    // Every word-like run of the input's text survives (tags and attribute values are not text).
    const words = (decodeEntitiesForTest(input.replace(/<!--|-->|<!\[CDATA\[|\]\]>/g, " ").replace(/<\/?[a-zA-Z][^<>]*>/g, " ")).match(/[\p{L}\p{N}]+/gu) ?? []);
    const rendered = renderedText(out);
    for (const word of words.filter((w) => !(notText[name] ?? []).includes(w))) expect(rendered, `${word} in ${JSON.stringify(out.slice(0, 200))}`).toContain(word);
    for (const table of out.match(/<table>[\s\S]*?<\/table>/g) ?? []) {
      expect(table.length).toBeLessThanOrEqual(RENDER_MAX_CHARS);
      expect(table).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f￾￿]/);
    }
  });

  it("unbalanced nested table: the prose after its close stays Markdown, even without a blank line", async () => {
    const { out } = await clean("<table><tr><td>a <table> b</td></tr></table>\n## Next section\n\nParagraph one.");
    expect(out).toMatch(/<\/table>\n+## Next section\n\nParagraph one\.$/);
    expect(parse(out).children!.some((node) => node.type === "heading")).toBe(true);
  });

  it("raw HTML outside any table passes through unchanged (I1: consumers keep their own allow-list)", async () => {
    const input = `<img src=x onerror=alert(1)>\n\nText <sup>2</sup> and <math><mi>x</mi></math>.`;
    expect((await clean(input)).out).toBe(input);
    const withTable = `<sup>1</sup>\n\n<table><tr><td>a</td></tr></table>\n\n<sub>2</sub>`;
    expect((await clean(withTable)).out).toBe("<sup>1</sup>\n\n<table>\n<tbody>\n<tr><td>a</td></tr>\n</tbody>\n</table>\n\n<sub>2</sub>");
  });
});

describe("adversarial probe-dos shapes stay bounded with the no-loss rules", () => {
  it("every 1 MiB hostile page finishes in bounded time", async () => {
    const n = VISION_TABLE_MAX_PAGE_CHARS - 64;
    const fill = (unit: string, prefix = "", suffix = "") => prefix + unit.repeat(Math.floor((n - prefix.length - suffix.length) / unit.length)) + suffix;
    const shapes = [
      fill("<table "), fill("<table>"), fill("<td>x", "<table><tr>"), fill("<tr><td>x", "<table>"), fill("<tablex ", "<table><td>a</table>"),
      fill("<a", "<table>"), fill("<script>", "<table><td>"), fill("<script></script>", "<table><td>"), fill("<title></titl", "<table><td>"),
      fill("<!-", "<table><td><!--"), fill("<!x>", "<table><td>"), fill("&#x41;", "<table><td>"), fill('<td rowspan=100 colspan=100>x', "<table><tr>"),
      "<table><td " + "rowspan=1 ".repeat(n / 10), fill(" \n\t", "<table><td>"), fill("<table><td>a</table>\n"), fill("<table></table>"),
      // New paths: raw regions (a long cell in every table), nesting past the cap, and closes that end their line.
      fill(`<table><tr><td>${"z".repeat(VISION_TABLE_MAX_TEXT_CHARS + 1)}</td></tr></table>\n`), fill("<table><tr><td>", "", "x"),
      fill("</table>\nprose ", "<table><tr><td>".repeat(3)), fill("<table><tr><td>x</td></tr></table>\n\n"),
    ];
    for (const text of shapes) {
      const start = performance.now();
      const { texts } = await sanitizeVisionPageTables([text], null, { vmOnly: false });
      // Alone, each shape takes at most ~1.4 s (30k small tables); the bound leaves room for a loaded CI host.
      expect(performance.now() - start, text.slice(0, 40)).toBeLessThan(15_000);
      // Text-free markup may render to nothing; any text run must survive.
      for (const word of new Set(text.replace(/<[^<>]*>/g, " ").match(/[a-z]{2,}/g) ?? [])) if (!/^(?:table|tablex|tr|td|script|title|titl|rowspan|colspan|x)$/.test(word)) expect(texts[0], word).toContain(word);
    }
  }, 400_000);
});

/** Named/numeric entities used by the reproducers, decoded for the word check only. */
function decodeEntitiesForTest(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', eacute: "é", alpha: "α", ndash: "–" };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/g, (m, name: string) => named[name] ?? m);
}

/** Deterministic PRNG (mulberry32) so a failure reproduces from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe("property: text preservation and no markup from table regions, over random hostile pages", () => {
  const WRAPPERS = [
    (s: string) => s,
    (s: string) => `<b>${s}</b>`,
    (s: string) => `<script>${s}</script>`,
    (s: string) => `<style>${s}</style>`,
    (s: string) => `<template>${s}</template>`,
    (s: string) => `<textarea>${s}</textarea>`,
    (s: string) => `<title>${s}</title>`,
    (s: string) => `<noscript>${s}</noscript>`,
    (s: string) => `<iframe>${s}</iframe>`,
    (s: string) => `<xmp>${s}</xmp>`,
    (s: string) => `<!-- ${s} -->`,
    (s: string) => `<svg><desc>${s}</desc></svg>`,
    (s: string) => `<math><mi>${s}</mi></math>`,
    (s: string) => `<select><option>${s}</option></select>`,
    (s: string) => `<a href="javascript:alert(1)" onclick="x">${s}</a>`,
    (s: string) => `<img src=x onerror=alert(1) alt="${s}">`,
    (s: string) => `<embed src=x>${s}`,
    (s: string) => `${s}<br>`,
    (s: string) => `<p>${s}`,
    (s: string) => `<script>${s}`, // unclosed raw text: runs to the region's end
    (s: string) => `[${s}](javascript:alert(1)) **${s}x** \`${s}y\``,
    (s: string) => `&lt;img onerror=1&gt; ${s} &amp;`,
    (s: string) => `\u0001 ${s} \u0085`,
  ];
  const OUTSIDE = [
    (s: string) => `## ${s} heading`,
    (s: string) => `- ${s} item\n- second`,
    (s: string) => `Paragraph ${s} text.`,
    (s: string) => `| A | B |\n| --- | --- |\n| ${s} | \`<td>\` |`,
    (s: string) => `Use \`<table>\` with ${s}.`,
    (s: string) => `\`\`\`\n<table><tr><td>${s}</td></tr></table>\n\`\`\``,
    (s: string) => `$$x_${s.length}$$ ${s}`,
  ];

  function page(random: () => number) {
    const words: string[] = [];
    const word = () => { const w = `zq${words.length}qz`; words.push(w); return w; };
    const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!;
    const cell = () => {
      const tag = random() < 0.2 ? "th" : "td";
      const span = random() < 0.2 ? ` rowspan="${1 + Math.floor(random() * 4)}"` : random() < 0.2 ? ` colspan="${pick(["2", "0", "101", "x", "3 onclick=1"])}"` : "";
      const big = random() < 0.03 ? "y".repeat(VISION_TABLE_MAX_TEXT_CHARS + 10) + " " : "";
      const body = Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(WRAPPERS)(` ${word()} `)).join(" ");
      const close = random() < 0.85 ? `</${tag}>` : "";
      return `<${tag}${span}>${big}${body}${close}`;
    };
    const table = (depth: number): string => {
      const rows = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
        const cells = Array.from({ length: 1 + Math.floor(random() * 4) }, () => (depth < 2 && random() < 0.1 ? `<td>${table(depth + 1)}</td>` : cell())).join("");
        return `${random() < 0.9 ? "<tr>" : ""}${cells}${random() < 0.85 ? "</tr>" : ""}`;
      });
      const caption = random() < 0.2 ? `<caption>${word()}</caption>` : "";
      const foster = random() < 0.15 ? ` ${word()} ` : "";
      const head = random() < 0.3 ? `<thead>${rows.shift() ?? ""}</thead>` : "";
      const body = rows.join(random() < 0.2 ? "\n" : "");
      const close = random() < 0.85 ? "</table>" : random() < 0.5 ? "" : "<table>"; // unclosed or unbalanced
      return `<table${random() < 0.3 ? ' onload="x" style="y"' : ""}>${caption}${foster}${head}<tbody>${body}</tbody>${close}`;
    };
    const blocks = Array.from({ length: 1 + Math.floor(random() * 5) }, () => (random() < 0.55 ? table(0) : pick(OUTSIDE)(word())));
    const text = blocks.join(pick(["\n\n", "\n", " "]));
    return { text, words };
  }

  it("holds for 600 seeded random pages", async () => {
    for (let seed = 1; seed <= 600; seed++) {
      const { text, words } = page(rng(seed));
      const { out } = await clean(text);
      const rendered = renderedText(out);
      for (const word of words) expect(rendered.includes(word), `seed ${seed}: ${word} lost\nin: ${JSON.stringify(text.slice(0, 400))}\nout: ${JSON.stringify(out.slice(0, 400))}`).toBe(true);
      expectNoRegionMarkup(text, out, readVisionTables(text));
    }
  }, 120_000);

  it("keeps every character run when the guest result is refused (fail-closed escape path)", async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const { text, words } = page(rng(10_000 + seed));
      const { texts } = await sanitizeVisionPageTables([text], { run: async () => { throw new Error("vm down"); } }, { vmOnly: true });
      const rendered = renderedText(texts[0]!);
      // The escape path only rewrites table-family `<`; every other character, sentinel words included, is kept.
      for (const word of words) expect(texts[0]!.includes(word), `seed ${seed}: ${word}`).toBe(true);
      expect(rendered.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Council round 4 M1: the reviewer's seven shapes where a per-page "Markdown code or pipe row" reading disagreed with
 * CommonMark, so the model's own `<table style>` / `<td on*>` reached stored Markdown. No table-family tag written by the
 * model may stay raw anywhere: in the stored text, and in the CommonMark/GFM tree (html nodes) a renderer would emit.
 */
describe("council round 4 M1: model table tags never survive raw, in code or not", () => {
  const T = `<table style="display:none"><tr><td onmouseover="alert(1)">HIDDEN</td></tr></table>`;
  const shapes: Array<[string, string]> = [
    ["backticks inside an HTML block", `<div>\`${T}\`</div>\n\nAfter`],
    ["fence inside an HTML block", `<div>\n\`\`\`\n${T}\n\`\`\`\n</div>\n\nAfter`],
    ["escaped backtick", `Text \\\`${T}\` tail`],
    ["a tag attribute eats the backtick", `<a title="\`">x</a> ${T} \`tail`],
    ["bare CR line ending after a pipe line", `| a |\r${T}\rafter`],
    ["pipe line without a delimiter row", `| ${T} |`],
    ["GFM table cell", `| h |\n| --- |\n| ${T} |`],
    // Pages are joined: an earlier page (or customer text) can leave a fence or <pre> open, so local code is not proof.
    ["fence closed by an earlier page's open fence", `\`\`\`\n${T}\n\`\`\``],
    ["fence inside an open <pre> block", `<pre>\n\n\`\`\`\n${T}\n\`\`\`\n</pre>`],
  ];
  /** A table-family tag a renderer would emit from a raw html node: only the rebuilt allow-list form may appear. */
  const liveModelTags = (markdownText: string) => {
    const found: string[] = [];
    walk(parse(markdownText), (node) => {
      if (node.type !== "html") return;
      if (STRICT_TABLE.test(node.value!)) return;
      for (const m of node.value!.matchAll(/<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)(?=[\s/>])[^>]*>?/gi)) found.push(m[0]);
    });
    return found;
  };
  for (const [name, input] of shapes) {
    it(`${name}: no raw model table tag in stored Markdown`, async () => {
      const { out } = await clean(input);
      expect(out).not.toMatch(/<(?:table|tr|td)[\s>]/i);
      expect(liveModelTags(out)).toEqual([]);
      // Joined after a page that leaves a fence or HTML block open, the stored page is still inert.
      for (const before of ["```\n", "<pre>\n", "<div>\n", "- ```\n"]) expect(liveModelTags(before + out)).toEqual([]);
      expect(out).toContain("HIDDEN");
    });
  }
  it("a forged keep over any of these shapes is refused (escaped page)", async () => {
    const { renderVisionTablePages } = await import("./vision-tables-vm.js");
    for (const [, input] of shapes) {
      const [out] = renderVisionTablePages([input], [[{ k: "keep", from: 0, to: input.length }]]);
      expect(out).not.toMatch(/<(?:table|tr|td)[\s>]/i);
    }
  });
});

/** Any table-family tag start, end of text included (the round 5 delimiter). */
const ANY_TABLE_TAG = /<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)(?=[\s/>]|$)/i;

describe("council round 5 M2: a table tag cut at the end of a page never becomes live when pages are joined", () => {
  const A = `style="display:none" onmouseover="alert(1)"`;
  // The reviewer's reproducer (r5/probe-eofjoin.mts): the next page supplies the attributes, often with no tag at all.
  const documents: Array<[string, string[]]> = [
    ["line <table, next page an HTML block", ["Intro\n<table", `<div ${A}>\nHIDDEN\n</div>`]],
    ["line <table, next page an img", ["Intro\n<table", `<img src=x onerror="alert(1)">`]],
    ["inline <table", ["Intro <table", `<div ${A}>x</div>`]],
    ["page is only <table, next page tagless attribute text", ["<table", `${A}>HIDDEN`]],
    ["uppercase <TABLE", ["x\n<TABLE", `${A}>HIDDEN`]],
    ["<td after an open div", ["<div>\n<td", `<div ${A}>x</div>`]],
    ["closing </table", ["x\n</table", `${A}>`]],
  ];
  for (const [name, pages] of documents) {
    it(`${name}: stored (\\f) and export (blank line) joins hold no table tag`, async () => {
      const { texts, stats } = await sanitizeVisionPageTables(pages, null, { vmOnly: false });
      expect(stats.pages).toBeGreaterThan(0);
      for (const text of texts) expect(text).not.toMatch(ANY_TABLE_TAG);
      for (const joined of [texts.join("\f"), texts.join("\n\n")]) {
        expect(joined).not.toMatch(ANY_TABLE_TAG);
        walk(parse(joined), (node) => { if (node.type === "html") expect(node.value).not.toMatch(ANY_TABLE_TAG); });
      }
    });
  }
  it("a forged whole-page keep over a trailing tag is refused (escaped page)", async () => {
    const { renderVisionTablePages } = await import("./vision-tables-vm.js");
    const pages = documents.map(([, p]) => p[0]!);
    const out = renderVisionTablePages(pages, pages.map((p) => [{ k: "keep", from: 0, to: p.length }]));
    for (const text of out) expect(text).not.toMatch(ANY_TABLE_TAG);
  });
  it("text ending in a non-table tag name or a longer name is unchanged", async () => {
    const { texts, stats } = await sanitizeVisionPageTables(["a <tablet", "b <trx", "c <div"], null, { vmOnly: false });
    expect(texts).toEqual(["a <tablet", "b <trx", "c <div"]);
    expect(stats.pages).toBe(0);
  });
});

describe("council round 5 M3: a reserved marker can never re-join a split table tag", () => {
  const A = `style="display:none" onmouseover="alert(1)"`;
  const MARK = "<!-- docslurp:visual chart 0123456789abcdef -->";
  const shapes: Array<[string, string]> = [
    ["marker inside <table", `<ta${MARK}ble ${A}><tr><td>HIDDEN</td></tr></table>`],
    ["marker inside <td", `<table><tr><t${MARK}d ${A}>HIDDEN</td></tr></table>`],
    ["close marker inside <table", `<ta${MARK.replace("<!-- ", "<!-- /")}ble ${A}>HIDDEN`],
    ["marker on its own line before a split tag", `${MARK}\n<ta${MARK}ble ${A}>HIDDEN`],
  ];
  const projections = async (text: string) => {
    const { chunkText } = await import("./chunking.js");
    const { buildCanonicalDocumentFromMarkdown, buildCanonicalChunksFromDocument, canonicalDocumentToText } = await import("../lib/canonical-document.js");
    const canonical = buildCanonicalDocumentFromMarkdown({ documentId: "d", text, pageCount: 1, extractor: "test" });
    return [
      ...chunkText(text, 2000),
      canonicalDocumentToText(canonical),
      ...buildCanonicalChunksFromDocument(canonical, "f.pdf").map((c) => c.text),
    ];
  };
  for (const [name, input] of shapes) {
    it(`${name}: stored page, chunks and canonical text hold no table tag`, async () => {
      const { out } = await clean(input);
      expect(out).not.toMatch(ANY_TABLE_TAG);
      expect(out).not.toContain("<!-- docslurp:");
      expect(out).not.toContain("<!-- /docslurp:");
      for (const text of await projections(out)) expect(text, text.slice(0, 200)).not.toMatch(ANY_TABLE_TAG);
    });
    it(`${name}: projections alone never join a tag (a marker inside a line is not a marker)`, async () => {
      // The split tag stays split: no tag carrying the hostile attributes forms.
      for (const text of await projections(input)) expect(text, text.slice(0, 200)).not.toMatch(/<t(?:able|d)\s+style/i);
    });
  }
  it("markers on their own lines are still stripped from projections", async () => {
    const text = `Before.\n\n${MARK}\n\nRevenue grows.\n\n${MARK.replace("<!-- ", "<!-- /")}\n\nAfter.`;
    for (const projected of await projections(text)) expect(projected).not.toContain("docslurp:visual");
  });
});

/** Council round 4 L6: the guest's code scan is linear (was ~n^1.5 on distinct backtick run lengths); the host has none. */
describe("council round 4 L6: bounded work on hostile backtick runs, 1–4 MiB", () => {
  it("guest read and host render stay linear; pages over the parse limit are only escaped", async () => {
    const { renderVisionTablePages } = await import("./vision-tables-vm.js");
    const runs = (n: number, ascending: boolean) => {
      const parts: string[] = [];
      let length = 0;
      for (let k = 2; length < n; k++) { parts.push("`".repeat(k) + "x"); length += k + 1; }
      if (!ascending) parts.reverse();
      return ("Use `<td>` here.\n" + parts.join("")).slice(0, n);
    };
    for (const mib of [1, 2, 4]) {
      for (const ascending of [true, false]) {
        const text = runs(mib * 1024 * 1024, ascending);
        let started = performance.now();
        const result = readVisionTables(text);
        const guestMs = performance.now() - started;
        started = performance.now();
        const [out] = renderVisionTablePages([text], [result === false ? [{ k: "keep", from: 0, to: text.length }] : result]);
        const hostMs = performance.now() - started;
        expect(guestMs, `guest ${mib} MiB`).toBeLessThan(1_500);
        expect(hostMs, `host ${mib} MiB`).toBeLessThan(1_500);
        expect(out).not.toMatch(/<td[\s>]/);
        if (text.length > VISION_TABLE_MAX_PAGE_CHARS) {
          expect(result).toBe(false);
          const sanitizeStart = performance.now();
          const { out: escaped } = await clean(text);
          expect(performance.now() - sanitizeStart).toBeLessThan(1_500);
          expect(escaped).toContain("`&lt;td>`");
        }
      }
    }
  }, 60_000);
});
