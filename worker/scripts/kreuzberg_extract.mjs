#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { insertPageMarkers } from "./kreuzberg_page_markers.mjs";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    "config-json": { type: "string" }
  }
});

if (!values.input || !values.output) {
  process.stderr.write("usage: kreuzberg_extract.mjs --input file.pdf --output out.md\n");
  process.exit(1);
}

let kreuzberg;
try {
  kreuzberg = await import("@kreuzberg/node");
} catch (error) {
  process.stderr.write(`missing dependency: pnpm add @kreuzberg/node (${error})\n`);
  process.exit(1);
}

try {
  const parsedConfig = values["config-json"] ? JSON.parse(values["config-json"]) : {};
  const { preferredAdapter, dolphin, ...kreuzbergConfig } = parsedConfig;
  const result = await kreuzberg.extractFile(values.input, null, {
    outputFormat: "markdown",
    includeDocumentStructure: true,
    enableQualityProcessing: true,
    useCache: true,
    ...kreuzbergConfig
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

  // Append tables if kreuzberg surfaces them separately from the main content
  if (Array.isArray(result.tables) && result.tables.length > 0) {
    const embeddedTableText = markdown.toLowerCase();
    const extraTables = result.tables
      .filter((t) => t.markdown && !embeddedTableText.includes(t.markdown.slice(0, 40).toLowerCase()))
      .map((t) => t.markdown);
    if (extraTables.length > 0) {
      markdown = `${markdown}\n\n${extraTables.join("\n\n")}`;
    }
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
