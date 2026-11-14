#!/usr/bin/env node
// Whole guest command per document, as the host runs it (a fresh `node --disallow-code-generation-from-strings
// chart-export-extract.mjs` process: parent plus one worker), on one small SVG, with and without the optional compile
// cache. The guest only uses a cache it cannot write, so the cache is prepared ahead of time
// (scripts/chart-guest-compile-cache.mjs) and the guest runs on a read-only bind mount of it, in its own mount namespace
// (`unshare -m`, plus `-r` when not root). Every mode runs through the same wrapper. Median wall time of N runs:
//   off        no compileCacheDir
//   writable   the prepared directory, writable: the guest refuses it and runs without (should match off)
//   ro         the prepared directory on a read-only mount: the cache is used
//
//   node guest-startup.mjs <worker root> [N=15]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const [root, nArg] = process.argv.slice(2);
const N = Number(nArg ?? 15);
const work = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "guest-startup-"));
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="260"><rect x="65" y="170" width="70" height="50" fill="#e45756"/><rect x="165" y="120" width="70" height="100" fill="#e45756"/><line x1="50" y1="220" x2="350" y2="220" stroke="black"/><text x="44" y="220" font-size="10">0</text><text x="44" y="170" font-size="10">1</text><text x="44" y="120" font-size="10">2</text><text x="100" y="234" font-size="10">A</text><text x="200" y="234" font-size="10">B</text></svg>';
const input = path.join(work, "in.svg"), out = path.join(work, "out.json"), errFile = path.join(work, "err");
writeFileSync(input, svg);
const cache = path.join(work, "cache");
const asRoot = process.getuid?.() === 0;
// Node keys the cache by uid: prepared as the user the guest runs as (uid 0 inside `unshare -r` when not root).
execFileSync(asRoot ? process.execPath : "unshare", [...(asRoot ? [] : ["-r", process.execPath]), "--disallow-code-generation-from-strings", path.join(root, "scripts/chart-guest-compile-cache.mjs"), cache], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
const files = readdirSync(cache, { recursive: true }).filter((f) => statSync(path.join(cache, f)).isFile());
const bytes = files.reduce((n, f) => n + statSync(path.join(cache, f)).size, 0);
const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
function once(mode) {
  const request = path.join(work, "req.json");
  writeFileSync(request, JSON.stringify({ kind: "svg", budgetMs: 45_000, ...(mode === "off" ? {} : { compileCacheDir: cache }) }));
  const ro = mode === "ro" ? `mount --bind ${q(cache)} ${q(cache)} && mount -o remount,bind,ro ${q(cache)} && ` : "";
  const script = `${ro}exec ${q(process.execPath)} --disallow-code-generation-from-strings ${q(path.join(root, "scripts/chart-export-extract.mjs"))} ${q(input)} ${q(request)} ${q(out)} 2>${q(errFile)}`;
  const t = performance.now();
  execFileSync("unshare", [...(asRoot ? [] : ["-r"]), "-m", "sh", "-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  return performance.now() - t;
}
const rows = {}, logs = {};
for (const mode of ["off", "writable", "ro"]) {
  once(mode); // warm the page cache
  rows[mode] = +median(Array.from({ length: N }, () => once(mode))).toFixed(1);
  logs[mode] = readFileSync(errFile, "utf8").trim() || null;
}
console.log(JSON.stringify({ node: process.version, runs: N, guestMs: rows, stderr: logs, cacheFiles: files.length, cacheBytes: bytes, uid: process.getuid?.() }));
