import { writeFile } from "node:fs/promises";

import { LiteParse } from "@llamaindex/liteparse";

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireArg(flag) {
  const value = readArg(flag);
  if (!value) throw new Error(`Missing required argument: ${flag}`);
  return value;
}

const input = requireArg("--input");
const output = requireArg("--output");
const ocrEnabled = process.argv.includes("--ocr");
const startedAt = performance.now();
const parser = new LiteParse({
  outputFormat: "markdown",
  ocrEnabled,
  ocrFailureFatal: false,
  imageMode: "off",
  extractLinks: true,
  emitWordBoxes: true,
  includeComplexity: true,
  quiet: true,
});
const result = await parser.parse(input);
const pages = result.pages.map((page) => ({
  pageNumber: page.pageNum,
  width: page.width,
  height: page.height,
  text: page.text,
  markdown: page.markdown,
  textItems: page.textItems,
  complexity: page.complexity ?? null,
}));
const markdown = pages.map((page) => page.markdown).join("\f");

await writeFile(
  output,
  JSON.stringify({
    adapter: "liteparse",
    version: "2.6.0",
    markdown,
    rawText: result.text,
    pages,
    diagnostics: {
      latencyMs: performance.now() - startedAt,
      ocrEnabled,
    },
  }),
  "utf8",
);
