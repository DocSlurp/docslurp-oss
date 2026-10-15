import { readFile } from "node:fs/promises";

import type { CommandRunner } from "../tools/runner.js";

export type DocumentExtractionWordBox = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DocumentExtractionTextItem = DocumentExtractionWordBox & {
  fontName?: string;
  fontSize?: number;
  confidence?: number;
  rotation?: number;
  words: DocumentExtractionWordBox[];
};

export type DocumentExtractionComplexity = {
  textLength: number;
  textCoverage: number;
  hasSubstantialImages: boolean;
  imageBlockCount: number;
  imageCoverage: number;
  largestImageCoverage: number;
  fullPageImage: boolean;
  uncoveredVectorArea?: number;
  isGarbled: boolean;
  pageArea: number;
  needsOcr: boolean;
  reasons: string[];
};

export type DocumentExtractionPage = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  markdown: string;
  textItems: DocumentExtractionTextItem[];
  complexity: DocumentExtractionComplexity | null;
};

export type DocumentExtractionResult = {
  adapter: string;
  version: string;
  markdown: string;
  rawText: string;
  pages: DocumentExtractionPage[];
  diagnostics: {
    latencyMs: number;
    ocrEnabled: boolean;
  };
};

export interface DocumentExtractionAdapter {
  readonly name: string;
  extract(args: {
    inputPath: string;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<DocumentExtractionResult>;
}

/** One sandboxed process performs PDFium extraction, projection and Markdown. */
export class LiteParseDocumentExtractionAdapter
  implements DocumentExtractionAdapter
{
  readonly name = "liteparse";

  constructor(
    private readonly runner: CommandRunner,
    private readonly options: { ocrEnabled?: boolean } = {},
  ) {}

  async extract(args: {
    inputPath: string;
    outputPath: string;
    signal?: AbortSignal;
  }): Promise<DocumentExtractionResult> {
    const plan = await this.runner.liteParseExtract(
      args.inputPath,
      args.outputPath,
      this.options.ocrEnabled ?? false,
    );
    if (!plan.available) {
      throw new Error("LiteParse helper is unavailable");
    }
    await this.runner.run(plan, args.signal);
    const parsed = JSON.parse(
      await readFile(args.outputPath, "utf8"),
    ) as unknown;
    return parseDocumentExtractionResult(parsed);
  }
}

export function parseDocumentExtractionResult(
  value: unknown,
): DocumentExtractionResult {
  if (!value || typeof value !== "object") {
    throw new Error("document extraction Adapter returned a non-object result");
  }
  const candidate = value as Partial<DocumentExtractionResult>;
  if (
    typeof candidate.adapter !== "string" ||
    typeof candidate.version !== "string" ||
    typeof candidate.markdown !== "string" ||
    typeof candidate.rawText !== "string" ||
    !Array.isArray(candidate.pages) ||
    !candidate.diagnostics ||
    typeof candidate.diagnostics.latencyMs !== "number"
  ) {
    throw new Error("document extraction Adapter returned an invalid result");
  }
  for (const page of candidate.pages) {
    if (
      !page ||
      typeof page.pageNumber !== "number" ||
      typeof page.markdown !== "string" ||
      !Array.isArray(page.textItems)
    ) {
      throw new Error("document extraction Adapter returned an invalid page");
    }
  }
  return candidate as DocumentExtractionResult;
}
