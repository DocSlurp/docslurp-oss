import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  // The scanner's own detection, on synthetic objects derived from a system binary (no third-party binary in git).
  it.runIf(process.platform === "linux")("detects a statically linked engine by its banner in a stripped object, and never calls a stripped object clean", async () => {
    const { inspectObject } = await scanner();
    const original = ["/usr/bin/true", "/bin/true"].find((candidate) => statSync(candidate, { throwIfNoEntry: false }));
    if (!original) return;
    const dir = mkdtempSync(path.join(tmpdir(), "ocr-scan-"));
    try {
      const plain = path.join(dir, "plain");
      copyFileSync(original, plain);
      const baseline = inspectObject(plain)!;
      expect(baseline.verdict).not.toBe("hit");
      if (baseline.stripped) expect(baseline.verdict).toBe("unverified");
      // Write a Tesseract version banner over the start of .comment (or .rodata), as a static link leaves one.
      const bytes = readFileSync(plain);
      const banner = Buffer.from("tesseract 5.5.2\0", "latin1");
      const at = bytes.indexOf(Buffer.from("GCC: ", "latin1"));
      expect(at).toBeGreaterThan(0);
      banner.copy(bytes, at);
      const patched = path.join(dir, "patched");
      writeFileSync(patched, bytes);
      const hit = inspectObject(patched)!;
      expect(hit.verdict).toBe("hit");
      expect(hit.evidence.join(" ")).toMatch(/tesseract 5\.5/);
      // Not an object at all (a JS file mentioning Tesseract): never inspected.
      const js = path.join(dir, "notes.js");
      writeFileSync(js, "// TessBaseAPI tesseract 5.5.2 Leptonica-1.84\n".repeat(8));
      expect(inspectObject(js)).toBeNull();
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
