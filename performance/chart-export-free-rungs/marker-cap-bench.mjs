#!/usr/bin/env node
// Worst-case inputs for the SVG density gate, run through the guest bundle in a fresh process: wall time, peak RSS and
// what happened to each SVG (exported exactly, approximated, skipped by reason, deferred).
//
//   node marker-cap-bench.mjs <worker/dist/chart-export/guest.bundle.mjs> <mode>
//
// doc100:  the council's 100-SVG HTML page (each SVG: 2,500 packed vertices, 19,900 markers from 199 <use>).
// batch40: the council's 40-copy SVG batch, run like scripts/chart-export-extract.mjs runs a batch.
// held17:  the council's round-4 H1 page: 17 SVGs, each ~1,010 markers near 1,000 packed vertices plus 3,900 <use> of
//          a 100-rect group (~390k rects unexpanded), 3.6 MB.
// column:  the council's round-4 M2 SVG: one bar column of 3,900 rects (39 <use> of a 100-rect group).
// atcap200: 200 SVGs in one HTML input, each just under the primitive gate (39 <use> of a 100-rect group spread
//          over 60 columns, ~3,980 primitives), to bound a document of SVGs that all pass the gate.
// legit:   the same page shape with 100 ordinary bar charts, for comparison.
// Council round 5 (each must now finish fast with every SVG accounted for):
// hidden1 / hiddenEpub20: 640 KiB SVGs whose <use> target holds ~34k hidden children, referenced 999 times (one SVG;
//          an EPUB of 20); descHtml7: an HTML of 7 such SVGs with <desc/> children; nested200: an HTML of 200 3 KB
//          SVGs with 1 → 30 → 30 nested <use> over 450 groups; mermaid / mermaidEpub200: the hostile diagram shape.
// textEpub400 / rectEpub400: the gate-passing worst case: an EPUB of 200 parts × 2 inline SVGs, each just under the
//          element gate with numeric tick texts (council r5 L4) or rects.
// Council round 6 (per-frame cost): rgbFill80k / rgbFill640k (one rect with a quadratic rgb( fill), rgbStyle20k /
//          rgbStyleEpub8 (a 4,000-space rgb( style re-walked by 999 <use>), xsplit / xsplitEpub9 (a 640 KiB x attribute
//          re-walked by 999 <use>), text999, points999, width999, deep1 / deepEpub300 (250 nested long-class groups
//          over 2,700 rects; the EPUB's have no axis, so all 300 are analysed).
// Council round 7 (raw-text scans): cmtScript64k / cmtScript640k (an SVG whose comment holds unclosed `<script `
//          starts), epubCmt3 (bar chart, 3 such 640 KiB SVGs, bar chart), htmlSvgOpen1m (`<svg ` × 200k), htmlScript1m
//          (`<script>` × 125k), html2m (a JSON script then `<svg ` × 400k), epubScript200 (200 parts of ~300 KB unclosed
//          `<script>`), emptyCmt / emptyCmtEpub90 (a group of ~93k empty comments re-walked by 999 <use>).
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { pathToFileURL } from "node:url";

const [bundle, mode = "doc100"] = process.argv.slice(2);
const { extractDeterministicVisuals, setGuestDeadline } = await import(pathToFileURL(bundle).href);
// As the guest does for a single-input run: stop and return what it has 45 s in (the host kills at 60 s).
setGuestDeadline(Date.now() + 45_000);
const ticks = [[0, 90], [10, 50], [20, 10]].map(([v, y]) => `<text x="2" y="${y}">${v}</text>`).join("") + '<text x="10" y="98">A</text><text x="50" y="98">B</text><text x="90" y="98">C</text>';
function packedSvg() {
  const pts = ["10,90"];
  for (let i = 0; i < 2498; i++) pts.push(`${(30 + (i % 290) / 100).toFixed(2)},${(30 + (i % 97) / 34).toFixed(2)}`);
  pts.push("90,10");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><polyline points="${pts.join(" ")}" stroke="#f00" fill="none"/><defs><g id="m">${'<circle cx="34.6" cy="34.6" r="1" fill="#00f"/>'.repeat(100)}</g></defs>${'<use href="#m"/>'.repeat(199)}${ticks}</svg>`;
}
function heldSvg(i) {
  const t = [0, 25, 50, 75, 100].map((v, k) => `<text x="20" y="${400 - k * 80}">${v}</text>`).join("");
  const markers = Array.from({ length: 1010 }, (_, k) => `<circle cx="${200 + (k % 3) * 0.3 + 2}" cy="202" r="1" fill="#f00"/>`).join("");
  const pts = Array.from({ length: 1000 }, (_, k) => `${200 + (k % 2) * 0.1},${200 + (k % 2) * 0.1}`).join(" ");
  const g = `<defs><g id="g${i}">${Array.from({ length: 100 }, (_, k) => `<rect x="${100 + k * 2}" y="${150 + (k % 50)}" width="1" height="1" fill="#0a0"/>`).join("")}</g></defs>`;
  const uses = Array.from({ length: 3900 }, (_, u) => `<use href="#g${i}" x="${(u % 60) * 210}" y="${Math.floor(u / 60) * 0.001}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">${g}${t}${markers}<polyline stroke="#00f" fill="none" points="${pts} 400,50"/>${uses}</svg>`;
}
function columnSvg() {
  const t = [0, 25, 50, 75, 100].map((v, k) => `<text x="20" y="${400 - k * 80}">${v}</text>`).join("");
  const g = `<defs><g id="g">${Array.from({ length: 100 }, (_, k) => `<rect x="100" y="${100 + k * 2}" width="30" height="1" fill="#0a0"/>`).join("")}</g></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">${g}${t}${Array.from({ length: 39 }, (_, u) => `<use href="#g" y="${u * 0.001}"/>`).join("")}<text x="115" y="420">A</text></svg>`;
}
function atCapSvg(i) {
  const t = [0, 25, 50, 75, 100].map((v, k) => `<text x="20" y="${400 - k * 80}">${v}</text>`).join("");
  const g = `<defs><g id="c${i}">${Array.from({ length: 100 }, (_, k) => `<rect x="${40 + (k % 60) * 7}" y="${100 + Math.floor(k / 60) * 3 + (k % 7)}" width="5" height="${2 + (k % 5)}" fill="#0a0"/>`).join("")}</g></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500">${g}${t}${Array.from({ length: 39 }, (_, u) => `<use href="#c${i}" y="${u * 7}"/>`).join("")}<text x="115" y="420">A</text></svg>`;
}
const SVG = (body, attrs = 'width="500" height="500"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
function bypass(child, i = 0) {
  // Sized to just under the 640 KiB byte gate from the real strings.
  const uses = `<use href="#g${i}"/>`.repeat(999);
  const shell = SVG(`<defs><g id="g${i}"></g></defs>${uses}`);
  const n = Math.floor((640 * 1024 - shell.length) / child.length);
  return SVG(`<defs><g id="g${i}">${child.repeat(n)}</g></defs>${uses}`);
}
const nested = (i) => SVG(`<defs><g id="a${i}_0">${"<g/>".repeat(450)}</g><g id="a${i}_1">${`<use href="#a${i}_0"/>`.repeat(30)}</g><g id="a${i}_2">${`<use href="#a${i}_1"/>`.repeat(30)}</g></defs><use href="#a${i}_2"/>`);
const mermaid = (n, e, p) => SVG(Array.from({ length: n }, (_, k) => `<g class="node" id="flowchart-a${k}-0"/>`).join("") + Array.from({ length: e }, (_, k) => `<path class="flowchart-link" data-id="L${"_b".repeat(p)}_${k}"/>`).join(""), 'id="mermaid-1"');
const textAtCap = () => SVG(Array.from({ length: 1500 }, (_, k) => `<text x="20" y="${4000 - k * 2}">${k}</text>`).join("") + Array.from({ length: 1494 }, (_, k) => `<text x="${40 + k * 2}" y="4020">${k + 100000}</text>`).join("") + '<rect x="100" y="100" width="5" height="5" fill="#f00"/>', 'width="9000" height="4100"');
const rectAtCap = () => SVG([0, 25, 50, 75, 100].map((v, k) => `<text x="20" y="${400 - k * 80}">${v}</text>`).join("") + Array.from({ length: 2990 }, (_, k) => `<rect x="${40 + (k % 400) * 20}" y="${1000 + (k % 13)}" width="9" height="${100 + k % 37}"/>`).join(""), 'width="9000" height="4100"');
// Same element count, labels that are not numbers: no axis, so no visual, so the visual cap never stops the input and all
// 400 SVGs are analysed (council r5 L4's "exports nothing" case).
const textNoAxisAtCap = () => SVG(Array.from({ length: 2994 }, (_, k) => `<text x="${20 + (k % 60) * 140}" y="${20 + Math.floor(k / 60) * 80}">a${k}</text>`).join("") + '<rect x="100" y="100" width="5" height="5" fill="#f00"/>', 'width="9000" height="4100"');
/** A stored (uncompressed) zip, enough for an EPUB the extractor reads. */
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), fname = Buffer.from(name), crc = crc32(data);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(fname.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(fname.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, fname, data); central.push(c, fname); offset += 30 + fname.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}
const epub = (parts) => ({ kind: "epub", bytes: zip({ mimetype: "application/epub+zip", ...parts }) });
const fit = (prefix, unit, suffix) => prefix + unit.repeat(Math.floor((640 * 1024 - 400 - prefix.length - suffix.length) / unit.length)) + suffix;
const reWalk = (target, id) => SVG(`<defs>${target}</defs>${`<use href="#${id}"/>`.repeat(999)}`);
const r6 = {
  rgbFill: (n) => SVG(`<rect width="5" height="5" fill="rgb(1${" ".repeat(n)}x"/>`),
  rgbStyle: () => reWalk(`<g id="g" style="fill:rgb(1${" ".repeat(4000)}x"/>`, "g"),
  xsplit: () => SVG(fit('<defs><text id="t" x="', "0 ", `">a</text></defs>${'<use href="#t"/>'.repeat(999)}`)),
  text: () => SVG(fit('<defs><text id="t" x="1" y="1">', "a", `</text></defs>${'<use href="#t"/>'.repeat(999)}`)),
  points: () => SVG(fit('<defs><polyline id="p" points="', "-.", `"/></defs>${'<use href="#p"/>'.repeat(999)}`)),
  width: () => SVG(fit('<defs><rect id="r" width="', " ", `x"/></defs>${'<use href="#r"/>'.repeat(999)}`)),
  deep: (axis) => { let d = ""; for (let k = 0; k < 250; k++) d += `<g class="${"c".repeat(190)}${k}">`; return SVG((axis ? [0, 25, 50, 75, 100].map((v, k) => `<text x="2" y="${400 - k * 80}">${v}</text>`).join("") : "") + d + Array.from({ length: 2700 }, (_, k) => `<rect x="${40 + (k % 100) * 4}" y="${100 + Math.floor(k / 100)}" width="3" height="${1 + k % 5}" fill="#0a0"/>`).join("") + "</g>".repeat(250)); },
};
const r7 = {
  cmtScript: (n) => SVG(`<!--${"<script ".repeat(n)}--><rect width="1" height="1"/>`),
  emptyCmt: () => SVG(fit('<defs><g id="t">', "<!---->", `</g></defs>${'<use href="#t"/>'.repeat(999)}`)),
  barSvg: () => SVG('<rect x="65" y="170" width="70" height="50" fill="#e45756"/><rect x="165" y="120" width="70" height="100" fill="#e45756"/><line x1="50" y1="220" x2="350" y2="220" stroke="black"/>' + [0, 1, 2, 3, 4].map((v) => `<text x="44" y="${220 - v * 50}" text-anchor="end" font-size="10">${v}</text>`).join("") + '<text x="100" y="234" font-size="10">A</text><text x="200" y="234" font-size="10">B</text>', 'width="400" height="260"'),
};
const bar = (k) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect x="65" y="${170 - k % 50}" width="70" height="${50 + k % 50}" fill="#e45756"/><rect x="165" y="120" width="70" height="100" fill="#e45756"/><line x1="50" y1="220" x2="350" y2="220" stroke="black"/>${[0, 1, 2, 3, 4].map((v) => `<text x="44" y="${220 - v * 50}" text-anchor="end" font-size="10">${v}</text>`).join("")}<text x="100" y="234" text-anchor="middle" font-size="10">A</text><text x="200" y="234" text-anchor="middle" font-size="10">B</text></svg>`;

const inputs = {
  doc100: () => [{ kind: "html", text: `<html><body>${packedSvg().repeat(100)}</body></html>` }],
  batch40: () => Array.from({ length: 40 }, () => ({ kind: "svg", text: packedSvg() })),
  held17: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 17 }, (_, i) => heldSvg(i)).join("\n")}</body></html>` }],
  column: () => [{ kind: "svg", text: columnSvg() }],
  atcap200: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 200 }, (_, i) => atCapSvg(i)).join("")}</body></html>` }],
  hidden1: () => [{ kind: "svg", text: bypass('<g display="none"/>') }],
  hiddenEpub20: () => [epub(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`OEBPS/f${String(i).padStart(3, "0")}.svg`, bypass('<g display="none"/>', i)])))],
  descHtml7: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 7 }, (_, i) => bypass("<desc/>", i)).join("\n")}</body></html>` }],
  nested200: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 200 }, (_, i) => nested(i)).join("\n")}</body></html>` }],
  mermaid: () => [{ kind: "svg", text: mermaid(7600, 80, 1000) }, { kind: "svg", text: mermaid(2900, 80, 1000) }],
  mermaidEpub200: () => [epub(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`OEBPS/m${String(i).padStart(3, "0")}.svg`, mermaid(2900, 80, 1000)])))],
  textEpub400: () => [epub(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`OEBPS/c${String(i).padStart(3, "0")}.xhtml`, `<html><body>${textAtCap()}${textAtCap()}</body></html>`])))],
  textNoAxisEpub400: () => [epub(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`OEBPS/c${String(i).padStart(3, "0")}.xhtml`, `<html><body>${textNoAxisAtCap()}${textNoAxisAtCap()}</body></html>`])))],
  rectEpub400: () => [epub(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`OEBPS/c${String(i).padStart(3, "0")}.xhtml`, `<html><body>${rectAtCap()}${rectAtCap()}</body></html>`])))],
  rgbFill80k: () => [{ kind: "svg", text: r6.rgbFill(80_000) }],
  rgbFill640k: () => [{ kind: "svg", text: r6.rgbFill(640 * 1024 - 200) }],
  rgbStyle20k: () => [{ kind: "svg", text: r6.rgbStyle() }],
  rgbStyleEpub8: () => [epub(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`OEBPS/s${i}.svg`, r6.rgbStyle()])))],
  xsplit: () => [{ kind: "svg", text: r6.xsplit() }],
  xsplitEpub9: () => [epub(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`OEBPS/x${i}.svg`, r6.xsplit()])))],
  text999: () => [{ kind: "svg", text: r6.text() }],
  points999: () => [{ kind: "svg", text: r6.points() }],
  width999: () => [{ kind: "svg", text: r6.width() }],
  deep1: () => [{ kind: "svg", text: r6.deep(true) }],
  deepEpub300: () => [epub(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`OEBPS/d${String(i).padStart(3, "0")}.xhtml`, `<html><body>${r6.deep(false)}${r6.deep(false)}</body></html>`])))],
  cmtScript64k: () => [{ kind: "svg", text: r7.cmtScript(8_000) }],
  cmtScript640k: () => [{ kind: "svg", text: r7.cmtScript(80_000) }],
  epubCmt3: () => [epub({ "OEBPS/a.svg": r7.barSvg(), "OEBPS/b.svg": r7.cmtScript(80_000), "OEBPS/c.svg": r7.cmtScript(80_000), "OEBPS/d.svg": r7.cmtScript(80_000), "OEBPS/e.svg": r7.barSvg() })],
  htmlSvgOpen1m: () => [{ kind: "html", text: "<svg ".repeat(200_000) }],
  htmlScript1m: () => [{ kind: "html", text: "<script>".repeat(125_000) }],
  html2m: () => [{ kind: "html", text: `<script type="application/json">{}</script>${"<svg ".repeat(400_000)}` }],
  epubScript200: () => [epub(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`OEBPS/c${String(i).padStart(3, "0")}.xhtml`, `<html><body>${"<script>".repeat(37_000)}</body></html>`])))],
  emptyCmt: () => [{ kind: "svg", text: r7.emptyCmt() }],
  emptyCmtEpub90: () => [epub(Object.fromEntries([["OEBPS/a000.svg", r7.barSvg()], ...Array.from({ length: 90 }, (_, i) => [`OEBPS/b${String(i).padStart(3, "0")}.svg`, r7.emptyCmt()]), ["OEBPS/z999.svg", r7.barSvg()]]))],
  legit: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 100 }, (_, k) => bar(k)).join("")}</body></html>` }],
}[mode]();
// --write <dir>: write the mode's inputs as guest inputs (<dir>/<mode>[-k]/{input,meta.json}) for guest-repro-run.mjs.
if (process.argv[4] === "--write") {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  inputs.forEach((input, k) => {
    const dir = `${process.argv[5]}/${mode}${inputs.length > 1 ? `-${k}` : ""}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/input`, input.text ?? input.bytes);
    writeFileSync(`${dir}/meta.json`, JSON.stringify({ kind: input.kind }));
  });
  process.exit(0);
}
const bytes = inputs.reduce((n, i) => n + (i.text?.length ?? i.bytes.length), 0);
const t0 = process.hrtime.bigint();
const results = inputs.map((input) => extractDeterministicVisuals(input));
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const visuals = results.flatMap((r) => r.visuals);
const skipped = {};
for (const r of results.flatMap((x) => x.refusals)) skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
const deferredSvgs = results.reduce((n, r) => n + (r.deferred ?? []).reduce((m, d) => m + d.count, 0), 0);
const peakRssMb = Math.round(Number(/VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? 0) / 1024);
console.log(JSON.stringify({ node: process.version, mode, inputMb: +(bytes / 1e6).toFixed(2), ms: Math.round(ms), peakRssMb, exported: visuals.length, approximate: visuals.filter((v) => v.reason === "approximate-marker-dedup").length, skipped, deferred: deferredSvgs }));
