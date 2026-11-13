import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { extractDeterministicVisuals } from "../index.js";
import { CHART_EXTRACT_LIMITS } from "../limits.js";
import { openZipPackage } from "../safe-zip.js";
import { parseXml } from "../xml.js";
import { barPlot, chartXml, docx, matplotlibBar, zip } from "./fixtures.js";

const refusalOf = (r: ReturnType<typeof extractDeterministicVisuals>) => r.refusals.map((x) => x.reason);

describe("hardened XML", () => {
  it("refuses internal DTD subsets (XXE, billion laughs) and stray declarations", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="1">&xxe;</text></svg>`;
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: xxe }))).toEqual(["xml-dtd-internal-subset"]);
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]><svg>&lol2;</svg>`;
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: laughs }))).toEqual(["xml-dtd-internal-subset"]);
    expect(() => parseXml(`<svg><!ENTITY x "y"></svg>`)).toThrow(/dtd-declaration/);
    expect(() => parseXml(`<svg/><!DOCTYPE svg>`)).toThrow(/dtd-declaration/);
  });

  it("leaves unknown entity references literal and never expands them", () => {
    const doc = parseXml(`<a b="&ext; &amp; &#x3C;">&ext;&#0;&#xD800;&lt;</a>`);
    const a = doc.children[0] as { attrs: Record<string, string>; children: Array<{ value: string }> };
    expect(a.attrs.b).toBe("&ext; & <");
    expect(a.children[0]!.value).toBe("&ext;��<");
  });

  it("refuses an XXE payload inside an Office chart part", () => {
    const evil = chartXml({ plots: [barPlot([{ name: "s", cats: ["a"], vals: [1] }])] }).replace("<c:chartSpace", "<!DOCTYPE c [<!ENTITY x SYSTEM \"http://169.254.169.254/\">]><c:chartSpace");
    const r = extractDeterministicVisuals({ kind: "office", bytes: docx([evil]) });
    expect(r.visuals).toEqual([]);
    expect(r.refusals).toEqual([{ locator: "word/charts/chart1.xml", reason: "xml-dtd-internal-subset" }]);
  });

  it("refuses deep nesting, too many elements and oversized input", () => {
    const deep = `<svg xmlns="http://www.w3.org/2000/svg">${"<g>".repeat(5000)}${"</g>".repeat(5000)}</svg>`;
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: deep }))).toEqual(["xml-depth-limit"]);
    const wide = `<svg xmlns="http://www.w3.org/2000/svg">${"<g/>".repeat(CHART_EXTRACT_LIMITS.maxXmlElements + 1)}</svg>`;
    // The SVG density gate's byte cap (640 KiB) refuses it first; the XML parser's own element limit still holds.
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: wide }))).toEqual(["svg-too-large"]);
    expect(() => parseXml(wide)).toThrow(/xml-element-limit/);
    const big = `<svg>${" ".repeat(CHART_EXTRACT_LIMITS.maxTextBytes)}</svg>`;
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: big }))).toEqual(["svg-too-large"]);
    expect(() => parseXml(`<a ${Array.from({ length: 300 }, (_, k) => `a${k}="1"`).join(" ")}/>`)).toThrow(/attribute-limit/);
  });

  it("gives attributes no prototype", () => {
    const doc = parseXml(`<a __proto__="x" constructor="y"/>`);
    const a = doc.children[0] as { attrs: Record<string, string> };
    expect(Object.getPrototypeOf(a.attrs)).toBeNull();
    expect(a.attrs.__proto__).toBe("x");
  });
});

describe("SVG work limits", () => {
  it("refuses a path with too many vertices and documents with too many path commands", () => {
    const huge = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0${" L1 1".repeat(CHART_EXTRACT_LIMITS.maxPathVertices + 10)}"/></svg>`;
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: huge }))).toEqual(["svg-path-vertex-limit"]);
    const one = `<path d="M0 0${" L1 1".repeat(9000)}"/>`;
    // 6 × 9,000 segments (270 KB): under the byte cap, over the 50,000-segment density gate.
    const many = `<svg xmlns="http://www.w3.org/2000/svg">${one.repeat(6)}</svg>`;
    // The density gate (50,000 path segments per SVG) stops this before the document-wide path budget.
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: many }))).toEqual(["svg-too-dense"]);
  });

  it("bounds <use> expansion (self references and fan-out bombs)", () => {
    const self = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g id="a"><use xlink:href="#a"/><use xlink:href="#a"/></g></svg>`;
    const r = extractDeterministicVisuals({ kind: "svg", text: self });
    expect(r.visuals).toEqual([]);
    const fan = `<svg xmlns="http://www.w3.org/2000/svg"><defs><g id="l0"><rect width="1" height="1"/></g>${Array.from({ length: 7 }, (_, k) => `<g id="l${k + 1}">${`<use href="#l${k}"/>`.repeat(10)}</g>`).join("")}</defs><use href="#l7"/></svg>`;
    // The density gate's <use> budget (1,000 per SVG) stops the fan-out bomb at its first expansion past the cap.
    expect(refusalOf(extractDeterministicVisuals({ kind: "svg", text: fan }))).toEqual(["svg-use-bomb"]);
  });

  it("rejects malformed path data and transforms without throwing out of the extractor", () => {
    const bad = `<svg xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L NaN Infinity"/><g transform="evil(1)"><rect width="1" height="1"/></g></svg>`;
    const r = extractDeterministicVisuals({ kind: "svg", text: bad });
    expect(r.visuals).toEqual([]);
    expect(refusalOf(r)).toEqual(["svg-path-bad-number"]);
  });

  it("keeps hostile SVG text as plain labels", () => {
    const svg = matplotlibBar({ categories: ["<script>alert(1)</script>", "javascript:x", "‮evil"], series: [{ name: "s", values: [1, 2, 3], color: "#123456" }] }, { vmax: 4, title: "</svg><img src=x>" });
    const r = extractDeterministicVisuals({ kind: "svg", text: svg });
    const spec = r.visuals[0]!.spec!;
    expect(spec.kind === "chart" && spec.series[0]!.points.map((p) => p.x)).toEqual(["<script>alert(1)</script>", "javascript:x", "evil"]);
    expect(spec.title).toBe("</svg><img src=x>");
  });
});

describe("zip packages", () => {
  it("refuses a high-ratio zip bomb before inflating", () => {
    const bomb = zip({ "[Content_Types].xml": "<Types/>", "word/charts/chart1.xml": new Uint8Array(10 * 1024 * 1024) });
    const r = extractDeterministicVisuals({ kind: "office", bytes: bomb });
    expect(r.visuals).toEqual([]);
    expect(refusalOf(r)).toEqual(["package-archive-expansion-ratio-limit"]);
  });

  it("refuses an entry above the per-entry limit and too many entries", () => {
    const rnd = randomBytes(CHART_EXTRACT_LIMITS.maxZipEntryBytes + 1024);
    expect(refusalOf(extractDeterministicVisuals({ kind: "office", bytes: zip({ "word/media/a.bin": rnd }, 0) }))).toEqual(["package-archive-entry-size-limit"]);
    const files: Record<string, string> = {};
    for (let k = 0; k <= CHART_EXTRACT_LIMITS.maxZipEntries; k++) files[`f${k}.xml`] = "x";
    expect(refusalOf(extractDeterministicVisuals({ kind: "office", bytes: zip(files) }))).toEqual(["package-archive-entry-count-limit"]);
  }, 20_000);

  it("caps inflation at the declared size when headers lie", () => {
    const bytes = Buffer.from(zip({ "word/charts/chart1.xml": "<c:chartSpace>".padEnd(50_000, " ") + "</c:chartSpace>" }));
    // Rewrite the declared uncompressed size (local header +22, central header +24) to 100 bytes.
    const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(100, local + 22);
    bytes.writeUInt32LE(100, central + 24);
    expect(() => openZipPackage(bytes).read("word/charts/chart1.xml")).toThrow(/inflate-failed|archive-/);
    const r = extractDeterministicVisuals({ kind: "office", bytes });
    expect(r.visuals).toEqual([]);
    expect(r.refusals.length).toBeGreaterThan(0);
  });

  it("refuses non-zip bytes and unsafe paths", () => {
    expect(refusalOf(extractDeterministicVisuals({ kind: "office", bytes: Buffer.from("not a zip") }))).toEqual(["package-not-zip"]);
    expect(refusalOf(extractDeterministicVisuals({ kind: "office", bytes: zip({ "../evil.xml": "x" }) }))).toEqual(["package-archive-unsafe-path"]);
  });
});
