import { writeFile } from "node:fs/promises";

// LiteParse's native addon links an OCR engine. It never OCRs here: OCR runs only in the worker's OCR boundary. The
// engine also gets no language data (an empty, read-only directory) and no OCR server, so a call that slipped past
// ocrEnabled: false fails instead of reading pixels. Set before the binding loads.
const EMPTY_TESSDATA = "/opt/docslurp/empty-tessdata";
process.env.TESSDATA_PREFIX = EMPTY_TESSDATA;
const { LiteParse } = await import("@llamaindex/liteparse");

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
if (process.argv.includes("--ocr")) {
  process.stderr.write("liteparse OCR refused: OCR runs only in the worker's OCR boundary\n");
  process.exit(1);
}
const ocrEnabled = false;
const startedAt = performance.now();
const parser = new LiteParse({
  outputFormat: "markdown",
  ocrEnabled,
  tessdataPath: EMPTY_TESSDATA,
  ocrServerUrl: undefined,
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
