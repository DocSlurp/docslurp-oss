import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Tesseract in the worker (docs/extraction/ocr.md, "Tesseract"), three separate cases:
 * 1. binaries, packages and language data: none in any worker image (the Dockerfile checks below);
 * 2. statically linked into two native addons, disabled: pinned by the addon list below, so a new copy fails here;
 * 3. the pure-Python unstructured-pytesseract wrapper: no binary, and unstructured runs text-layer only.
 */
const worker = fileURLToPath(new URL("../..", import.meta.url));

/** Native addons in the pnpm store that embed Tesseract code (case 2). */
function addonsEmbeddingTesseract(): string[] {
  // The store directory that holds this worker's dependencies (`<store>/<pkg>@<version>/node_modules/<name>`).
  const kreuzberg = realpathSync(path.join(worker, "node_modules", "@kreuzberg", "node"));
  const store = kreuzberg.slice(0, kreuzberg.indexOf(`${path.sep}.pnpm${path.sep}`) + `${path.sep}.pnpm`.length);
  const found = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const info = statSync(full, { throwIfNoEntry: false });
      if (!info) continue;
      if (info.isDirectory() && depth > 0 && name !== ".bin") walk(full, depth - 1);
      else if (info.isFile() && name.endsWith(".node")) {
        const bytes = readFileSync(full);
        if (bytes.includes("TessBaseAPI") || bytes.includes("third_party/tesseract/src/")) {
          found.add(path.relative(store, full).split(path.sep).slice(2).join("/"));
        }
      }
    }
  };
  for (const entry of readdirSync(store)) {
    const modules = path.join(store, entry, "node_modules");
    if (statSync(modules, { throwIfNoEntry: false })?.isDirectory()) walk(modules, 4);
  }
  return [...found].sort();
}

describe("Tesseract stays out of the worker, or disabled where it is linked", () => {
  it("installs no tesseract package or language data in any worker image", () => {
    const dockerfiles = readdirSync(worker).filter((name) => name.startsWith("Dockerfile"));
    expect(dockerfiles.length).toBeGreaterThan(0);
    for (const name of dockerfiles) {
      const lines = readFileSync(path.join(worker, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("#"));
      expect(lines.filter((line) => /tesseract|tessdata(?!-)/i.test(line.replace(/TESSDATA_PREFIX|empty-tessdata/g, ""))), name).toEqual([]);
      // Kreuzberg's linked OCR gets an empty, read-only language-data directory in every image that runs the worker.
      if (name !== "Dockerfile.bundles") expect(lines.some((line) => line.includes("ENV TESSDATA_PREFIX=/opt/docslurp/empty-tessdata")), name).toBe(true);
    }
  });

  // The prebuilds checked here are the linux-x64-gnu ones the worker images and CI install.
  it.runIf(process.platform === "linux" && process.arch === "x64")("finds Tesseract linked into exactly the known native addons, whose OCR the worker disables", () => {
    // Kreuzberg and LiteParse prebuilds compile Tesseract in (no OCR-free variant is published). A change here means a
    // dependency added, dropped or moved a copy of it: update docs/extraction/ocr.md ("Tesseract") with the evidence.
    const linked = addonsEmbeddingTesseract().filter((file) => file.includes("linux-x64-gnu"));
    expect(linked).toEqual([
      "@kreuzberg/node-linux-x64-gnu/kreuzberg-node.linux-x64-gnu.node",
      "@llamaindex/liteparse-linux-x64-gnu/liteparse.linux-x64-gnu.node",
      "@llamaindex/liteparse/liteparse.linux-x64-gnu.node",
    ]);
  }, 120_000);

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
