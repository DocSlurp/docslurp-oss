#!/usr/bin/env node
// Measures the SVG density gate's inputs over a corpus of legitimate chart SVGs, counted exactly as the gate counts
// (the same buildScene counters), and reports p50 / p90 / p99 / max per metric plus how many files the current gate
// would skip or approximate. Rerun it whenever a gate changes. The corpus stays outside the repository.
//
//   pnpm --filter @docslurp/worker build
//   node performance/chart-export-free-rungs/svg-density-stats.mjs <dir-or-file>... [--generated] [--json out.json]
//
// <dir>: every *.svg under it, recursively. --generated adds the worker test generators' charts (matplotlib, Plotly,
// Recharts, Highcharts, Vega, Mermaid, Graphviz). The PR's 551-SVG corpus: Doppler figure SVGs from the public bench
// PDFs, arXiv figures, Doppler figures from #437's run, #369's slice, this report's corpus (gen_fixtures.py: svg/, vega/,
// doppler-*/; not adversarial/), README charts, and --generated.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const dist = (p) => pathToFileURL(path.join(repo, "worker/dist/chart-export/extractors", p)).href;
const { parseXml } = await import(dist("xml.js"));
const { buildScene } = await import(dist("svg-scene.js"));
const { prepareSvgChart, withoutVertexMarkers } = await import(dist("svg-geometry.js"));
const { CHART_EXTRACT_LIMITS: LIMITS } = await import(dist("limits.js"));
const { extractDeterministicVisuals } = await import(dist("index.js"));

const args = process.argv.slice(2);
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const svgsUnder = (p) => statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter((f) => String(f).endsWith(".svg")).map((f) => path.join(p, String(f))) : [p];
const files = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json").flatMap(svgsUnder).map((f) => ({ name: f, text: readFileSync(f, "utf8") }));
if (args.includes("--generated")) {
  const F = await import(dist("__tests__/fixtures.js"));
  const xs = Array.from({ length: 200 }, (_, i) => i);
  files.push(...[
    F.matplotlibBar({ categories: ["Q1", "Q2", "Q3", "Q4"], series: [{ name: "R", values: [12, 15, 9, 21], color: "#1f77b4" }, { name: "C", values: [5, 7, 3, 9], color: "#ff7f0e" }] }, { vmax: 25, title: "T", legend: true }),
    F.matplotlibLine(xs, [{ name: "a", values: xs.map((x) => Math.sin(x / 9) * 10 + 20), color: "#1f77b4", markers: true }, { name: "b", values: xs.map((x) => x / 9), color: "#ff7f0e", markers: true }], { vmin: 0, vmax: 35, xmin: 0, xmax: 200, legend: true }),
    F.matplotlibScatter(xs.map((x) => [x, (x * 7) % 30]), "#2ca02c", { vmin: 0, vmax: 30, xmin: 0, xmax: 200 }),
    F.matplotlibBarh(["a", "b", "c", "d", "e"], [3, 5, 2, 8, 6], "#9467bd", 10),
    F.plotlyBar({ categories: ["a", "b", "c"], series: [{ name: "s", values: [3, 4, 2], color: "#636efa" }, { name: "t", values: [1, 2, 3], color: "#ef553b" }] }, { vmax: 5, stacked: true }),
    F.rechartsLine(["Mon", "Tue", "Wed", "Thu", "Fri"], [3, 5, 4, 7, 6], 8),
    F.highchartsColumn(["A", "B", "C"], [3, 6, 2], 8, "H"),
    F.vegaBar(["x", "y", "z"], [1, 2, 3], 4),
    F.genericBar(["a", "b", "c", "d"], [1, 2, 3, 4], 5),
    F.MERMAID_FLOWCHART, F.GRAPHVIZ_DIGRAPH,
  ].map((text, i) => ({ name: `generated-${i}`, text })));
}

const countElements = (el) => { let n = 0; const stack = [el]; while (stack.length) { const e = stack.pop(); n++; for (const c of e.children) if (c.type === "element") stack.push(c); } return n; };
/** Longest geometry attribute (d, points), longest other attribute, and longest text under one element. */
function attrSizes(el) {
  let geo = 0, other = 0, text = 0;
  const stack = [el];
  while (stack.length) {
    const e = stack.pop();
    for (const [k, v] of Object.entries(e.attrs)) { if (k === "d" || k === "points") geo = Math.max(geo, v.length); else other = Math.max(other, v.length); }
    let t = 0;
    for (const c of e.children) { if (c.type === "element") stack.push(c); else if (c.type === "text") t += c.value.length; }
    text = Math.max(text, t);
  }
  return { geoAttr: geo, otherAttr: other, elementText: text };
}
const gateLimits = Object.fromEntries(Object.entries(LIMITS).filter(([k]) => /^maxSvg|^maxMarkerPairTests$/.test(k)));
// Count with the gates lifted, so every file is measured in full; restore them to check what the gate would do.
const lifted = Object.fromEntries(Object.keys(gateLimits).map((k) => [k, Number.MAX_SAFE_INTEGER]));
const rows = [];
for (const f of files) {
  const row = { name: f.name, bytes: Buffer.byteLength(f.text) };
  Object.assign(LIMITS, lifted);
  try {
    const doc = parseXml(f.text, { keepComments: true });
    const svg = doc.children.find((c) => c.type === "element" && c.local === "svg");
    row.elements = countElements(svg);
    Object.assign(row, attrSizes(svg));
    const counts = { useExpansions: 0, primitives: 0, segments: 0, walked: 0, touched: 0 };
    buildScene(svg, counts);
    Object.assign(row, counts);
    const prepared = prepareSvgChart(svg);
    const work = { pairTests: 0 };
    withoutVertexMarkers(prepared.markers, prepared.lines, work, Infinity);
    row.pairTests = work.pairTests;
  } catch (error) {
    row.error = String(error?.message ?? error).slice(0, 80);
  }
  Object.assign(LIMITS, gateLimits);
  const result = extractDeterministicVisuals({ kind: "svg", text: f.text });
  // Any refusal or deferral of a legitimate SVG counts as skipped, whatever the reason (council r6 L2).
  row.gated = result.refusals[0]?.reason ?? result.deferred?.[0]?.reason ?? null;
  row.approximate = result.visuals.some((v) => v.reason === "approximate-marker-dedup");
  rows.push(row);
}
const ok = rows.filter((r) => !r.error);
const q = (k, p) => { const v = ok.map((r) => r[k]).sort((a, b) => a - b); return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]; };
console.log(`SVGs: ${rows.length} measured, ${rows.length - ok.length} failed to parse${rows.length > ok.length ? `: ${rows.filter((r) => r.error).map((r) => `${path.basename(r.name)} (${r.error})`).join(", ")}` : ""}`);
console.log("| metric | p50 | p90 | p99 | max | gate |\n|---|--:|--:|--:|--:|--:|");
for (const [k, gate] of [["geoAttr", "maxSvgGeometryAttrBytes"], ["otherAttr", "maxSvgAttrBytes"], ["elementText", "maxSvgTextBytes"], ["bytes", "maxSvgBytes"], ["useExpansions", "maxSvgUseExpansions"], ["primitives", "maxSvgPrimitives"], ["segments", "maxSvgPathSegments"], ["walked", "maxSvgWalkedElements"], ["touched", "maxSvgTouchedBytes"], ["elements", "maxSvgElements"], ["pairTests", "maxMarkerPairTests"]]) {
  console.log(`| ${k} | ${q(k, 0.5)} | ${q(k, 0.9)} | ${q(k, 0.99)} | ${q(k, 1)} | ${gateLimits[gate]} |`);
}
const gated = rows.filter((r) => r.gated);
console.log(`Current gate: ${gated.length} skipped, ${rows.filter((r) => r.approximate).length} approximated${gated.length ? `: ${gated.slice(0, 5).map((r) => `${path.basename(r.name)} (${r.gated})`).join(", ")}` : ""}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
