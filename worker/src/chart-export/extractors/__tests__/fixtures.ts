/*
 * Synthetic fixtures for the deterministic chart extractors. Everything is generated here from known data so tests have
 * exact ground truth: SVGs mimic each generator's markup conventions (ids, classes, text handling), Office packages are
 * zipped in memory. No third-party documents.
 */
import { strToU8, zipSync } from "fflate";

// ---- Office ---------------------------------------------------------------------------------------------------------

const C_NS = `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface OfficeSeries { name: string; cats?: string[]; vals: Array<number | string | null>; formatCode?: string; catRef?: string; valRef?: string; noCache?: boolean; xNums?: number[]; sizes?: number[] }

function strCache(values: string[]) {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
}
function numCache(values: Array<number | string | null>, formatCode = "General") {
  return `<c:numCache><c:formatCode>${esc(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v === null ? "" : `<c:pt idx="${i}"><c:v>${esc(String(v))}</c:v></c:pt>`)).join("")}</c:numCache>`;
}

export function officeSer(s: OfficeSeries, i: number, xy = false): string {
  const tx = `<c:tx><c:strRef><c:f>Sheet1!$${String.fromCharCode(66 + i)}$1</c:f>${strCache([s.name])}</c:strRef></c:tx>`;
  const cat = xy
    ? `<c:xVal><c:numRef><c:f>Sheet1!$A$2:$A$${(s.xNums?.length ?? 0) + 1}</c:f>${numCache(s.xNums ?? [])}</c:numRef></c:xVal>`
    : s.cats ? `<c:cat><c:strRef><c:f>${s.catRef ?? "Sheet1!$A$2:$A$9"}</c:f>${s.noCache ? "" : strCache(s.cats)}</c:strRef></c:cat>` : "";
  const valTag = xy ? "yVal" : "val";
  const val = `<c:${valTag}><c:numRef><c:f>${s.valRef ?? "Sheet1!$B$2:$B$9"}</c:f>${s.noCache ? "" : numCache(s.vals, s.formatCode)}</c:numRef></c:${valTag}>`;
  const size = s.sizes ? `<c:bubbleSize><c:numRef><c:f>Sheet1!$D$2:$D$9</c:f>${numCache(s.sizes)}</c:numRef></c:bubbleSize>` : "";
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${cat}${val}${size}</c:ser>`;
}

export function chartXml(opts: { title?: string; plots: string[]; axes?: string; extra?: string }): string {
  const title = opts.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(opts.title)}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:autoTitleDeleted val="0"/>` : `<c:autoTitleDeleted val="1"/>`;
  const axes = opts.axes ?? catValAxes("10", "20", "Quarter", "Revenue ($M)");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace ${C_NS}><c:chart>${title}<c:plotArea><c:layout/>${opts.plots.join("")}${axes}</c:plotArea></c:chart>${opts.extra ?? ""}</c:chartSpace>`;
}

export function axTitle(t: string) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></c:rich></c:tx></c:title>`;
}

export function catValAxes(catId: string, valId: string, catTitle?: string, valTitle?: string, extraVal = "") {
  return `<c:catAx><c:axId val="${catId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${catTitle ? axTitle(catTitle) : ""}<c:crossAx val="${valId}"/></c:catAx>`
    + `<c:valAx><c:axId val="${valId}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${valTitle ? axTitle(valTitle) : ""}<c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${catId}"/></c:valAx>${extraVal}`;
}

export function barPlot(series: OfficeSeries[], opts: { barDir?: "col" | "bar"; grouping?: string; axIds?: [string, string]; first?: number } = {}) {
  const [a, b] = opts.axIds ?? ["10", "20"];
  return `<c:barChart><c:barDir val="${opts.barDir ?? "col"}"/><c:grouping val="${opts.grouping ?? "clustered"}"/><c:varyColors val="0"/>${series.map((s, i) => officeSer(s, i + (opts.first ?? 0))).join("")}<c:axId val="${a}"/><c:axId val="${b}"/></c:barChart>`;
}
export function linePlot(series: OfficeSeries[], axIds: [string, string] = ["10", "20"], first = 0) {
  return `<c:lineChart><c:grouping val="standard"/>${series.map((s, i) => officeSer(s, i + first)).join("")}<c:marker val="1"/><c:axId val="${axIds[0]}"/><c:axId val="${axIds[1]}"/></c:lineChart>`;
}
export function simplePlot(kind: string, series: OfficeSeries[], inner = "", xy = false, axIds: [string, string] | null = ["10", "20"]) {
  return `<c:${kind}>${inner}${series.map((s, i) => officeSer(s, i, xy)).join("")}${axIds ? `<c:axId val="${axIds[0]}"/><c:axId val="${axIds[1]}"/>` : ""}</c:${kind}>`;
}

const CT = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
const rels = (items: Array<[string, string]>) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, t]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/x" Target="${t}"/>`).join("")}</Relationships>`;

export function zip(files: Record<string, string | Uint8Array>, level: 0 | 6 = 6): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(entries, { level });
}

export function docx(charts: string[], extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  const files: Record<string, string | Uint8Array> = { "[Content_Types].xml": CT, "word/document.xml": `<w:document xmlns:w="w"><w:body/></w:document>`, ...extra };
  charts.forEach((c, i) => { files[`word/charts/chart${i + 1}.xml`] = c; });
  return zip(files);
}

export function pptx(chartsBySlide: Array<[number, string]>): Uint8Array {
  const files: Record<string, string> = { "[Content_Types].xml": CT, "ppt/presentation.xml": "<p:presentation xmlns:p=\"p\"/>" };
  chartsBySlide.forEach(([slide, xml], i) => {
    files[`ppt/charts/chart${i + 1}.xml`] = xml;
    files[`ppt/slides/slide${slide}.xml`] = "<p:sld xmlns:p=\"p\"/>";
    files[`ppt/slides/_rels/slide${slide}.xml.rels`] = rels([["rId2", `../charts/chart${i + 1}.xml`]]);
  });
  return zip(files);
}

export function sheetXml(rows: Array<Array<string | number | null>>, shared: string[]): string {
  const cells = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
    if (v === null) return "";
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    let idx = shared.indexOf(v);
    if (idx < 0) { shared.push(v); idx = shared.length - 1; }
    return `<c r="${ref}" t="s"><v>${idx}</v></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`;
}

export function xlsx(sheetName: string, rows: Array<Array<string | number | null>>, chart: string): Uint8Array {
  const shared: string[] = [];
  const sheet = sheetXml(rows, shared);
  return zip({
    "[Content_Types].xml": CT,
    "xl/workbook.xml": `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": rels([["rId1", "worksheets/sheet1.xml"]]),
    "xl/worksheets/sheet1.xml": sheet,
    "xl/worksheets/_rels/sheet1.xml.rels": rels([["rId1", "../drawings/drawing1.xml"]]),
    "xl/drawings/drawing1.xml": "<xdr:wsDr xmlns:xdr=\"x\"/>",
    "xl/drawings/_rels/drawing1.xml.rels": rels([["rId1", "../charts/chart1.xml"]]),
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/charts/chart1.xml": chart,
  });
}

// ---- SVG: shared helpers ----------------------------------------------------------------------------------------------

export interface BarData { categories: string[]; series: Array<{ name: string; values: number[]; color: string }> }
export interface Frame { x0: number; x1: number; yTop: number; yBottom: number; vmin: number; vmax: number }
export const vToY = (f: Frame, v: number) => f.yBottom - ((v - f.vmin) / (f.vmax - f.vmin)) * (f.yBottom - f.yTop);
export const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ---- matplotlib (text as glyph paths, ids xtick_N / ytick_N / patch_N / line2d_N / legend_N) ----------------------------

let mplIds = 0;
function mplText(text: string, cx: number, cy: number, opts: { size?: number; rotate?: boolean } = {}): string {
  const size = opts.size ?? 10;
  const s = size / 100;
  const chars = [...text];
  const widthUnits = chars.length ? (chars.length - 1) * 63.623047 + 60 : 0;
  const glyphs = chars.map((ch, k) => `<use xlink:href="#DejaVuSans-${ch.codePointAt(0)!.toString(16)}"${k ? ` x="${r3(k * 63.623047)}"` : ""}/>`).join("\n     ");
  // Baseline-left origin so that the glyph run is centred on (cx, cy).
  const transform = opts.rotate
    ? `translate(${r3(cx - 35 * s)} ${r3(cy + (widthUnits / 2) * s)}) rotate(-90) scale(${s} -${s})`
    : `translate(${r3(cx - (widthUnits / 2) * s)} ${r3(cy + 35 * s)}) scale(${s} -${s})`;
  return `<g id="text_${++mplIds}">\n    <!-- ${text.replace(/--/g, "- -")} -->\n    <g transform="${transform}">\n     <defs><path id="DejaVuSans-${(chars[0] ?? "a").codePointAt(0)!.toString(16)}" d="M 0 0 L 500 700 L 600 0 z" transform="scale(0.015625)"/></defs>\n     ${glyphs}\n    </g>\n   </g>`;
}

function mplHeader(body: string): string {
  return `<?xml version="1.0" encoding="utf-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="460.8pt" height="345.6pt" viewBox="0 0 460.8 345.6" xmlns="http://www.w3.org/2000/svg" version="1.1">
 <metadata>
  <rdf:RDF xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
   <cc:Work><dc:type rdf:resource="http://purl.org/dc/dcmitype/StillImage"/><dc:date>2026-11-10T09:00:00</dc:date><dc:format>image/svg+xml</dc:format>
    <dc:creator><cc:Agent><dc:title>Matplotlib v3.9.2, https://matplotlib.org/</dc:title></cc:Agent></dc:creator></cc:Work>
  </rdf:RDF>
 </metadata>
 <defs><style type="text/css">*{stroke-linejoin: round; stroke-linecap: butt}</style></defs>
 <g id="figure_1">
  <g id="patch_1"><path d="M 0 345.6 L 460.8 345.6 L 460.8 0 L 0 0 z" style="fill: #ffffff"/></g>
  <g id="axes_1">
   <g id="patch_2"><path d="M 57.6 307.584 L 414.72 307.584 L 414.72 41.472 L 57.6 41.472 z" style="fill: #ffffff"/></g>
${body}
  </g>
 </g>
 <defs><clipPath id="p1a2b3c4d5e"><rect x="57.6" y="41.472" width="357.12" height="266.112"/></clipPath></defs>
</svg>
`;
}

const MPL: Frame = { x0: 57.6, x1: 414.72, yTop: 41.472, yBottom: 307.584, vmin: 0, vmax: 1 };

function mplYAxis(f: Frame, ticks: number[], label?: string, fmt: (v: number) => string = String): string {
  const parts = ticks.map((v, k) => {
    const y = r3(vToY(f, v));
    return `    <g id="ytick_${k + 1}">\n     <g id="line2d_y${k + 1}">\n      <defs><path id="my${k}" d="M 0 0 L -3.5 0" style="stroke: #000000; stroke-width: 0.8"/></defs>\n      <g><use xlink:href="#my${k}" x="57.6" y="${y}" style="stroke: #000000; stroke-width: 0.8"/></g>\n     </g>\n     ${mplText(fmt(v), 57.6 - 7 - fmt(v).length * 3.2, y)}\n    </g>`;
  });
  return `   <g id="matplotlib.axis_2">\n${parts.join("\n")}\n${label ? mplText(label, 20, (f.yTop + f.yBottom) / 2, { rotate: true }) : ""}\n   </g>`;
}

function mplXAxisCats(positions: Array<[number, string]>, label?: string): string {
  const parts = positions.map(([x, text], k) => `    <g id="xtick_${k + 1}">\n     <g id="line2d_x${k + 1}">\n      <defs><path id="mx${k}" d="M 0 0 L 0 3.5" style="stroke: #000000; stroke-width: 0.8"/></defs>\n      <g><use xlink:href="#mx${k}" x="${r3(x)}" y="307.584" style="stroke: #000000; stroke-width: 0.8"/></g>\n     </g>\n     ${mplText(text, x, 322)}\n    </g>`);
  return `   <g id="matplotlib.axis_1">\n${parts.join("\n")}\n${label ? mplText(label, (57.6 + 414.72) / 2, 336) : ""}\n   </g>`;
}

function mplSpines(): string {
  return `   <g id="patch_s1"><path d="M 57.6 307.584 L 57.6 41.472" style="fill: none; stroke: #000000; stroke-width: 0.8; stroke-linejoin: miter; stroke-linecap: square"/></g>
   <g id="patch_s2"><path d="M 57.6 307.584 L 414.72 307.584" style="fill: none; stroke: #000000; stroke-width: 0.8; stroke-linejoin: miter; stroke-linecap: square"/></g>`;
}

function mplLegend(entries: Array<{ name: string; color: string; kind: "patch" | "line" }>): string {
  const rows = entries.map((e, k) => {
    const y = 55 + k * 15;
    const swatch = e.kind === "patch"
      ? `<g id="patch_l${k}"><path d="M 330 ${y + 3.5} L 350 ${y + 3.5} L 350 ${y - 3.5} L 330 ${y - 3.5} z" style="fill: ${e.color}"/></g>`
      : `<g id="line2d_l${k}"><path d="M 330 ${y} L 340 ${y} L 350 ${y}" style="fill: none; stroke: ${e.color}; stroke-width: 1.5; stroke-linecap: square"/></g>`;
    return `    ${swatch}\n    ${mplText(e.name, 358 + (e.name.length * 6.36) / 2, y)}`;
  });
  return `   <g id="legend_1">\n    <g id="patch_lf"><path d="M 323 ${45} L 410 45 Q 412 45 412 47 L 412 ${50 + entries.length * 15} L 323 ${50 + entries.length * 15} z" style="fill: #ffffff; opacity: 0.8; stroke: #cccccc; stroke-linejoin: miter"/></g>\n${rows.join("\n")}\n   </g>`;
}

export function niceTicks(vmin: number, vmax: number, n = 5): number[] {
  const step = (vmax - vmin) / n;
  return Array.from({ length: n + 1 }, (_, k) => Number((vmin + k * step).toPrecision(10)));
}

export function matplotlibBar(data: BarData, opts: { title?: string; xlabel?: string; ylabel?: string; vmax: number; legend?: boolean; stacked?: boolean }): string {
  mplIds = 0;
  const f: Frame = { ...MPL, vmin: 0, vmax: opts.vmax };
  const n = data.categories.length;
  const slot = (f.x1 - f.x0) / n;
  const groupW = slot * 0.8;
  const barW = opts.stacked ? groupW : groupW / data.series.length;
  let patches = "";
  let p = 3;
  const base = new Array(n).fill(0);
  data.series.forEach((s, si) => {
    s.values.forEach((v, ci) => {
      const left = opts.stacked ? f.x0 + slot * ci + (slot - groupW) / 2 : f.x0 + slot * ci + (slot - groupW) / 2 + si * barW;
      const y0 = vToY(f, opts.stacked ? base[ci] : 0), y1 = vToY(f, (opts.stacked ? base[ci] : 0) + v);
      if (opts.stacked) base[ci] += v;
      patches += `   <g id="patch_${p++}"><path d="M ${r3(left)} ${r3(y0)} L ${r3(left + barW)} ${r3(y0)} L ${r3(left + barW)} ${r3(y1)} L ${r3(left)} ${r3(y1)} z" clip-path="url(#p1a2b3c4d5e)" style="fill: ${s.color}"/></g>\n`;
    });
  });
  const cats = data.categories.map((c, k) => [f.x0 + slot * k + slot / 2, c] as [number, string]);
  const legend = opts.legend ? mplLegend(data.series.map((s) => ({ name: s.name, color: s.color, kind: "patch" }))) : "";
  return mplHeader(`${patches}${mplXAxisCats(cats, opts.xlabel)}\n${mplYAxis(f, niceTicks(0, opts.vmax), opts.ylabel)}\n${mplSpines()}\n${opts.title ? `   ${mplText(opts.title, (f.x0 + f.x1) / 2, 35, { size: 12 })}` : ""}\n${legend}`);
}

export function matplotlibLine(xs: number[], series: Array<{ name: string; values: number[]; color: string; markers?: boolean }>, opts: { vmin: number; vmax: number; xmin: number; xmax: number; title?: string; ylabel?: string; legend?: boolean }): string {
  mplIds = 0;
  const f: Frame = { ...MPL, vmin: opts.vmin, vmax: opts.vmax };
  const xToPx = (x: number) => f.x0 + ((x - opts.xmin) / (opts.xmax - opts.xmin)) * (f.x1 - f.x0);
  let body = "";
  series.forEach((s, si) => {
    const d = s.values.map((v, k) => `${k ? "L" : "M"} ${r3(xToPx(xs[k]!))} ${r3(vToY(f, v))}`).join(" ");
    body += `   <g id="line2d_${si + 20}">\n    <path d="${d}" clip-path="url(#p1a2b3c4d5e)" style="fill: none; stroke: ${s.color}; stroke-width: 1.5; stroke-linecap: square"/>\n`;
    if (s.markers) {
      body += `    <defs><path id="mk${si}" d="M 0 3 C 0.795609 3 1.55874 2.683901 2.12132 2.12132 C 2.683901 1.55874 3 0.795609 3 0 C 3 -0.795609 2.683901 -1.55874 2.12132 -2.12132 C 1.55874 -2.683901 0.795609 -3 0 -3 C -0.795609 -3 -1.55874 -2.683901 -2.12132 -2.12132 C -2.683901 -1.55874 -3 -0.795609 -3 0 z" style="stroke: ${s.color}"/></defs>\n    <g clip-path="url(#p1a2b3c4d5e)">${s.values.map((v, k) => `<use xlink:href="#mk${si}" x="${r3(xToPx(xs[k]!))}" y="${r3(vToY(f, v))}" style="fill: ${s.color}; stroke: ${s.color}"/>`).join("")}</g>\n`;
    }
    body += "   </g>\n";
  });
  const xt = niceTicks(opts.xmin, opts.xmax, 4).map((x) => [xToPx(x), String(x)] as [number, string]);
  const legend = opts.legend ? mplLegend(series.map((s) => ({ name: s.name, color: s.color, kind: "line" }))) : "";
  return mplHeader(`${body}${mplXAxisCats(xt)}\n${mplYAxis(f, niceTicks(opts.vmin, opts.vmax), opts.ylabel)}\n${mplSpines()}\n${opts.title ? `   ${mplText(opts.title, (f.x0 + f.x1) / 2, 35, { size: 12 })}` : ""}\n${legend}`);
}

export function matplotlibScatter(points: Array<[number, number]>, color: string, opts: { vmin: number; vmax: number; xmin: number; xmax: number }): string {
  mplIds = 0;
  const f: Frame = { ...MPL, vmin: opts.vmin, vmax: opts.vmax };
  const xToPx = (x: number) => f.x0 + ((x - opts.xmin) / (opts.xmax - opts.xmin)) * (f.x1 - f.x0);
  const uses = points.map(([x, y]) => `<use xlink:href="#C0_0_a1b2c3" x="${r3(xToPx(x))}" y="${r3(vToY(f, y))}" style="fill: ${color}; stroke: ${color}"/>`).join("\n     ");
  const body = `   <g id="PathCollection_1">\n    <defs><path id="C0_0_a1b2c3" d="M 0 3 C 0.795609 3 1.55874 2.683901 2.12132 2.12132 C 2.683901 1.55874 3 0.795609 3 0 C 3 -0.795609 2.683901 -1.55874 2.12132 -2.12132 C 1.55874 -2.683901 0.795609 -3 0 -3 C -0.795609 -3 -1.55874 -2.683901 -2.12132 -2.12132 C -2.683901 -1.55874 -3 -0.795609 -3 0 z" style="stroke: ${color}"/></defs>\n    <g clip-path="url(#p1a2b3c4d5e)">\n     ${uses}\n    </g>\n   </g>\n`;
  const xt = niceTicks(opts.xmin, opts.xmax, 4).map((x) => [xToPx(x), String(x)] as [number, string]);
  return mplHeader(`${body}${mplXAxisCats(xt)}\n${mplYAxis(f, niceTicks(opts.vmin, opts.vmax))}\n${mplSpines()}`);
}

export function matplotlibBarh(categories: string[], values: number[], color: string, vmax: number): string {
  mplIds = 0;
  const xToPx = (v: number) => MPL.x0 + (v / vmax) * (MPL.x1 - MPL.x0);
  const slot = (MPL.yBottom - MPL.yTop) / categories.length;
  let body = "";
  const yt: string[] = [];
  categories.forEach((c, k) => {
    const cy = MPL.yBottom - slot * k - slot / 2; // first category at the bottom, like matplotlib
    body += `   <g id="patch_${k + 3}"><path d="M ${MPL.x0} ${r3(cy + slot * 0.4)} L ${r3(xToPx(values[k]!))} ${r3(cy + slot * 0.4)} L ${r3(xToPx(values[k]!))} ${r3(cy - slot * 0.4)} L ${MPL.x0} ${r3(cy - slot * 0.4)} z" clip-path="url(#p1a2b3c4d5e)" style="fill: ${color}"/></g>\n`;
    yt.push(`    <g id="ytick_${k + 1}">\n     <g id="line2d_y${k + 1}"><defs><path id="my${k}" d="M 0 0 L -3.5 0" style="stroke: #000000"/></defs><g><use xlink:href="#my${k}" x="57.6" y="${r3(cy)}" style="stroke: #000000"/></g></g>\n     ${mplText(c, 30, cy)}\n    </g>`);
  });
  const xt = niceTicks(0, vmax, 4).map((x) => [xToPx(x), String(x)] as [number, string]);
  return mplHeader(`${body}${mplXAxisCats(xt)}\n   <g id="matplotlib.axis_2">\n${yt.join("\n")}\n   </g>\n${mplSpines()}`);
}

// ---- Plotly ---------------------------------------------------------------------------------------------------------

export function plotlyBar(data: BarData, opts: { vmax: number; title?: string; stacked?: boolean }): string {
  const f: Frame = { x0: 80, x1: 620, yTop: 100, yBottom: 360, vmin: 0, vmax: opts.vmax };
  const n = data.categories.length;
  const slot = (f.x1 - f.x0) / n;
  const groupW = slot * 0.8;
  const barW = opts.stacked ? groupW : groupW / data.series.length;
  const base = new Array(n).fill(0);
  const traces = data.series.map((s, si) => {
    const pts = s.values.map((v, ci) => {
      const left = f.x0 + slot * ci + (slot - groupW) / 2 + (opts.stacked ? 0 : si * barW);
      const y0 = vToY(f, opts.stacked ? base[ci] : 0), y1 = vToY(f, (opts.stacked ? base[ci] : 0) + v);
      if (opts.stacked) base[ci] += v;
      return `<g class="point"><path d="M${r3(left)},${r3(y0)}V${r3(y1)}H${r3(left + barW)}V${r3(y0)}Z" style="vector-effect: none; opacity: 1; stroke-width: 0px; fill: ${s.color}; fill-opacity: 1;"/></g>`;
    }).join("");
    return `<g class="trace bars" style="opacity: 1;"><g class="points">${pts}</g></g>`;
  }).join("");
  const yt = niceTicks(0, opts.vmax).map((v) => `<g class="ytick"><text text-anchor="end" x="79" y="4.2" data-unformatted="${v}" data-math="N" transform="translate(0,${r3(vToY(f, v))})" style="font-family: 'Open Sans', verdana, arial, sans-serif; font-size: 12px; fill: rgb(42, 63, 95); fill-opacity: 1; white-space: pre; opacity: 1;">${v}</text></g>`).join("");
  const grid = niceTicks(0, opts.vmax).map((v) => `<path class="ygrid crisp" transform="translate(0,${r3(vToY(f, v))})" d="M80,0h540" style="stroke: rgb(255, 255, 255); stroke-opacity: 1; stroke-width: 1px;"/>`).join("");
  const xt = data.categories.map((c, k) => `<g class="xtick"><text text-anchor="middle" x="0" y="373" data-unformatted="${c}" transform="translate(${r3(f.x0 + slot * k + slot / 2)},0)" style="font-size: 12px;">${c}</text></g>`).join("");
  const legend = data.series.map((s, k) => `<g class="traces" transform="translate(0,${14.5 + k * 19})" style="opacity: 1;"><text class="legendtext" text-anchor="start" x="40" y="4.68" style="font-size: 12px;">${s.name}</text><g class="layers" style="opacity: 1;"><g class="legendfill"/><g class="legendlines"/><g class="legendsymbols"><g class="legendpoints"><path class="legendundefined" d="M6,6H-6V-6H6Z" transform="translate(20,0)" style="stroke-width: 0.5px; fill: ${s.color}; fill-opacity: 1;"/></g></g></g></g>`).join("");
  return `<svg class="main-svg" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="700" height="450" style="" viewBox="0 0 700 450"><rect x="0" y="0" width="700" height="450" style="fill: rgb(255, 255, 255); fill-opacity: 1;"/><defs id="defs-1"><g class="clips"/></defs><g class="bglayer"><rect class="bg" x="80" y="100" width="540" height="260" style="fill: rgb(229, 236, 246); fill-opacity: 1; stroke-width: 0;"/></g><g class="layer-below"/><g class="cartesianlayer"><g class="subplot xy"><g class="gridlayer"><g class="x"/><g class="y">${grid}</g></g><g class="zerolinelayer"/><g class="layer-between"/><path class="xlines-below"/><path class="ylines-below"/><g class="overlines-below"/><g class="xaxislayer-below"/><g class="yaxislayer-below"/><g class="overaxes-below"/><g class="overplot"><g class="xy" transform="translate(0,0)"><g class="barlayer mlayer">${traces}</g></g></g><g class="xaxislayer-above">${xt}</g><g class="yaxislayer-above">${yt}</g></g></g><g class="infolayer"><g class="legend" pointer-events="all" transform="translate(632,100)"><g class="scrollbox" transform="">${legend}</g></g>${opts.title ? `<g class="g-gtitle"><text class="gtitle" x="35" y="50" text-anchor="start" dy="0em" style="font-size: 17px;">${opts.title}</text></g>` : ""}</g></svg>`;
}

// ---- Recharts (monotone curves; tspans with dy) ----------------------------------------------------------------------

export function rechartsLine(categories: string[], values: number[], vmax: number, color = "#8884d8"): string {
  const f: Frame = { x0: 65, x1: 465, yTop: 5, yBottom: 265, vmin: 0, vmax };
  const xs = categories.map((_, k) => f.x0 + (k * (f.x1 - f.x0)) / (categories.length - 1));
  const ys = values.map((v) => vToY(f, v));
  let d = `M${r3(xs[0]!)},${r3(ys[0]!)}`;
  for (let k = 1; k < xs.length; k++) {
    const dx = (xs[k]! - xs[k - 1]!) / 3;
    d += `C${r3(xs[k - 1]! + dx)},${r3(ys[k - 1]!)},${r3(xs[k]! - dx)},${r3(ys[k]!)},${r3(xs[k]!)},${r3(ys[k]!)}`;
  }
  const yticks = niceTicks(0, vmax, 4).map((v) => `<g class="recharts-layer recharts-cartesian-axis-tick"><line orientation="left" width="60" height="260" x="5" y="5" class="recharts-cartesian-axis-tick-line" stroke="#666" fill="none" x1="59" y1="${r3(vToY(f, v))}" x2="65" y2="${r3(vToY(f, v))}"/><text orientation="left" width="60" height="260" stroke="none" x="57" y="${r3(vToY(f, v))}" class="recharts-text recharts-cartesian-axis-tick-value" text-anchor="end" fill="#666"><tspan x="57" dy="0.355em">${v}</tspan></text></g>`).join("");
  const xticks = categories.map((c, k) => `<g class="recharts-layer recharts-cartesian-axis-tick"><text orientation="bottom" width="400" height="30" stroke="none" x="${r3(xs[k]!)}" y="273" class="recharts-text recharts-cartesian-axis-tick-value" text-anchor="middle" fill="#666"><tspan x="${r3(xs[k]!)}" dy="0.71em">${c}</tspan></text></g>`).join("");
  return `<svg class="recharts-surface" width="500" height="300" viewBox="0 0 500 300" xmlns="http://www.w3.org/2000/svg"><title></title><desc></desc><defs><clipPath id="recharts1-clip"><rect x="65" y="5" height="260" width="400"/></clipPath></defs><g class="recharts-cartesian-grid"><g class="recharts-cartesian-grid-horizontal">${niceTicks(0, vmax, 4).map((v) => `<line stroke-dasharray="3 3" stroke="#ccc" fill="none" x="65" y="5" width="400" height="260" x1="65" y1="${r3(vToY(f, v))}" x2="465" y2="${r3(vToY(f, v))}"/>`).join("")}</g></g><g class="recharts-layer recharts-cartesian-axis recharts-xAxis xAxis"><line orientation="bottom" class="recharts-cartesian-axis-line" stroke="#666" fill="none" x1="65" y1="265" x2="465" y2="265"/><g class="recharts-cartesian-axis-ticks">${xticks}</g></g><g class="recharts-layer recharts-cartesian-axis recharts-yAxis yAxis"><line orientation="left" class="recharts-cartesian-axis-line" stroke="#666" fill="none" x1="65" y1="5" x2="65" y2="265"/><g class="recharts-cartesian-axis-ticks">${yticks}</g></g><g class="recharts-layer recharts-line"><path stroke="${color}" stroke-width="2" fill="none" width="400" height="260" class="recharts-curve recharts-line-curve" d="${d}"/><g class="recharts-layer recharts-line-dots">${xs.map((x, k) => `<circle r="3" stroke="${color}" stroke-width="2" fill="#fff" width="400" height="260" cx="${r3(x)}" cy="${r3(ys[k]!)}" class="recharts-dot recharts-line-dot"/>`).join("")}</g></g></svg>`;
}

// ---- Highcharts (series group translated; baseline-shifted labels snapped to gridlines) ------------------------------

export function highchartsColumn(categories: string[], values: number[], vmax: number, title: string): string {
  const plot = { left: 60, top: 50, width: 500, height: 250 };
  const f: Frame = { x0: 0, x1: plot.width, yTop: 0, yBottom: plot.height, vmin: 0, vmax };
  const slot = plot.width / categories.length;
  const rects = values.map((v, k) => `<rect x="${r3(slot * k + slot * 0.2)}" y="${r3(vToY(f, v))}" width="${r3(slot * 0.6)}" height="${r3(plot.height - vToY(f, v))}" fill="#2caffe" opacity="1" class="highcharts-point"/>`).join("");
  const grid = niceTicks(0, vmax, 4).map((v) => `<path fill="none" stroke="#e6e6e6" stroke-width="1" d="M ${plot.left} ${r3(plot.top + vToY(f, v) + 0.5)} L ${plot.left + plot.width} ${r3(plot.top + vToY(f, v) + 0.5)}" opacity="1" class="highcharts-grid-line"/>`).join("");
  const ylabels = niceTicks(0, vmax, 4).map((v) => `<text x="45" style="color: #666666; font-size: 11px; fill: #666666;" text-anchor="end" transform="translate(0,0)" y="${r3(plot.top + vToY(f, v) + 4)}" opacity="1">${v}</text>`).join("");
  const xlabels = categories.map((c, k) => `<text x="${r3(plot.left + slot * k + slot / 2)}" style="color: #333333; font-size: 11px; fill: #333333;" text-anchor="middle" transform="translate(0,0)" y="${plot.top + plot.height + 20}" opacity="1">${c}</text>`).join("");
  return `<svg version="1.1" class="highcharts-root" style="font-family: Helvetica, Arial, sans-serif; font-size: 1rem;" xmlns="http://www.w3.org/2000/svg" width="600" height="340" viewBox="0 0 600 340"><desc>Created with Highcharts 11.4.8</desc><defs><clipPath id="highcharts-1"><rect x="0" y="0" width="500" height="250" fill="none"/></clipPath></defs><rect fill="#ffffff" class="highcharts-background" x="0" y="0" width="600" height="340" rx="0" ry="0"/><rect fill="none" class="highcharts-plot-background" x="60" y="50" width="500" height="250"/><g class="highcharts-grid highcharts-yaxis-grid" data-z-index="1">${grid}</g><g class="highcharts-series-group" data-z-index="3"><g class="highcharts-series highcharts-series-0 highcharts-column-series highcharts-tracker" data-z-index="0.1" opacity="1" transform="translate(60,50) scale(1 1)" clip-path="url(#highcharts-1)">${rects}</g></g><text x="300" text-anchor="middle" class="highcharts-title" data-z-index="4" style="font-size: 1.2em; color: #333333; font-weight: bold; fill: #333333;" y="25">${title}</text><g class="highcharts-axis-labels highcharts-xaxis-labels" data-z-index="7">${xlabels}</g><g class="highcharts-axis-labels highcharts-yaxis-labels" data-z-index="7">${ylabels}</g></svg>`;
}

// ---- Vega (role-axis / role-mark groups) ------------------------------------------------------------------------------

export function vegaBar(categories: string[], values: number[], vmax: number): string {
  const f: Frame = { x0: 0, x1: 200, yTop: 0, yBottom: 200, vmin: 0, vmax };
  const bw = 200 / categories.length;
  const bars = values.map((v, k) => `<path aria-label="a: ${categories[k]}; b: ${v}" role="graphics-symbol" aria-roledescription="bar" d="M${r3(k * bw + 1)},${r3(vToY(f, v))}h${r3(bw - 2)}v${r3(200 - vToY(f, v))}h-${r3(bw - 2)}Z" fill="#4c78a8"/>`).join("");
  const grid = niceTicks(0, vmax, 4).map((v) => `<line transform="translate(0,${r3(vToY(f, v))})" x2="200" y2="0" stroke="#ddd" stroke-width="1" opacity="1"/>`).join("");
  const ylabels = niceTicks(0, vmax, 4).map((v) => `<text text-anchor="end" transform="translate(-7,${r3(vToY(f, v) + 3)})" font-family="sans-serif" font-size="10px" fill="#000" opacity="1">${v}</text>`).join("");
  const xlabels = categories.map((c, k) => `<text text-anchor="middle" transform="translate(${r3(k * bw + bw / 2)},${215})" font-family="sans-serif" font-size="10px" fill="#000" opacity="1">${c}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" class="marks" width="250" height="260" viewBox="0 0 250 260"><rect width="250" height="260" fill="white"/><g fill="none" stroke-miterlimit="10" transform="translate(40,10)"><g class="mark-group role-frame root" role="graphics-object" aria-roledescription="group mark container"><g transform="translate(0,0)"><path class="background" aria-hidden="true" d="M0.5,0.5h200v200h-200Z" stroke="#ddd"/><g><g class="mark-group role-axis" aria-hidden="true"><g transform="translate(0.5,0.5)"><path class="background" aria-hidden="true" d="M0,0h0v0h0Z" pointer-events="none"/><g><g class="mark-rule role-axis-grid" pointer-events="none">${grid}</g></g></g></g><g class="mark-group role-axis" role="graphics-symbol" aria-roledescription="axis" aria-label="Y-axis titled 'b' for a linear scale"><g transform="translate(0.5,0.5)"><g><g class="mark-text role-axis-label" pointer-events="none">${ylabels}</g></g></g></g><g class="mark-group role-axis" role="graphics-symbol" aria-roledescription="axis" aria-label="X-axis titled 'a' for a discrete scale"><g transform="translate(0.5,200.5)"><g><g class="mark-text role-axis-label" pointer-events="none"><g transform="translate(0,-200.5)">${xlabels}</g></g></g></g></g><g class="mark-rect role-mark marks" role="graphics-object" aria-roledescription="rect mark container">${bars}</g></g></g></g></g></svg>`;
}

// ---- Generic (no generator signature) ---------------------------------------------------------------------------------

export function genericBar(categories: string[], values: number[], vmax: number, opts: { log?: boolean; vmin?: number } = {}): string {
  const top = 20, bottom = 220, left = 50, width = 300;
  const vmin = opts.vmin ?? 0;
  const toY = (v: number) => opts.log ? bottom - ((Math.log10(v) - Math.log10(vmin)) / (Math.log10(vmax) - Math.log10(vmin))) * (bottom - top) : bottom - ((v - vmin) / (vmax - vmin)) * (bottom - top);
  const ticks = opts.log ? [1, 10, 100, 1000, 10000].filter((t) => t >= vmin && t <= vmax) : niceTicks(vmin, vmax, 4);
  const slot = width / categories.length;
  const rects = values.map((v, k) => `<rect x="${r3(left + slot * k + slot * 0.15)}" y="${r3(toY(v))}" width="${r3(slot * 0.7)}" height="${r3(bottom - toY(v))}" fill="#e45756"/>`).join("");
  const yl = ticks.map((t) => `<text x="${left - 6}" y="${r3(toY(t))}" text-anchor="end" dominant-baseline="middle" font-size="10">${t.toLocaleString("en-US")}</text>`).join("");
  const xl = categories.map((c, k) => `<text x="${r3(left + slot * k + slot / 2)}" y="${bottom + 14}" text-anchor="middle" font-size="10">${c}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260" viewBox="0 0 400 260"><g>${rects}</g><line x1="${left}" y1="${bottom}" x2="${left + width}" y2="${bottom}" stroke="black"/>${yl}${xl}</svg>`;
}

export function genericLogLine(xs: number[], ys: number[]): string {
  const top = 20, bottom = 220, left = 50, right = 350;
  const toY = (v: number) => bottom - (Math.log10(v) / 4) * (bottom - top); // decades 1..10^4
  const toX = (x: number) => left + ((x - xs[0]!) / (xs[xs.length - 1]! - xs[0]!)) * (right - left);
  const pts = xs.map((x, k) => `${r3(toX(x))},${r3(toY(ys[k]!))}`).join(" ");
  const yl = [1, 10, 100, 1000, 10000].map((t) => `<text x="${left - 6}" y="${r3(toY(t))}" text-anchor="end" dominant-baseline="central" font-size="10">${t}</text>`).join("");
  const xl = xs.map((x) => `<text x="${r3(toX(x))}" y="${bottom + 14}" text-anchor="middle" dominant-baseline="central" font-size="10">${x}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><polyline points="${pts}" fill="none" stroke="#4c78a8" stroke-width="2"/>${yl}${xl}<text x="200" y="10" text-anchor="middle" dominant-baseline="central" font-size="14">Users (log)</text></svg>`;
}

// ---- Diagrams ---------------------------------------------------------------------------------------------------------

export const MERMAID_FLOWCHART = `<svg id="mermaid-1731" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 300px;" viewBox="0 0 300 400" role="graphics-document document" aria-roledescription="flowchart-v2"><style>#mermaid-1731{font-family:sans-serif;}</style><g><marker id="mermaid-1731_flowchart-v2-pointEnd" class="marker flowchart-v2" viewBox="0 0 10 10" refX="5" refY="5"><path d="M 0 0 L 10 5 L 0 10 z" class="arrowMarkerPath"/></marker><g class="root"><g class="clusters"/><g class="edgePaths"><path d="M150,60L150,110" id="L_Start_Check_0" class=" edge-thickness-normal edge-pattern-solid edge-thickness-normal edge-pattern-solid flowchart-link" style=";" data-edge="true" data-et="edge" data-id="L_Start_Check_0" data-points="x" marker-end="url(#mermaid-1731_flowchart-v2-pointEnd)"/><path d="M150,190L80,260" id="L_Check_Ship_order_0" class=" edge-thickness-normal edge-pattern-solid flowchart-link" data-edge="true" data-id="L_Check_Ship_order_0" marker-end="url(#mermaid-1731_flowchart-v2-pointEnd)"/><path d="M150,190L220,260" id="L_Check_Restock_0" class=" edge-thickness-thick edge-pattern-dotted flowchart-link" data-edge="true" data-id="L_Check_Restock_0"/></g><g class="edgeLabels"><g class="edgeLabel"><g class="label" data-id="L_Start_Check_0" transform="translate(0, 0)"><foreignObject width="0" height="0"><div xmlns="http://www.w3.org/1999/xhtml" class="labelBkg" style="display: table-cell;"><span class="edgeLabel"></span></div></foreignObject></g></g><g class="edgeLabel" transform="translate(115, 225)"><g class="label" data-id="L_Check_Ship_order_0" transform="translate(-12, -12)"><foreignObject width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml" class="labelBkg"><span class="edgeLabel"><p>in stock</p></span></div></foreignObject></g></g><g class="edgeLabel"><g class="label" data-id="L_Check_Restock_0"><foreignObject width="0" height="0"><div xmlns="http://www.w3.org/1999/xhtml"><span class="edgeLabel"></span></div></foreignObject></g></g></g><g class="nodes"><g class="node default" id="flowchart-Start-0" transform="translate(150, 40)"><rect class="basic label-container" style="" rx="5" ry="5" x="-50" y="-20" width="100" height="40"/><g class="label" style="" transform="translate(-30, -12)"><rect/><foreignObject width="60" height="24"><div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;"><span class="nodeLabel"><p>Order in</p></span></div></foreignObject></g></g><g class="node default" id="flowchart-Check-1" transform="translate(150, 150)"><polygon points="40,0 80,-40 40,-80 0,-40" class="label-container" transform="translate(-40,40)"/><g class="label" transform="translate(-25, -12)"><foreignObject width="50" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Stock?</p></span></div></foreignObject></g></g><g class="node default" id="flowchart-Ship_order-3" transform="translate(80, 280)"><rect class="basic label-container" x="-45" y="-20" width="90" height="40"/><g class="label"><foreignObject width="60" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Ship &lt;fast&gt;</p></span></div></foreignObject></g></g><g class="node default" id="flowchart-Restock-5" transform="translate(220, 280)"><rect class="basic label-container" x="-45" y="-20" width="90" height="40"/><g class="label"><foreignObject width="60" height="24"><div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>Restock</p></span></div></foreignObject></g></g></g></g></g></svg>`;

export const GRAPHVIZ_DIGRAPH = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"
 "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<!-- Generated by graphviz version 2.43.0 (0)
 -->
<!-- Title: pipeline Pages: 1 -->
<svg width="260pt" height="188pt" viewBox="0.00 0.00 260.00 188.00" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<g id="graph0" class="graph" transform="scale(1 1) rotate(0) translate(4 184)">
<title>pipeline</title>
<polygon fill="white" stroke="transparent" points="-4,4 -4,-184 256,-184 256,4 -4,4"/>
<g id="clust1" class="cluster">
<title>cluster_ingest</title>
<polygon fill="none" stroke="black" points="8,-80 8,-172 120,-172 120,-80 8,-80"/>
<text text-anchor="middle" x="64" y="-156.8" font-family="Times,serif" font-size="14.00">Ingest</text>
</g>
<!-- upload -->
<g id="node1" class="node">
<title>upload</title>
<ellipse fill="none" stroke="black" cx="64" cy="-106" rx="40" ry="18"/>
<text text-anchor="middle" x="64" y="-102.3" font-family="Times,serif" font-size="14.00">Upload</text>
</g>
<!-- parse -->
<g id="node2" class="node">
<title>parse</title>
<polygon fill="none" stroke="black" points="104,-36 24,-36 24,0 104,0 104,-36"/>
<text text-anchor="middle" x="64" y="-14.3" font-family="Times,serif" font-size="14.00">Parse &amp; chunk</text>
</g>
<!-- index -->
<g id="node3" class="node">
<title>index</title>
<polygon fill="none" stroke="black" points="200,-36 160,-18 200,0 240,-18 200,-36"/>
<text text-anchor="middle" x="200" y="-14.3" font-family="Times,serif" font-size="14.00">Index?</text>
</g>
<!-- upload&#45;&gt;parse -->
<g id="edge1" class="edge">
<title>upload&#45;&gt;parse</title>
<path fill="none" stroke="black" d="M64,-87.7C64,-79.98 64,-70.71 64,-62.11"/>
<polygon fill="black" stroke="black" points="67.5,-62.1 64,-52.1 60.5,-62.1 67.5,-62.1"/>
<text text-anchor="middle" x="80" y="-60" font-family="Times,serif" font-size="14.00">bytes</text>
</g>
<!-- parse&#45;&gt;index -->
<g id="edge2" class="edge">
<title>parse&#45;&gt;index</title>
<path fill="none" stroke="black" stroke-dasharray="5,2" d="M104,-18C120,-18 140,-18 156,-18"/>
<polygon fill="black" stroke="black" points="156,-21.5 166,-18 156,-14.5 156,-21.5"/>
</g>
</g>
</svg>
`;
