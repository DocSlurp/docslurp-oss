import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * No OCR engine in the worker host (docs/extraction/ocr.md, "Tesseract"):
 * 1. binaries, packages and language data: none in any worker image (the Dockerfile checks below);
 * 2. native code: no installed `*.node`, `*.so*` or `*.wasm` embeds Tesseract, Leptonica or PaddleOCR (the scan below;
 *    the image build runs the same scan, scripts/scan-ocr-engines.mjs, over the whole image);
 * 3. the pure-Python unstructured-pytesseract wrapper: no binary, and unstructured runs text-layer only.
 */
const worker = fileURLToPath(new URL("../..", import.meta.url));
const repo = path.resolve(worker, "..");

describe("No OCR engine is installed or linked in the worker", () => {
  it("installs no tesseract package or language data in any worker image", () => {
    const dockerfiles = readdirSync(worker).filter((name) => name.startsWith("Dockerfile"));
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const name of dockerfiles) {
      const lines = readFileSync(path.join(worker, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("#"));
      expect(lines.filter((line) => /tesseract|tessdata|leptonica|paddle/i.test(line)), name).toEqual([]);
    }
  });

  it("depends on no package known to embed an OCR engine", () => {
    const manifest = JSON.parse(readFileSync(path.join(worker, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies });
    expect(names.filter((name) => /kreuzberg|liteparse|tesseract|paddle/i.test(name))).toEqual([]);
    expect(readFileSync(path.join(repo, "pnpm-lock.yaml"), "utf8")).not.toMatch(/@kreuzberg\/|@llamaindex\/liteparse|tesseract\.js/);
  });

  type Scan = {
    scanForOcrEngines(roots: string[]): Promise<{ scanned: number; hits: Array<{ file: string; evidence: string[] }>; unverified: Array<{ file: string }> }>;
    inspectObject(file: string): { verdict: "hit" | "clean" | "unverified"; stripped: boolean; evidence: string[] } | null;
  };
  const scanner = async () => (await import(pathToFileURL(path.join(repo, "scripts", "scan-ocr-engines.mjs")).href)) as Scan;

  it("finds no Tesseract, Leptonica or PaddleOCR linkage in any installed ELF or wasm object", async () => {
    // Every native object the installed workspace can load: the pnpm store the worker resolves from, and the worker's
    // and repository's own node_modules. A hit names the file and evidence; remove that dependency (it would run OCR on
    // customer pixels in the worker host) instead of allow-listing it here. Unverified (stripped) objects are listed.
    const store = path.join(repo, "node_modules", ".pnpm");
    const roots = [store, path.join(worker, "node_modules")].filter((root) => statSync(root, { throwIfNoEntry: false }));
    expect(roots.length).toBeGreaterThan(0);
    const { scanned, hits, unverified } = await (await scanner()).scanForOcrEngines(roots);
    if (unverified.length) console.warn(`[no-tesseract] ${unverified.length} stripped objects unverified by symbols: ${unverified.map((entry) => path.basename(entry.file)).join(", ")}`);
    expect(scanned).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  }, 600_000);

  // The scanner's own detection, on minimal ELF64 objects built here byte by byte, so the fixture never depends on a
  // compiler banner or a system binary on the runner (and no third-party binary lives in git).
  const elf64 = (rodata: string, symbols?: string[]): Buffer => {
    const names = ["", ".shstrtab", ".rodata", ...(symbols ? [".symtab", ".strtab"] : [])];
    const shstrtab = Buffer.from(`${names.join("\0")}\0`, "latin1");
    const nameOffset = (name: string) => shstrtab.indexOf(Buffer.from(`${name}\0`, "latin1"), 1);
    const strtab = Buffer.from(`\0${(symbols ?? []).map((name) => `${name}\0`).join("")}`, "latin1");
    const symtab = Buffer.alloc(24 * ((symbols?.length ?? 0) + 1));
    let at = 1;
    (symbols ?? []).forEach((name, index) => { symtab.writeUInt32LE(at, 24 * (index + 1)); at += name.length + 1; });
    const bodies = [shstrtab, Buffer.from(rodata, "latin1"), ...(symbols ? [symtab, strtab] : [])];
    const offsets: number[] = [];
    let cursor = 64;
    for (const body of bodies) { offsets.push(cursor); cursor += body.length; }
    const shoff = cursor + ((8 - (cursor % 8)) % 8);
    const out = Buffer.alloc(shoff + 64 * names.length);
    out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0); // ELF, 64-bit, little endian, version 1
    out.writeUInt16LE(1, 0x10); // ET_REL
    out.writeUInt16LE(62, 0x12); // x86-64
    out.writeUInt32LE(1, 0x14);
    out.writeBigUInt64LE(BigInt(shoff), 0x28);
    out.writeUInt16LE(64, 0x34);
    out.writeUInt16LE(64, 0x3a);
    out.writeUInt16LE(names.length, 0x3c);
    out.writeUInt16LE(1, 0x3e); // .shstrtab
    bodies.forEach((body, index) => body.copy(out, offsets[index]));
    // Section headers after the null entry: .shstrtab (STRTAB), .rodata (PROGBITS), .symtab (SYMTAB -> .strtab), .strtab.
    const types = [3, 1, 2, 3];
    bodies.forEach((body, index) => {
      const o = shoff + 64 * (index + 1);
      out.writeUInt32LE(nameOffset(names[index + 1]), o);
      out.writeUInt32LE(types[index], o + 4);
      out.writeBigUInt64LE(BigInt(offsets[index]), o + 0x18);
      out.writeBigUInt64LE(BigInt(body.length), o + 0x20);
      if (types[index] === 2) { out.writeUInt32LE(4, o + 0x28); out.writeBigUInt64LE(24n, o + 0x38); }
    });
    return out;
  };

  it("detects a statically linked engine by its banner in a stripped object, and never calls a stripped object clean", async () => {
    const { inspectObject } = await scanner();
    const dir = mkdtempSync(path.join(tmpdir(), "ocr-scan-"));
    const write = (name: string, bytes: Buffer | string) => { const file = path.join(dir, name); writeFileSync(file, bytes); return file; };
    try {
      // Stripped and innocent: no evidence, but absence of symbols proves nothing.
      const plain = inspectObject(write("plain", elf64("GCC: (Debian 14.2.0) 14.2.0\0libfoo 1.0\0")))!;
      expect(plain).toMatchObject({ stripped: true, verdict: "unverified", evidence: [] });
      // Stripped, with the version banner a static link leaves in .rodata: a hit.
      const banner = inspectObject(write("banner", elf64("GCC: (Debian 14.2.0) 14.2.0\0tesseract 5.5.2\0")))!;
      expect(banner).toMatchObject({ stripped: true, verdict: "hit" });
      expect(banner.evidence.join(" ")).toMatch(/tesseract 5\.5/);
      // Symbol table present: searched; innocent is clean, an engine symbol is a hit.
      const clean = inspectObject(write("clean", elf64("libfoo 1.0\0", ["main", "foo_init"])))!;
      expect(clean).toMatchObject({ stripped: false, verdict: "clean", evidence: [] });
      const symbol = inspectObject(write("symbol", elf64("libfoo 1.0\0", ["main", "_ZN9tesseract11TessBaseAPI4InitEv"])))!;
      expect(symbol).toMatchObject({ stripped: false, verdict: "hit" });
      expect(symbol.evidence.join(" ")).toMatch(/symtab: 1 symbols/);
      // Not an object at all (a JS file mentioning Tesseract): never inspected.
      expect(inspectObject(write("notes.js", "// TessBaseAPI tesseract 5.5.2 Leptonica-1.84\n".repeat(8)))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls unstructured only with the text-layer strategy", () => {
    const script = readFileSync(path.join(worker, "scripts", "unstructured_partition.py"), "utf8")
      .split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
    expect(script).toMatch(/choices=\["fast"\]/);
    expect(script).not.toMatch(/hi_res|ocr_only|pytesseract/);
  });

  it("invokes no tesseract binary from the evaluation harness", () => {
    const dir = path.join(worker, "test", "mixed-pdf-eval");
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".py"))) {
      const code = readFileSync(path.join(dir, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
      expect(code, name).not.toMatch(/["']tesseract["']|which\(["']tesseract/);
    }
  });
});
