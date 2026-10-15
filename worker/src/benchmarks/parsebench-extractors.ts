export const parseBenchDocSlurpExtractors = [
  "hybrid",
  "kreuzberg",
  "pymupdf-text",
  "pymupdf4llm-markdown",
  "pdftotext",
  "pymupdf-ocr-text",
  "unpdf",
  "docling",
  "liteparse",
] as const;

export type ParseBenchDocSlurpExtractor =
  (typeof parseBenchDocSlurpExtractors)[number];
