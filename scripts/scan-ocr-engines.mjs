#!/usr/bin/env node
// Finds OCR engines (Tesseract, Leptonica, PaddleOCR / Paddle Inference) linked into native objects under the given
// roots. Only ELF and WebAssembly objects are inspected, found by their magic bytes whatever their file name, so docs,
// JavaScript and error strings never count. For each object:
//   - linkage: DT_NEEDED entries naming libtesseract, liblept or a Paddle library;
//   - symbols: every name in .dynsym and .symtab (wasm: the name section, imports and exports);
//   - banners: version strings in .rodata / .comment / data (`tesseract 5.`, `Leptonica-1.`), and embedded tessdata.
// Verdicts: `hit` (any evidence), `clean` (symbol table present and searched, no evidence), `unverified` (stripped or
// unparseable: no evidence found, but absence of symbols proves nothing). A stripped object is never reported clean;
// corroborate it separately (the owning package's dependencies and build features) and say so.
//
//   node scripts/scan-ocr-engines.mjs [--json] [--fail-on-unverified] [--allow-sha256-file <json>]... <root>...
//
// `--allow-sha256-file` reads every `sha256` value in a JSON file (such as a pinned model manifest) and exempts objects
// with exactly those digests. Exit 0: no hit (and no unverified object with --fail-on-unverified). Exit 1: otherwise.
// Exit 2: usage, or a root that does not exist.
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NEEDED = /(^|\/)lib(tesseract|lept|leptonica|paddle[\w-]*|paddle_inference|ppocr)[\w.-]*\.so/i;
const SYMBOL = /(TessBaseAPI|tesseract|_ZN9tesseract|^pix(Read|Write|Create|Destroy)|leptonica|^lept_|paddle_infer|_ZN6paddle|PaddleOCR|paddleocr)/i;
const BANNER = /(tesseract[ _-]v?[3-6]\.\d+|tesseract ocr engine|leptonica-1\.\d+|\.traineddata|paddle_inference|PaddleOCR|paddle::framework)/i;
const MAX_STRING_SCAN = 512 * 1024 * 1024;

/** Every `sha256` string value anywhere in a JSON document. */
export function sha256ValuesIn(json) {
  const found = new Set();
  const walk = (value, key) => {
    if (typeof value === "string" && /sha256/i.test(key ?? "") && /^[0-9a-f]{64}$/i.test(value)) found.add(value.toLowerCase());
    else if (Array.isArray(value)) value.forEach((entry) => walk(entry, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(json);
  return found;
}

function readHead(file, length) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally { closeSync(fd); }
}

/** "elf", "wasm" or null, from the first bytes of a file. */
export function objectKind(file) {
  const head = readHead(file, 4);
  if (head.length === 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "elf";
  if (head.length === 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d) return "wasm";
  return null;
}

/** Printable ASCII runs of at least `min` bytes, for banner search. */
function* printableRuns(buffer, min = 6) {
  let start = -1;
  for (let i = 0; i <= buffer.length; i += 1) {
    const byte = i < buffer.length ? buffer[i] : 0;
    if (byte >= 0x20 && byte < 0x7f) { if (start < 0) start = i; }
    else if (start >= 0) { if (i - start >= min) yield buffer.toString("latin1", start, i); start = -1; }
  }
}

function cstring(buffer, offset) {
  if (offset < 0 || offset >= buffer.length) return "";
  const end = buffer.indexOf(0, offset);
  return buffer.toString("latin1", offset, end < 0 ? buffer.length : end);
}

/** Section table, NEEDED entries, symbol names and banner-bearing section strings of an ELF object. */
export function inspectElf(buffer) {
  const cls = buffer[4]; // 1 = 32-bit, 2 = 64-bit
  const little = buffer[5] === 1;
  if (cls !== 1 && cls !== 2) throw new Error("unknown ELF class");
  const is64 = cls === 2;
  const u16 = (o) => (little ? buffer.readUInt16LE(o) : buffer.readUInt16BE(o));
  const u32 = (o) => (little ? buffer.readUInt32LE(o) : buffer.readUInt32BE(o));
  const word = (o) => (is64 ? Number(little ? buffer.readBigUInt64LE(o) : buffer.readBigUInt64BE(o)) : u32(o));
  const shoff = word(is64 ? 0x28 : 0x20);
  const shentsize = u16(is64 ? 0x3a : 0x2e);
  const shnum = u16(is64 ? 0x3c : 0x30);
  const shstrndx = u16(is64 ? 0x3e : 0x32);
  if (!shoff || !shnum || shoff + shnum * shentsize > buffer.length) throw new Error("no section header table");
  const sections = [];
  for (let i = 0; i < shnum; i += 1) {
    const o = shoff + i * shentsize;
    sections.push({
      nameOffset: u32(o), type: u32(o + 4),
      offset: word(is64 ? o + 0x18 : o + 0x10), size: word(is64 ? o + 0x20 : o + 0x14),
      link: u32(is64 ? o + 0x28 : o + 0x18), entsize: word(is64 ? o + 0x38 : o + 0x24),
    });
  }
  const names = sections[shstrndx];
  for (const section of sections) section.name = names ? cstring(buffer, names.offset + section.nameOffset) : "";
  const slice = (section) => buffer.subarray(section.offset, Math.min(buffer.length, section.offset + section.size));
  const needed = [];
  const symbols = { dynsym: [], symtab: [] };
  for (const section of sections) {
    if (section.type === 6 /* SHT_DYNAMIC */) {
      const strtab = sections[section.link];
      const entry = is64 ? 16 : 8;
      for (let o = section.offset; o + entry <= section.offset + section.size && o + entry <= buffer.length; o += entry) {
        const tag = is64 ? Number(little ? buffer.readBigInt64LE(o) : buffer.readBigInt64BE(o)) : u32(o);
        if (tag === 0) break;
        if (tag === 1 /* DT_NEEDED */ && strtab) needed.push(cstring(buffer, strtab.offset + word(o + (is64 ? 8 : 4))));
      }
    }
    if (section.type === 11 /* SHT_DYNSYM */ || section.type === 2 /* SHT_SYMTAB */) {
      const strtab = sections[section.link];
      const entry = section.entsize || (is64 ? 24 : 16);
      const list = section.type === 11 ? symbols.dynsym : symbols.symtab;
      for (let o = section.offset; o + entry <= section.offset + section.size && o + entry <= buffer.length; o += entry) {
        const name = strtab ? cstring(buffer, strtab.offset + u32(o)) : "";
        if (name) list.push(name);
      }
    }
  }
  const bannerSections = sections.filter((s) => /^\.(rodata|comment|data|data\.rel\.ro|lrodata|note)/.test(s.name) && s.type !== 8 /* NOBITS */);
  const sizes = Object.fromEntries(sections.filter((s) => /^\.(text|rodata|data|symtab|dynsym)$/.test(s.name)).map((s) => [s.name, s.size]));
  return { needed, symbols, bannerText: bannerSections.map(slice), hasSymtab: sections.some((s) => s.type === 2), sizes };
}

/** Import, export and name-section names, and data/custom section bytes, of a wasm module. */
export function inspectWasm(buffer) {
  let o = 8;
  const leb = () => { let result = 0, shift = 0, byte; do { byte = buffer[o++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80); return result; };
  const name = () => { const n = leb(); const s = buffer.toString("utf8", o, o + n); o += n; return s; };
  const names = [];
  const dataSections = [];
  let hasNames = false;
  while (o < buffer.length) {
    const id = buffer[o++];
    const size = leb();
    const end = o + size;
    if (id === 0) {
      const custom = name();
      if (custom === "name") hasNames = true;
      dataSections.push(buffer.subarray(o, end));
    } else if (id === 2) { // imports: module and field names, read as printable runs
      for (const run of printableRuns(buffer.subarray(o, end), 3)) names.push(run);
    } else if (id === 7) { // exports
      const count = leb();
      for (let i = 0; i < count && o < end; i += 1) { names.push(name()); const kind = buffer[o++]; void kind; leb(); }
    } else if (id === 11) dataSections.push(buffer.subarray(o, end));
    o = end;
  }
  return { needed: [], symbols: { exports: names }, bannerText: dataSections, hasSymtab: hasNames, sizes: { bytes: buffer.length } };
}

/** The verdict for one object file. */
export function inspectObject(file) {
  const kind = objectKind(file);
  if (!kind) return null;
  const buffer = readFileSync(file);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  let facts;
  try {
    facts = kind === "elf" ? inspectElf(buffer) : inspectWasm(buffer);
  } catch (error) {
    // Unparseable: still search the raw bytes for banners, but never call the object clean.
    facts = { needed: [], symbols: {}, bannerText: [buffer.subarray(0, MAX_STRING_SCAN)], hasSymtab: false, sizes: { bytes: buffer.length }, parseError: error.message };
  }
  const evidence = [];
  for (const entry of facts.needed) if (NEEDED.test(entry)) evidence.push(`NEEDED ${entry}`);
  for (const [table, list] of Object.entries(facts.symbols)) {
    const matched = list.filter((symbol) => SYMBOL.test(symbol));
    if (matched.length) evidence.push(`${table}: ${matched.length} symbols (${matched.slice(0, 3).join(", ")})`);
  }
  const banners = new Set();
  for (const bytes of facts.bannerText) {
    for (const run of printableRuns(bytes)) {
      const m = BANNER.exec(run);
      if (m && ![...banners].some((seen) => seen.toLowerCase() === m[0].toLowerCase())) banners.add(m[0]);
      if (banners.size >= 12) break;
    }
  }
  if (banners.size) evidence.push(`banners: ${[...banners].join(" | ")}`);
  const verdict = evidence.length ? "hit" : facts.hasSymtab && !facts.parseError ? "clean" : "unverified";
  return {
    file, kind, sha256, verdict, evidence, stripped: !facts.hasSymtab, needed: facts.needed, sizes: facts.sizes,
    ...(facts.parseError ? { parseError: facts.parseError } : {}),
  };
}

/** Every ELF and wasm object under `roots`, once per real path, with its verdict. */
export async function scanForOcrEngines(roots, { allowSha256 = new Set() } = {}) {
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
      if (["/proc", "/sys", "/dev", "/run"].includes(real)) return;
      for (const name of await readdir(real).catch(() => [])) await visit(path.join(real, name));
    } else if (info.isFile() && info.size >= 64) files.push(real);
  };
  for (const root of roots) {
    if (!(await lstat(root).catch(() => null))) throw new Error(`scan root does not exist: ${root}`);
    await visit(root);
  }
  const objects = [];
  for (const file of files.sort()) {
    let result;
    try { result = inspectObject(file); } catch { continue; }
    if (!result) continue;
    if (allowSha256.has(result.sha256)) result.verdict = "allowed-pinned";
    objects.push(result);
  }
  const count = (verdict) => objects.filter((entry) => entry.verdict === verdict).length;
  return {
    scanned: objects.length, hits: objects.filter((entry) => entry.verdict === "hit"),
    unverified: objects.filter((entry) => entry.verdict === "unverified"),
    counts: { hit: count("hit"), clean: count("clean"), unverified: count("unverified"), allowedPinned: count("allowed-pinned") },
    objects,
  };
}

async function main(argv) {
  const roots = [];
  const allowSha256 = new Set();
  let json = false;
  let failOnUnverified = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--json") json = true;
    else if (argv[i] === "--fail-on-unverified") failOnUnverified = true;
    else if (argv[i] === "--allow-sha256-file") for (const hash of sha256ValuesIn(JSON.parse(readFileSync(argv[++i] ?? "", "utf8")))) allowSha256.add(hash);
    else roots.push(argv[i]);
  }
  if (roots.length === 0) {
    console.error("usage: scan-ocr-engines.mjs [--json] [--fail-on-unverified] [--allow-sha256-file <json>]... <root>...");
    return 2;
  }
  let result;
  try { result = await scanForOcrEngines(roots, { allowSha256 }); } catch (error) { console.error(error.message); return 2; }
  if (json) console.log(JSON.stringify({ roots, ...result }, null, 2));
  else {
    const c = result.counts;
    console.log(`[scan-ocr-engines] roots=${roots.join(",")} objects=${result.scanned} hit=${c.hit} clean=${c.clean} unverified=${c.unverified} allowed-pinned=${c.allowedPinned}`);
    for (const hit of result.hits) console.log(`[scan-ocr-engines] HIT ${hit.file} ${hit.evidence.join("; ")}`);
    for (const entry of result.unverified) console.log(`[scan-ocr-engines] UNVERIFIED ${entry.file} stripped=${entry.stripped}${entry.parseError ? ` parse-error=${entry.parseError}` : ""} needed=${entry.needed.join(",") || "none"}`);
  }
  return result.hits.length || (failOnUnverified && result.unverified.length) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
