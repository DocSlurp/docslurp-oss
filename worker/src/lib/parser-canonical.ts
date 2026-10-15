import { normalizePageNumber, type CanonicalBlock, type CanonicalDocument } from "@docslurp/shared";

type PyMuPdfSpan = {
  text?: string;
  bbox?: [number, number, number, number];
  size?: number;
  font?: string;
};

type PyMuPdfLine = {
  spans?: PyMuPdfSpan[];
  bbox?: [number, number, number, number];
};

type PyMuPdfBlock = {
  type?: number;
  bbox?: [number, number, number, number];
  lines?: PyMuPdfLine[];
};

type PyMuPdfPage = {
  blocks?: PyMuPdfBlock[];
  width?: number;
  height?: number;
};

type PyMuPdfDocument = {
  pages?: PyMuPdfPage[];
};

type UnstructuredElement = {
  type?: string;
  text?: string;
  metadata?: {
    page_number?: number;
    coordinates?: {
      points?: Array<[number, number]>;
      system?: string;
      layout_width?: number;
      layout_height?: number;
    };
    category_depth?: number;
    [key: string]: unknown;
  };
};

type ParserBlock = {
  text: string;
  pageNumber: number | null;
  bbox: { x: number; y: number; width: number; height: number } | null;
  coordinateSpace: string | null;
  /** Page size in the bbox coordinate space; lets boxes be normalized to 0..1 for citations. */
  pageWidth?: number | null;
  pageHeight?: number | null;
  dominantFontSize: number | null;
  dominantFontName: string | null;
};

type ParserAdapter = {
  id: "pymupdf" | "native-pdf" | "unstructured";
  extractBlocks: (payload: unknown) => ParserBlock[];
};

type EnrichmentCandidate = {
  document: CanonicalDocument;
  matchedBlocks: number;
  bboxBlocks: number;
  pageBackedBlocks: number;
  parser: ParserAdapter["id"];
};

export type ParserEnrichmentSummary = {
  parser: ParserAdapter["id"];
  matchedBlocks: number;
  bboxBlocks: number;
  pageBackedBlocks: number;
  matchRatio: number;
  bboxRatio: number;
  pageRatio: number;
  document: CanonicalDocument;
};

const parserAdapters: ParserAdapter[] = [
  {
    id: "pymupdf",
    extractBlocks: extractPyMuPdfBlocks
  },
  {
    // In-process native engine payload: the same block/line/span shape as the PyMuPDF dict.
    id: "native-pdf",
    extractBlocks: extractPyMuPdfBlocks
  },
  {
    id: "unstructured",
    extractBlocks: extractUnstructuredBlocks
  }
];

export function enrichCanonicalDocumentWithPyMuPdf(
  document: CanonicalDocument,
  payload: unknown,
  parserArtifactUri?: string | null
): CanonicalDocument {
  return enrichCanonicalDocumentWithParser(document, payload, "pymupdf", parserArtifactUri);
}

export function enrichCanonicalDocumentWithParser(
  document: CanonicalDocument,
  payload: unknown,
  parser: ParserAdapter["id"],
  parserArtifactUri?: string | null
): CanonicalDocument {
  const adapter = parserAdapters.find((candidate) => candidate.id === parser);
  if (!adapter) {
    return document;
  }
  const parserBlocks = adapter.extractBlocks(payload);
  if (parserBlocks.length === 0) {
    return document;
  }

  const enrichedBlocks: CanonicalBlock[] = [];
  let parserCursor = 0;

  for (const block of document.blocks) {
    const blockText = normalizeText(block.text);
    if (!blockText) {
      enrichedBlocks.push(block);
      continue;
    }

    const match = findBestMatch(blockText, parserBlocks, parserCursor);
    if (match) {
      parserCursor = match.index + 1;
      const parserBlock = match.block;
      const metadata = {
        ...block.metadata,
        parser,
        bboxCoordinateSpace: parserBlock.coordinateSpace,
        ...(parserBlock.pageWidth && parserBlock.pageHeight ? { pageWidth: parserBlock.pageWidth, pageHeight: parserBlock.pageHeight } : {}),
        parserFontSize: parserBlock.dominantFontSize,
        parserFontName: parserBlock.dominantFontName,
        parserMatched: true
      };
      enrichedBlocks.push({
        ...block,
        pageNumber: parserBlock.pageNumber,
        bbox: parserBlock.bbox,
        metadata
      });
      continue;
    }

    enrichedBlocks.push({
      ...block,
      metadata: {
        ...block.metadata,
        parser,
        parserMatched: false
      }
    });
  }

  return {
    ...document,
    generator: `${document.generator}+${parser}-aligned@v1`,
    source: {
      ...document.source,
      format: parser === "pymupdf" ? "pymupdf-json" : parser === "native-pdf" ? "native-pdf-json" : document.source.format,
      parser,
      parserArtifactUri: parserArtifactUri ?? null
    },
    blocks: enrichedBlocks
  };
}

export function enrichCanonicalDocumentWithBestParser(
  document: CanonicalDocument,
  parserArtifacts: Array<{
    parser: ParserAdapter["id"];
    payload: unknown;
    artifactUri?: string | null;
  }>
): CanonicalDocument {
  const candidates = scoreParserEnrichments(document, parserArtifacts);

  const best = candidates.sort((left, right) => {
    if (right.matchedBlocks !== left.matchedBlocks) return right.matchedBlocks - left.matchedBlocks;
    if (right.bboxBlocks !== left.bboxBlocks) return right.bboxBlocks - left.bboxBlocks;
    if (right.pageBackedBlocks !== left.pageBackedBlocks) return right.pageBackedBlocks - left.pageBackedBlocks;
    return 0;
  })[0];

  return best?.document ?? document;
}

export function scoreParserEnrichments(
  document: CanonicalDocument,
  parserArtifacts: Array<{
    parser: ParserAdapter["id"];
    payload: unknown;
    artifactUri?: string | null;
  }>
): ParserEnrichmentSummary[] {
  const candidates: EnrichmentCandidate[] = [];
  for (const artifact of parserArtifacts) {
    const enriched = enrichCanonicalDocumentWithParser(
      document,
      artifact.payload,
      artifact.parser,
      artifact.artifactUri
    );
    const matchedBlocks = enriched.blocks.filter((block) => block.metadata.parserMatched === true).length;
    const bboxBlocks = enriched.blocks.filter((block) => block.bbox !== null).length;
    const pageBackedBlocks = enriched.blocks.filter((block) => block.pageNumber !== null).length;
    candidates.push({
      document: enriched,
      matchedBlocks,
      bboxBlocks,
      pageBackedBlocks,
      parser: artifact.parser
    });
  }

  const totalBlocks = Math.max(1, document.blocks.length);
  return candidates.map((candidate) => ({
    parser: candidate.parser,
    matchedBlocks: candidate.matchedBlocks,
    bboxBlocks: candidate.bboxBlocks,
    pageBackedBlocks: candidate.pageBackedBlocks,
    matchRatio: candidate.matchedBlocks / totalBlocks,
    bboxRatio: candidate.bboxBlocks / totalBlocks,
    pageRatio: candidate.pageBackedBlocks / totalBlocks,
    document: candidate.document
  }));
}

function extractPyMuPdfBlocks(payload: unknown): ParserBlock[] {
  const doc = payload as PyMuPdfDocument | null;
  if (!doc?.pages || !Array.isArray(doc.pages)) {
    return [];
  }

  const blocks: ParserBlock[] = [];

  doc.pages.forEach((page, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const pageBlocks = Array.isArray(page.blocks) ? page.blocks : [];

    for (const block of pageBlocks) {
      const text = extractTextFromBlock(block).trim();
      if (!text) {
        continue;
      }

      blocks.push({
        text,
        pageNumber,
        bbox: toBbox(block.bbox),
        coordinateSpace: "page-top-left-points",
        pageWidth: positiveNumber(page.width),
        pageHeight: positiveNumber(page.height),
        dominantFontSize: dominantFontSize(block),
        dominantFontName: dominantFontName(block)
      });
    }
  });

  return blocks;
}

function extractUnstructuredBlocks(payload: unknown): ParserBlock[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload
    .map((entry) => entry as UnstructuredElement)
    .map((element) => ({
      text: (element.text ?? "").trim(),
      pageNumber: normalizePageNumber(element.metadata?.page_number),
      bbox: unstructuredBbox(element.metadata?.coordinates?.points),
      coordinateSpace: typeof element.metadata?.coordinates?.system === "string"
        ? element.metadata.coordinates.system
        : null,
      pageWidth: positiveNumber(element.metadata?.coordinates?.layout_width),
      pageHeight: positiveNumber(element.metadata?.coordinates?.layout_height),
      dominantFontSize: null,
      dominantFontName: typeof element.type === "string" ? element.type : null
    }))
    .filter((block) => block.text.length > 0);
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function extractTextFromBlock(block: PyMuPdfBlock): string {
  const lines = Array.isArray(block.lines) ? block.lines : [];
  return lines
    .map((line) =>
      (Array.isArray(line.spans) ? line.spans : [])
        .map((span) => span.text ?? "")
        .join("")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}

function dominantFontSize(block: PyMuPdfBlock): number | null {
  const sizes = new Map<number, number>();
  for (const line of block.lines ?? []) {
    for (const span of line.spans ?? []) {
      if (typeof span.size !== "number") continue;
      const count = sizes.get(span.size) ?? 0;
      sizes.set(span.size, count + Math.max(1, (span.text ?? "").length));
    }
  }
  let winner: number | null = null;
  let bestWeight = -1;
  for (const [size, weight] of sizes) {
    if (weight > bestWeight) {
      bestWeight = weight;
      winner = size;
    }
  }
  return winner;
}

function dominantFontName(block: PyMuPdfBlock): string | null {
  const fonts = new Map<string, number>();
  for (const line of block.lines ?? []) {
    for (const span of line.spans ?? []) {
      if (!span.font) continue;
      const count = fonts.get(span.font) ?? 0;
      fonts.set(span.font, count + Math.max(1, (span.text ?? "").length));
    }
  }
  let winner: string | null = null;
  let bestWeight = -1;
  for (const [font, weight] of fonts) {
    if (weight > bestWeight) {
      bestWeight = weight;
      winner = font;
    }
  }
  return winner;
}

function toBbox(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(value) || value.length !== 4) {
    return null;
  }
  const [x0, y0, x1, y1] = value;
  if ([x0, y0, x1, y1].some((item) => typeof item !== "number")) {
    return null;
  }
  return {
    x: x0,
    y: y0,
    width: Math.max(0, x1 - x0),
    height: Math.max(0, y1 - y0)
  };
}

function unstructuredBbox(
  points: Array<[number, number]> | undefined
): { x: number; y: number; width: number; height: number } | null {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }
  const xs = points.map((point) => point[0]).filter((value): value is number => typeof value === "number");
  const ys = points.map((point) => point[1]).filter((value): value is number => typeof value === "number");
  if (xs.length === 0 || ys.length === 0) {
    return null;
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  };
}

function findBestMatch(
  targetText: string,
  parserBlocks: ParserBlock[],
  startIndex: number
): { index: number; block: ParserBlock } | null {
  const targetTokens = tokenSet(targetText);
  let best: { index: number; block: ParserBlock; score: number } | null = null;

  for (let index = startIndex; index < parserBlocks.length; index++) {
    const block = parserBlocks[index]!;
    const candidateTokens = tokenSet(normalizeText(block.text));
    const score = jaccard(targetTokens, candidateTokens);

    if (score > (best?.score ?? 0)) {
      best = { index, block, score };
    }

    if (score >= 0.92) {
      break;
    }
  }

  if (!best) {
    return null;
  }

  if (best.score >= 0.45 || normalizeText(best.block.text).includes(targetText.slice(0, 48))) {
    return { index: best.index, block: best.block };
  }

  return null;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

function tokenSet(value: string): Set<string> {
  return new Set(value.split(" ").filter((token) => token.length > 1));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const item of a) {
    if (b.has(item)) {
      overlap++;
    }
  }
  return overlap / (a.size + b.size - overlap);
}
