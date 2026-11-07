export const parseBenchDocSlurpExtractors = [
  "hybrid",
  "native-pdf-text",
  "native-pdf-markdown",
  "pdftotext",
  "unpdf",
  "docling",
] as const;

export type ParseBenchDocSlurpExtractor =
  (typeof parseBenchDocSlurpExtractors)[number];
