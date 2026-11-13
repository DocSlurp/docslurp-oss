#!/usr/bin/env node
// Whole guest command per document, as the host runs it (a fresh `node --disallow-code-generation-from-strings
// chart-export-extract.mjs` process: parent plus one worker), on one small SVG, with and without the optional compile
// cache. Reports the median wall time of N runs per mode:
//   off   no compileCacheDir
//   cold  a new, empty cache directory (the first run fills it)
//   warm  the same directory, already filled
//   ro    the filled directory made read-only (how a prepared, shared cache should be mounted)
//
//   node guest-startup.mjs <worker root> [N=15]
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [root, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 15);
const work = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "guest-startup-"));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect x="65" y="170" width="70" height="50" fill="#e45756"/><rect x="165" y="120" width="70" height="100" fill="#e45756"/><line x1="50" y1="220" x2="350" y2="220" stroke="black"/><text x="44" y="220" font-size="10">0</text><text x="44" y="170" font-size="10">1</text><text x="44" y="120" font-size="10">2</text><text x="100" y="234" font-size="10">A</text><text x="200" y="234" font-size="10">B</text></svg>';
const input = path.join(work, "in.svg"), out = path.join(work, "out.json");
writeFileSync(input, svg);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
function once(cacheDir) {
  const request = path.join(work, "req.json");
  writeFileSync(request, JSON.stringify({ kind: "svg", budgetMs: 45_000, ...(cacheDir ? { compileCacheDir: cacheDir } : {}) }));
  const t = performance.now();
  execFileSync(process.execPath, ["--disallow-code-generation-from-strings", path.join(root, "scripts/chart-export-extract.mjs"), input, request, out], { env: {} });
  return performance.now() - t;
}
const cache = path.join(work, "cache");
const rows = {};
rows.off = median(Array.from({ length: N }, () => once(null)));
rows.cold = once(cache);
rows.warm = median(Array.from({ length: N }, () => once(cache)));
const files = readdirSync(cache, { recursive: true }).filter((f) => statSync(path.join(cache, f)).isFile());
const bytes = files.reduce((n, f) => n + statSync(path.join(cache, f)).size, 0);
for (const f of readdirSync(cache, { recursive: true })) chmodSync(path.join(cache, f), statSync(path.join(cache, f)).isDirectory() ? 0o555 : 0o444);
chmodSync(cache, 0o555);
rows.ro = median(Array.from({ length: N }, () => once(cache)));
console.log(JSON.stringify({ node: process.version, runs: N, guestMs: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, +v.toFixed(1)])), cacheFiles: files.length, cacheBytes: bytes, uid: process.getuid?.() }));
