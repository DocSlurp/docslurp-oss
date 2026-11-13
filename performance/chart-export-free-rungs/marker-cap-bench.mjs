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
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [bundle, mode = "doc100"] = process.argv.slice(2);
const { extractDeterministicVisuals } = await import(pathToFileURL(bundle).href);
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
const bar = (k) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect x="65" y="${170 - k % 50}" width="70" height="${50 + k % 50}" fill="#e45756"/><rect x="165" y="120" width="70" height="100" fill="#e45756"/><line x1="50" y1="220" x2="350" y2="220" stroke="black"/>${[0, 1, 2, 3, 4].map((v) => `<text x="44" y="${220 - v * 50}" text-anchor="end" font-size="10">${v}</text>`).join("")}<text x="100" y="234" text-anchor="middle" font-size="10">A</text><text x="200" y="234" text-anchor="middle" font-size="10">B</text></svg>`;

const inputs = {
  doc100: () => [{ kind: "html", text: `<html><body>${packedSvg().repeat(100)}</body></html>` }],
  batch40: () => Array.from({ length: 40 }, () => ({ kind: "svg", text: packedSvg() })),
  held17: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 17 }, (_, i) => heldSvg(i)).join("\n")}</body></html>` }],
  column: () => [{ kind: "svg", text: columnSvg() }],
  atcap200: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 200 }, (_, i) => atCapSvg(i)).join("")}</body></html>` }],
  legit: () => [{ kind: "html", text: `<html><body>${Array.from({ length: 100 }, (_, k) => bar(k)).join("")}</body></html>` }],
}[mode]();
const bytes = inputs.reduce((n, i) => n + i.text.length, 0);
const t0 = process.hrtime.bigint();
const results = inputs.map((input) => extractDeterministicVisuals(input));
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const visuals = results.flatMap((r) => r.visuals);
const skipped = {};
for (const r of results.flatMap((x) => x.refusals)) skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
const peakRssMb = Math.round(Number(/VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? 0) / 1024);
console.log(JSON.stringify({ node: process.version, mode, inputMb: +(bytes / 1e6).toFixed(2), ms: Math.round(ms), peakRssMb, exported: visuals.length, approximate: visuals.filter((v) => v.reason === "approximate-marker-dedup").length, skipped, deferred: results.reduce((n, r) => n + (r.deferred?.length ?? 0), 0) }));
