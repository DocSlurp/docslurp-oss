export const parseBenchDocSlurpExtractors = [
  "hybrid",
  "kreuzberg",
  "native-pdf-text",
  "native-pdf-markdown",
  "pdftotext",
  "unpdf",
  "docling",
  "liteparse",
] as const;

export type ParseBenchDocSlurpExtractor =
  (typeof parseBenchDocSlurpExtractors)[number];
