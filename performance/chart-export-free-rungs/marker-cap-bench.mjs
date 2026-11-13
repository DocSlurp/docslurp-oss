#!/usr/bin/env node
// Calibrates CHART_EXTRACT_LIMITS.maxMarkerPairTests: times svg-geometry's marker/vertex de-duplication on hostile
// packed-cell SVGs through the guest bundle, and reports the cost per pair test and per guest input.
//
//   node marker-cap-bench.mjs <worker/dist/chart-export/guest.bundle.mjs> [runs=3] [mode=calibrate|doc100]
//
// calibrate: per-pair-test cost on single SVGs (with an unlimited budget), and inputs of many near-cap SVGs.
// doc100: only the council's 100-SVG HTML input with the production budget, in a fresh process, reporting wall time,
// peak RSS and what happened to each SVG (exact, approximate, deferred, refused).
//
// Scenes (generated here, no files): V polyline vertices packed into one 3-unit cell and P markers in the next cell,
// more than 1.5 from every vertex, so no marker short-circuits and the filter runs exactly V × P pair tests.
// "html×N" puts N copies of a near-cap SVG in one HTML input, which shares one budget across its SVGs.
import { pathToFileURL } from "node:url";

const [bundle, runsArg, mode = "calibrate"] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
const { extractDeterministicVisuals, markerBudget, CHART_EXTRACT_LIMITS } = await import(pathToFileURL(bundle).href);
const budget = CHART_EXTRACT_LIMITS.maxMarkerPairTests;

function packedSvg(vertices, markers) {
  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">';
  for (let off = 0; off < vertices; off += 2500) {
    const n = Math.min(2500, vertices - off);
    const pts = ["10,90"];
    for (let i = 0; i < n - 2; i++) pts.push(`${(30 + (i % 290) / 100).toFixed(2)},${(30 + (i % 97) / 34).toFixed(2)}`);
    pts.push("90,10");
    s += `<polyline points="${pts.join(" ")}" stroke="#f00" fill="none"/>`;
  }
  s += `<defs><g id="m">${'<circle cx="34.6" cy="34.6" r="1" fill="#00f"/>'.repeat(100)}</g></defs>`;
  s += '<use href="#m"/>'.repeat(Math.ceil(markers / 100));
  for (const [v, y] of [[0, 90], [10, 50], [20, 10]]) s += `<text x="2" y="${y}">${v}</text>`;
  return s + '<text x="10" y="98">A</text><text x="50" y="98">B</text><text x="90" y="98">C</text></svg>';
}

const unlimited = () => ({ remaining: Number.MAX_SAFE_INTEGER, pairTests: 0, primitives: 0, inputsAfter: 0 });
function time(input, makeBudget = unlimited) {
  const out = [];
  for (let r = 0; r < runs; r++) {
    const b = makeBudget();
    const t0 = process.hrtime.bigint();
    const result = extractDeterministicVisuals(input, { markerBudget: b });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const approximate = result.visuals.filter((v) => v.reason === "approximate-marker-dedup").length;
    out.push({ ms, pairTests: b.pairTests, visuals: result.visuals.length, exact: result.visuals.length - approximate, approximate, deferred: result.deferred?.length ?? 0, refusals: [...new Set(result.refusals.map((x) => x.reason))] });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out[Math.floor(out.length / 2)];
}

if (mode === "doc100") {
  const near = packedSvg(2500, Math.floor(budget / 2500 / 100) * 100 - 100);
  const html = `<html><body>${near.repeat(100)}</body></html>`;
  const row = time({ kind: "html", text: html }, () => markerBudget());
  console.log(JSON.stringify({ node: process.version, mode, scene: `html × 100 near-cap SVGs (${(html.length / 1e6).toFixed(1)} MB), production budget`, ...row, peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024) }, null, 1));
  process.exit(0);
}
const rows = [];
// Baseline: the same SVG with no markers (parse + scene cost only), to subtract from the pair-test runs.
const base = time({ kind: "svg", text: packedSvg(2500, 0) });
rows.push({ scene: "svg 2.5k vertices, 0 markers", ...base });
for (const markers of [4000, 8000, 16000]) {
  const r = time({ kind: "svg", text: packedSvg(2500, markers) });
  rows.push({ scene: `svg 2.5k vertices × ${markers} markers`, ...r, nsPerPairTest: r.pairTests ? ((r.ms - base.ms) * 1e6) / r.pairTests : null });
}
// Near-cap per SVG, repeated in one input: the shared budget must stop the whole input near `budget`.
const perSvg = Math.floor(budget / 2500 / 100) * 100 - 100;
const near = packedSvg(2500, perSvg);
for (const copies of [10, 100]) {
  const html = `<html><body>${near.repeat(copies)}</body></html>`;
  rows.push({ scene: `html × ${copies} SVGs of 2.5k × ${perSvg} (${(html.length / 1e6).toFixed(1)} MB), production budget`, ...time({ kind: "html", text: html }, () => markerBudget()) });
}
console.log(JSON.stringify({ node: process.version, budget, runs, rows }, null, 1));
