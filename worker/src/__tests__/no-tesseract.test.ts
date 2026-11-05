import { readdirSync, readFileSync, statSync } from "node:fs";
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

  it("finds no Tesseract, Leptonica or PaddleOCR code in any installed native binary", async () => {
    // Every native binary the installed workspace can load: the pnpm store the worker resolves from, and the worker's
    // and repository's own node_modules. A hit names the file and markers; remove that dependency (it would run OCR on
    // customer pixels in the worker host) instead of allow-listing it here.
    const store = path.join(repo, "node_modules", ".pnpm");
    const roots = [store, path.join(worker, "node_modules")].filter((root) => statSync(root, { throwIfNoEntry: false }));
    expect(roots.length).toBeGreaterThan(0);
    const scanner = pathToFileURL(path.join(repo, "scripts", "scan-ocr-engines.mjs")).href;
    const { scanForOcrEngines } = (await import(scanner)) as {
      scanForOcrEngines(roots: string[]): Promise<{ scanned: number; hits: Array<{ file: string; markers: string[] }> }>;
    };
    const { scanned, hits } = await scanForOcrEngines(roots);
    expect(scanned).toBeGreaterThan(0);
    expect(hits).toEqual([]);
  }, 600_000);

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
