#!/usr/bin/env node
// PDF vector-chart yield of the free rungs with and without the figure's words (the PDF-figure seam).
//
//   node pdf-figure-words.mjs <worker dir> <pdftotext> <pdf> <doppler images dir> [margin pt=60] [truth.json]
//
// For each SVG figure Doppler wrote (manifest.jsonl, `doppler-images/3`), the words on its page inside the figure's
// bbox grown by <margin> points (axis ticks and labels sit outside the vector cluster) are passed as word boxes. The
// figure SVG's viewBox is in page points, y down, the same space as `pdftotext -bbox`. A word box at least twice as tall
// as wide (and longer than one character) is taken as rotated. Words on one line closer than half their height are
// merged into a run (a text layer's line: titles and multi-word labels stay whole). With truth.json (gen_pdf_truth.py),
// each chart's categories and values are compared to the data it was drawn from. Prints JSON lines and a summary.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [workerDir, pdftotext, pdf, imagesDir, marginArg, truthPath] = process.argv.slice(2);
// DUMP_DIR: also write each figure's SVG and words (<n>.svg, <n>.words.json) for the in-VM probes (probe-doppler-node).
const dumpDir = process.env.DUMP_DIR;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });
const truth = truthPath ? JSON.parse(readFileSync(truthPath, "utf8")) : null;

function runs(words) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    const h = w.y1 - w.y0;
    if (last && Math.abs(last.y0 - w.y0) < 0.5 && Math.abs(last.y1 - w.y1) < 0.5 && w.x0 - last.x1 >= 0 && w.x0 - last.x1 < 0.5 * h) {
      last.text += ` ${w.text}`; last.x1 = w.x1;
    } else out.push({ ...w });
  }
  return out;
}

/** Categories and values against the data the chart was drawn from: share of points within 2% of the value range. */
function score(spec, t) {
  if (!spec || !t) return null;
  const all = Object.values(t.series).flat();
  const tol = 0.02 * (Math.max(...all) - Math.min(0, ...all));
  let matched = 0, total = 0;
  for (const [name, values] of Object.entries(t.series)) {
    const s = spec.series.find((x) => x.name === name) ?? (Object.keys(t.series).length === 1 ? spec.series[0] : null);
    t.categories.forEach((cat, i) => {
      total += 1;
      const p = s?.points.find((pt) => String(t.type === "hbar" ? pt.y : pt.x) === cat);
      const v = p ? Number(t.type === "hbar" ? p.x : p.y) : NaN;
      if (Math.abs(v - values[i]) <= tol) matched += 1;
    });
  }
  return { matched, total };
}
const margin = Number(marginArg ?? 60);
const { extractDeterministicVisuals } = await import(pathToFileURL(path.join(workerDir, "dist/chart-export/extractors/index.js")).href);

const wordsByPage = new Map();
function pageWords(page) {
  if (!wordsByPage.has(page)) {
    const xml = execFileSync(pdftotext, ["-bbox", "-f", String(page), "-l", String(page), pdf, "-"], { encoding: "utf8" });
    const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    wordsByPage.set(page, [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], text: unescape(m[5]) })));
  }
  return wordsByPage.get(page);
}

const rows = [];
for (const line of readFileSync(path.join(imagesDir, "manifest.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const rec = JSON.parse(line);
  if (rec.type !== "image" || rec.format !== "svg" || !rec.path) continue;
  const svg = readFileSync(path.join(imagesDir, rec.path), "utf8");
  const [x0, y0, x1, y1] = rec.bbox;
  const words = runs(pageWords(rec.page)
    .filter((w) => w.x1 >= x0 - margin && w.x0 <= x1 + margin && w.y1 >= y0 - margin && w.y0 <= y1 + margin))
    .map((w) => ({ ...w, ...(w.y1 - w.y0 >= 2 * (w.x1 - w.x0) && w.text.length > 1 ? { rotated: true } : {}) }));
  if (dumpDir) {
    const tag = `${path.basename(pdf, ".pdf")}-${rec.id}`;
    writeFileSync(path.join(dumpDir, `${tag}.svg`), svg);
    writeFileSync(path.join(dumpDir, `${tag}.words.json`), JSON.stringify(words));
  }
  const t0 = performance.now();
  const bare = extractDeterministicVisuals({ kind: "svg", text: svg });
  const t1 = performance.now();
  const placed = extractDeterministicVisuals({ kind: "svg", text: svg, words });
  const t2 = performance.now();
  const spec = placed.visuals[0]?.spec ?? null;
  rows.push({
    figure: `${path.basename(pdf)}#${rec.id}`, page: rec.page, words: words.length,
    withoutWords: bare.visuals.filter((v) => v.spec).length, withWords: placed.visuals.filter((v) => v.spec).length,
    chartType: spec?.chartType ?? null, series: spec?.series?.length ?? 0, points: spec?.series?.reduce((n, s) => n + s.points.length, 0) ?? 0,
    title: spec?.title ?? null, reason: placed.visuals[0]?.reason ?? placed.refusals[0]?.reason ?? null,
    msWithout: +(t1 - t0).toFixed(1), msWith: +(t2 - t1).toFixed(1),
    accuracy: score(spec, truth?.find((t) => t.page === rec.page)),
  });
}
for (const row of rows) console.log(JSON.stringify(row));
console.log(JSON.stringify({ summary: true, figures: rows.length, chartsWithoutWords: rows.reduce((n, r) => n + r.withoutWords, 0), chartsWithWords: rows.reduce((n, r) => n + r.withWords, 0),
  ...(truth ? { truthCharts: truth.length, pointsMatched: rows.reduce((n, r) => n + (r.accuracy?.matched ?? 0), 0), pointsTotal: truth.reduce((n, t) => n + Object.values(t.series).flat().length, 0) } : {}) }));
