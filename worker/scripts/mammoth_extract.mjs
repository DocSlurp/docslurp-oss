#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    output: { type: "string" },
    format: { type: "string", default: "markdown" }
  }
});

let mammoth;
try {
  mammoth = (await import("mammoth")).default;
} catch {
  writeFileSync(values.output, JSON.stringify({ error: "mammoth not installed", text: "" }));
  process.exit(1);
}

const buffer = readFileSync(values.input);
let result;
try {
  if (values.format === "markdown") {
    // mammoth doesn't have a native markdown converter; use html then convert headings
    result = await mammoth.convertToHtml({ buffer });
    // Simple HTML -> markdown: convert common tags
    const text = result.value
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n")
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n")
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n")
      .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n")
      .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim();
    writeFileSync(values.output, JSON.stringify({ text, format: "markdown", extractor: "mammoth", messages: result.messages }));
  } else {
    result = await mammoth.convertToHtml({ buffer });
    writeFileSync(values.output, JSON.stringify({ text: result.value, format: "html", extractor: "mammoth", messages: result.messages }));
  }
} catch (err) {
  writeFileSync(values.output, JSON.stringify({ error: String(err), text: "" }));
  process.exit(1);
}
