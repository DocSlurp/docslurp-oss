#!/usr/bin/env node
// Fails when any native binary under the given roots embeds an OCR engine: Tesseract, Leptonica or PaddleOCR /
// Paddle Inference. Every `*.node`, `*.so`, `*.so.*` and `*.wasm` file is read (symlinks followed once, by real
// path) and searched for the markers below. OCR runs only in the configured OCR boundary (docs/extraction/ocr.md),
// never in a binary the worker host loads.
//
//   node scripts/scan-ocr-engines.mjs [--json] [--allow <real-path-prefix>]... <root>...
//
// `--allow` exempts files under a real-path prefix, for a VM guest root that ships the pinned PP-OCR models and
// their runtime by design. Exit 0: no hit. Exit 1: hits (listed). Exit 2: usage or a root that does not exist.
import { createReadStream, realpathSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Byte strings that only an OCR engine's own code carries (symbols, namespaces, version banners, API entry points). */
export const OCR_ENGINE_MARKERS = [
  "TessBaseAPI",
  "tesseract::",
  "leptonica-",
  "pixReadMem",
  "paddle::",
  "paddle_infer",
  "PaddleOCR",
];

const NATIVE = /\.(node|wasm|so)$|\.so\.[0-9.]+$/;
const OVERLAP = Math.max(...OCR_ENGINE_MARKERS.map((marker) => marker.length));

/** The markers `file` contains, read in chunks so large binaries are never held in memory at once. */
export async function markersIn(file) {
  const needles = OCR_ENGINE_MARKERS.map((marker) => Buffer.from(marker, "latin1"));
  const found = new Set();
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const window = tail.length ? Buffer.concat([tail, chunk]) : chunk;
    needles.forEach((needle, index) => { if (window.includes(needle)) found.add(OCR_ENGINE_MARKERS[index]); });
    tail = window.subarray(Math.max(0, window.length - OVERLAP));
  }
  return [...found];
}

/** Every native binary under `roots`, once per real path, with the markers it carries. */
export async function scanForOcrEngines(roots, { allow = [] } = {}) {
  const seen = new Set();
  const files = [];
  const visit = async (entry) => {
    let real;
    try { real = realpathSync(entry); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    const info = await stat(real).catch(() => null);
    if (!info) return;
    if (info.isDirectory()) {
      // /proc, /sys and /dev are not files on disk.
      if (["/proc", "/sys", "/dev"].includes(real)) return;
      const names = await readdir(real).catch(() => []);
      for (const name of names) await visit(path.join(real, name));
    } else if (info.isFile() && NATIVE.test(path.basename(real))) {
      files.push(real);
    }
  };
  for (const root of roots) {
    if (!(await lstat(root).catch(() => null))) throw new Error(`scan root does not exist: ${root}`);
    await visit(root);
  }
  const hits = [];
  for (const file of files.sort()) {
    if (allow.some((prefix) => file === prefix || file.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) continue;
    const markers = await markersIn(file);
    if (markers.length) hits.push({ file, markers });
  }
  return { scanned: files.length, hits };
}

async function main(argv) {
  const roots = [];
  const allow = [];
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--allow") allow.push(path.resolve(argv[++i] ?? ""));
    else roots.push(argv[i]);
  }
  if (roots.length === 0) {
    console.error("usage: scan-ocr-engines.mjs [--json] [--allow <real-path-prefix>]... <root>...");
    return 2;
  }
  let result;
  try {
    result = await scanForOcrEngines(roots, { allow });
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (json) console.log(JSON.stringify({ roots, allow, markers: OCR_ENGINE_MARKERS, ...result }, null, 2));
  else {
    console.log(`[scan-ocr-engines] roots=${roots.join(",")} scanned=${result.scanned} native binaries hits=${result.hits.length}`);
    for (const hit of result.hits) console.log(`[scan-ocr-engines] HIT ${hit.file} markers=${hit.markers.join(",")}`);
  }
  return result.hits.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
