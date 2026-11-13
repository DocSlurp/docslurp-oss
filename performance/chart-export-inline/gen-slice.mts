/**
 * The 75-document slice of the free-tier gate (app #484, docs/evals/chart-export-free-tier-2026-11-13): the public
 * chart-export-real corpus plus the same 50 generated documents, written to <out>. Run from core/worker:
 *   npx tsx ../performance/chart-export-inline/gen-slice.mts ~/datasets/chart-export-real/docs <out>
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { barPlot, chartXml, docx, genericBar, linePlot, pptx, xlsx } from "../../worker/src/chart-export/extractors/__tests__/fixtures.js";
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
console.log(`documents=${readdirSync(out).length}`);
