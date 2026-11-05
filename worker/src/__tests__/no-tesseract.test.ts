import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * Owner policy: no Tesseract in any worker image or development path (docs/extraction/ocr.md, "No Tesseract"). The
 * transitive unstructured-pytesseract wrapper is pure Python and needs a `tesseract` binary that no image installs.
 */
const worker = fileURLToPath(new URL("../..", import.meta.url));

describe("no Tesseract", () => {
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
