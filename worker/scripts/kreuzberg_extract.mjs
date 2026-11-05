#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { insertPageMarkers } from "./kreuzberg_page_markers.mjs";

const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".gif", ".webp", ".tif", ".tiff", ".bmp", ".dib", ".heic", ".heif", ".avif",
  ".jp2", ".jpx", ".j2k", ".j2c", ".jpf", ".jpm", ".jxl", ".pnm", ".pbm", ".pgm", ".ppm", ".ico", ".tga", ".pcx", ".svg",
]);
import { missingTableMarkdown } from "./kreuzberg_tables.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    "config-json": { type: "string" },
    // The worker's sniffed MIME type: Kreuzberg uses it instead of detecting the format itself.
    "mime-type": { type: "string" }
  }
});

if (!values.input || !values.output) {
  process.stderr.write("usage: kreuzberg_extract.mjs --input file.pdf --output out.md\n");
  process.exit(1);
}

// Kreuzberg's linked OCR engine must find no language data, so it can never read pixels here (the worker image ships
// this directory empty and read-only; where it does not exist the engine fails the same way). Set before the binding loads.
process.env.TESSDATA_PREFIX = "/opt/docslurp/empty-tessdata";

let kreuzberg;
try {
  kreuzberg = await import("@kreuzberg/node");
} catch (error) {
  process.stderr.write(`missing dependency: pnpm add @kreuzberg/node (${error})\n`);
  process.exit(1);
}

try {
  const parsedConfig = values["config-json"] ? JSON.parse(values["config-json"]) : {};
  // Kreuzberg never OCRs: its built-in OCR would read customer pixels inside this process. OCR keys are dropped, and
  // an image input is refused outright (@kreuzberg/node 4.10.2 OCRs images whatever its options say). Scanned pages come
  // back empty and are read by the worker's OCR engine in its own boundary.
  const { preferredAdapter, dolphin, ocr, forceOcr, forceOcrPages, disableOcr, ...kreuzbergConfig } = parsedConfig;
  const mimeType = values["mime-type"] ?? null;
  if (IMAGE_EXTENSIONS.has(path.extname(values.input).toLowerCase()) || /^image\//i.test(mimeType ?? "")) {
    process.stderr.write("kreuzberg extraction refused: images are read by the OCR engine, not Kreuzberg\n");
    process.exit(1);
  }
  // Belt and braces for the OCR Kreuzberg links: the worker image points TESSDATA_PREFIX at an empty read-only
  // directory, so an OCR call it makes despite disableOcr has no language data and fails instead of reading pixels.
  const result = await kreuzberg.extractFile(values.input, mimeType, {
    outputFormat: "markdown",
    includeDocumentStructure: true,
    enableQualityProcessing: true,
    useCache: true,
    ...kreuzbergConfig,
    ocr: null,
    forceOcr: false,
    disableOcr: true
  });

  // Build output: main content followed by any tables not already embedded
  let markdown = result.content ?? "";
  // PDFs: one \f-separated section per page (empty for pages without text), so
  // downstream page attribution and page triage see real page boundaries.
  const pageCount = Number(result.metadata?.pageCount ?? 0);
  if (result.metadata?.formatType === "pdf" && pageCount > 1 && markdown.trim() && !markdown.includes("\f")) {
    const paged = insertPageMarkers(markdown, result.document?.nodes, pageCount);
    if (paged !== null) markdown = paged;
    else process.stderr.write(`[kreuzberg] page markers unavailable pages=${pageCount}; keeping unpaged markdown\n`);
  }

  // Append tables kreuzberg surfaces separately and the main content lacks.
  const extraTables = missingTableMarkdown(markdown, result.tables);
  if (extraTables.length > 0) {
    markdown = `${markdown}\n\n${extraTables.join("\n\n")}`;
  }

  if ([".docx", ".xlsx"].includes(path.extname(values.input).toLowerCase())) {
    const preferredPython = process.env.PYTHON_VENV ? path.join(process.env.PYTHON_VENV, "bin", "python3") : null;
    const python = preferredPython && existsSync(preferredPython) ? preferredPython : "python3";
    const script = fileURLToPath(new URL("./office_context.py", import.meta.url));
    markdown += execFileSync(python, [script, "--input", values.input], { encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }).trimEnd();
  }
  await writeFile(values.output, markdown, "utf8");
} catch (error) {
  process.stderr.write(`kreuzberg extraction failed: ${error}\n`);
  process.exit(1);
}
