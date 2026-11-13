#!/usr/bin/env node
// Cost of the guest's per-input worker containment: spawning a worker_thread that imports the guest bundle and runs one
// tiny extraction, against running the same extraction on the main thread. Median of N, in a fresh process.
//
//   node --disallow-code-generation-from-strings worker-startup.mjs <worker root> [N=15] [compile cache dir]
// With a cache directory each worker gets `compileCacheDir`, as the guest passes it.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const [root, nArg, cacheDir] = process.argv.slice(2);
const N = Number(nArg ?? 15);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect x="65" y="170" width="70" height="50" fill="#e45756"/><rect x="165" y="120" width="70" height="100" fill="#e45756"/><line x1="50" y1="220" x2="350" y2="220" stroke="black"/><text x="44" y="220" font-size="10">0</text><text x="44" y="170" font-size="10">1</text><text x="44" y="120" font-size="10">2</text><text x="100" y="234" font-size="10">A</text><text x="200" y="234" font-size="10">B</text></svg>';
const file = path.join(tmpdir(), "startup.svg");
writeFileSync(file, svg);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const t0 = performance.now();
const { extractDeterministicVisuals } = await import(pathToFileURL(path.join(root, "dist/chart-export/guest.bundle.mjs")).href);
const importMs = performance.now() - t0;
const inline = [];
for (let k = 0; k < N; k++) { const t = performance.now(); extractDeterministicVisuals({ kind: "svg", text: svg }); inline.push(performance.now() - t); }
const contained = [];
for (let k = 0; k < N; k++) {
  const t = performance.now();
  await new Promise((resolve, reject) => {
    const w = new Worker(new URL(pathToFileURL(path.join(root, "scripts/chart-export-worker.mjs"))), { resourceLimits: { maxOldGenerationSizeMb: 1536, maxYoungGenerationSizeMb: 64 }, env: {}, workerData: { compileCacheDir: cacheDir ?? null } });
    w.on("message", (m) => { if (m.t === "result") { w.terminate(); resolve(); } });
    w.on("error", reject);
    w.postMessage({ path: file, kind: "svg", packaged: false, options: { diagrams: true }, skip: [], deadline: Date.now() + 45_000 });
  });
  contained.push(performance.now() - t);
}
console.log(JSON.stringify({ node: process.version, compileCache: cacheDir ?? null, bundleImportMs: Math.round(importMs), inlineExtractMs: +median(inline).toFixed(1), workerSpawnImportExtractMs: +median(contained).toFixed(1), perInputOverheadMs: +(median(contained) - median(inline)).toFixed(1), runs: N }));
