/**
 * The 75-document slice of the free-tier gate (app #484, docs/evals/chart-export-free-tier-2026-11-13): the public
 * chart-export-real corpus plus the same 50 generated documents, written to <out>. Run from core/worker:
 *   npx tsx ../performance/chart-export-inline/gen-slice.mts ~/datasets/chart-export-real/docs <out>
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { barPlot, chartXml, docx, genericBar, linePlot, pptx, xlsx, zip } from "../../worker/src/chart-export/extractors/__tests__/fixtures.js";
import { buildTestPdf, proseLines } from "../../worker/src/test/make-pdf.js";

const [corpus, out] = process.argv.slice(2);
if (!corpus || !out) throw new Error("usage: gen-slice.mts <corpus dir> <out dir>");
mkdirSync(out, { recursive: true });
for (const f of readdirSync(corpus)) copyFileSync(path.join(corpus, f), path.join(out, f));
const quarters = ["Q1", "Q2", "Q3", "Q4"];
for (let i = 0; i < 10; i += 1) {
  const charts = Array.from({ length: 1 + (i % 3) }, (_, j) => chartXml({
    title: `Bookings growth ${2024 + j}`,
    plots: [j % 2 ? linePlot([{ name: "Bookings", cats: quarters, vals: quarters.map((_, q) => 10 + q * (i + 2)) }]) : barPlot([{ name: "Revenue", cats: quarters, vals: quarters.map((_, q) => 20 + q * 3 + i) }])],
  }));
  writeFileSync(path.join(out, `gen-charts-${i}.docx`), docx(charts));
}
for (let i = 0; i < 5; i += 1) writeFileSync(path.join(out, `gen-plain-${i}.docx`), docx([]));
for (let i = 0; i < 5; i += 1) writeFileSync(path.join(out, `gen-deck-${i}.pptx`), pptx(i % 2 ? [] : [[1, chartXml({ title: "Expansion markets", plots: [barPlot([{ name: "Stores", cats: ["London", "Tokyo", "Austin"], vals: [4 + i, 6, 9] }])] })]]));
for (let i = 0; i < 5; i += 1) {
  writeFileSync(path.join(out, `gen-sheet-${i}.xlsx`), xlsx("Earnings", [["Quarter", "EPS"], ...quarters.map((q, k) => [q, 1 + k * 0.2 + i * 0.1])], chartXml({ title: "Earnings beat", plots: [barPlot([{ name: "EPS", cats: quarters, vals: quarters.map((_, k) => 1 + k * 0.2) }])] })));
}
for (let i = 0; i < 5; i += 1) {
  const spec = { $schema: "https://vega.github.io/schema/vega-lite/v5.json", description: "Passenger growth", mark: "bar", data: { values: quarters.map((q, k) => ({ quarter: q, passengers: 100 + k * 25 + i })) }, encoding: { x: { field: "quarter", type: "nominal" }, y: { field: "passengers", type: "quantitative" } } };
  writeFileSync(path.join(out, `gen-vega-${i}.html`), `<html><body><h1>Flights to London</h1><div id="vis"></div><script>vegaEmbed("#vis", ${JSON.stringify(spec)});</script></body></html>`);
  writeFileSync(path.join(out, `gen-plain-${i}.html`), `<html><body><h1>Annual report</h1>${proseLines(40, i).map((line) => `<p>${line}</p>`).join("")}</body></html>`);
}
for (let i = 0; i < 5; i += 1) writeFileSync(path.join(out, `gen-chart-${i}.svg`), genericBar(["North", "South", "East", "West"], [12 + i, 18, 9, 22], 30));
for (let i = 0; i < 10; i += 1) {
  writeFileSync(path.join(out, `gen-text-${i}.pdf`), buildTestPdf(Array.from({ length: 3 + i }, (_, p) => ({ kind: "text", heading: `Section ${p + 1}`, lines: proseLines(40, i * 10 + p) }) as never)));
}
// Council M3: JSON and EPUB, with and without a chart (an API export is the common JSON upload and must cost nothing).
const vega = (k: number) => ({ $schema: "https://vega.github.io/schema/vega-lite/v5.json", title: `Bookings growth ${2024 + k}`, mark: "bar", data: { values: quarters.map((q, i) => ({ quarter: q, bookings: 40 + i * 10 + k })) }, encoding: { x: { field: "quarter", type: "nominal" }, y: { field: "bookings", type: "quantitative" } } });
for (let i = 0; i < 4; i += 1) writeFileSync(path.join(out, `gen-spec-${i}.json`), JSON.stringify(vega(i), null, 2));
for (let i = 0; i < 2; i += 1) writeFileSync(path.join(out, `gen-plotly-${i}.json`), JSON.stringify({ data: [{ type: "bar", x: quarters, y: [12 + i, 15, 19, 24] }], layout: { title: { text: "Earnings beat" } } }));
for (let i = 0; i < 6; i += 1) {
  writeFileSync(path.join(out, `gen-export-${i}.json`), JSON.stringify({ orders: Array.from({ length: 50 + i * 40 }, (_, k) => ({ id: k, city: ["London", "Tokyo", "Austin"][k % 3], total: 10 + k })), next: null }, null, 2));
}
for (let i = 0; i < 3; i += 1) writeFileSync(path.join(out, `gen-rows-${i}.json`), JSON.stringify(Array.from({ length: 200 }, (_, k) => ({ quarter: quarters[k % 4], value: k }))));
function epub(chapters: string[]): Uint8Array {
  const files: Record<string, string> = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    "OEBPS/content.opf": `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata/><manifest>${chapters.map((_, k) => `<item id="c${k}" href="c${k}.xhtml" media-type="application/xhtml+xml"/>`).join("")}</manifest><spine>${chapters.map((_, k) => `<itemref idref="c${k}"/>`).join("")}</spine></package>`,
  };
  chapters.forEach((body, k) => { files[`OEBPS/c${k}.xhtml`] = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`; });
  return zip(files, 0);
}
for (let i = 0; i < 3; i += 1) {
  writeFileSync(path.join(out, `gen-book-chart-${i}.epub`), epub([`<h1>Expansion</h1>${proseLines(20, i).map((l) => `<p>${l}</p>`).join("")}`, genericBar(["London", "Tokyo", "Austin"], [4 + i, 6, 9], 12), `<script type="application/json">${JSON.stringify(vega(i))}</script>`]));
}
for (let i = 0; i < 2; i += 1) writeFileSync(path.join(out, `gen-book-plain-${i}.epub`), epub([`<h1>Annual report</h1>${proseLines(40, i).map((l) => `<p>${l}</p>`).join("")}`]));
// Council r2 M-b: realistic no-chart documents. JSON API envelopes ({"data": ...}, two with JSON:API "type" members, which
// the extractor does read), ensure_ascii exports, and saved web pages whose scripts are analytics, a framework bootstrap
// and JSON state.
for (let i = 0; i < 2; i += 1) writeFileSync(path.join(out, `real-envelope-${i}.json`), JSON.stringify({ data: { id: String(i), attributes: { city: ["London", "Tokyo"][i], bookings: 120 + i } }, meta: { page: 1 } }));
for (let i = 0; i < 2; i += 1) writeFileSync(path.join(out, `real-jsonapi-${i}.json`), JSON.stringify({ data: [{ type: "trips", id: String(i), attributes: { from: "Austin", to: "London" } }], links: { self: "/trips" } }));
for (let i = 0; i < 3; i += 1) writeFileSync(path.join(out, `real-ascii-${i}.json`), `{"city": "Z\\u00fcrich", "note": "caf\\u00e9 expansion ${i}", "rows": [${Array.from({ length: 50 }, (_, k) => k).join(",")}]}`);
for (let i = 0; i < 4; i += 1) {
  writeFileSync(path.join(out, `real-page-${i}.html`), `<!doctype html><html><head><title>Expansion news</title><script async src="https://example.com/gtag.js"></script>`
    + `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());</script>`
    + `<script type="application/json" id="__STATE__">{"route":"/news/${i}","user":null,"flags":{"beta":true}}</script></head>`
    + `<body><nav>Home · News</nav>${proseLines(30, i).map((l) => `<p>${l}</p>`).join("")}<script src="/app.js"></script></body></html>`);
}
console.log(`documents=${readdirSync(out).length}`);
