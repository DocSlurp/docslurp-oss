import { tableChunks, TableBoundary } from "../pipeline/table-chunking.js";
import {
  normalizePageNumbers,
  splitTextIntoPages,
  type CanonicalBlock,
  type CanonicalBlockType,
  type CanonicalDocument,
  type CanonicalEvidenceType,
  type LayoutRegion,
  type SourceTrace,
  type TableCell,
  type TableCellValueType,
  type TableChunkGranularity,
  type CitationLocator
} from "@docslurp/shared";
import { buildChunkLocator, evidenceBoundary, mergeLocators } from "./chunk-locator.js";
import { leadingFrontmatterLineCount, plainHeadingText } from "./markdown-structure.js";

export interface CanonicalChunk {
  text: string;
  headingPath: string[];
  pageNumber: number | null;
  pageNumbers: number[];
  blockIds: string[];
  blockTypes: CanonicalBlockType[];
  evidenceType: CanonicalEvidenceType;
  chunkIndex: number;
  overlapIndex?: number;
  tableGranularity?: TableChunkGranularity | null;
  tableRowIndex?: number | null;
  tableRowCount?: number | null;
  tableColumnNames?: string[];
  tableColumnTypes?: TableCellValueType[];
  tableCells?: TableCell[];
  tableCell?: TableCell | null;
  regionBoxes?: LayoutRegion[];
  regions?: LayoutRegion[];
  regionCoordinateSpace?: string | null;
  sourceTrace?: SourceTrace;
  /** Exact evidence position (page span/boxes, slide, sheet range, media moment) for citation drawing. */
  locator?: CitationLocator | null;
}

const CODE_FENCE_RE = /^```/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const ORDERED_LIST_RE = /^\s*\d+\.\s+/;
const UNORDERED_LIST_RE = /^\s*[-*+]\s+/;
const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const QUOTE_RE = /^\s*>\s?/;
const MAX_CHARS = 1800;

export function buildCanonicalDocumentFromMarkdown(args: {
  documentId: string;
  text: string;
  pageCount: number;
  sourceArtifactUri?: string | null;
  extractor: string;
}): CanonicalDocument {
  const pages = splitTextIntoPages(args.text, args.pageCount);
  const headingStack: Array<{ level: number; text: string }> = [];
  const blocks: CanonicalBlock[] = [];
  let order = 0;

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const pageText = pages[pageIndex] ?? "";
    const lines = pageText.split("\n");
    // A leading metadata block (`---` … `---`) describes the document; it is not a heading or content.
    let lineIndex = pageIndex === 0 ? leadingFrontmatterLineCount(lines) : 0;
    const pageFirstBlock = blocks.length;

    while (lineIndex < lines.length) {
      while (lineIndex < lines.length && lines[lineIndex]?.trim() === "") {
        lineIndex++;
      }

      if (lineIndex >= lines.length) {
        break;
      }

      const startLine = lineIndex + 1;
      const line = lines[lineIndex] ?? "";
      const pageNumber = pageIndex + 1;

      if (CODE_FENCE_RE.test(line.trim())) {
        const codeLines = [line];
        lineIndex++;
        while (lineIndex < lines.length) {
          const nextLine = lines[lineIndex] ?? "";
          codeLines.push(nextLine);
          lineIndex++;
          if (CODE_FENCE_RE.test(nextLine.trim())) {
            break;
          }
        }
        blocks.push(createBlock({
          documentId: args.documentId,
          order: order++,
          type: "code",
          text: codeLines.join("\n").trim(),
          headingPath: activeHeadingPath(headingStack),
          pageNumber,
          lineStart: startLine,
          lineEnd: lineIndex,
          metadata: {}
        }));
        continue;
      }

      if (/^ {0,3}<table(?=\s|>|$)/i.test(line)) {
        const tableLines: string[] = [];
        const boundary = new TableBoundary();
        while (lineIndex < lines.length) {
          const nextLine = lines[lineIndex++] ?? "";
          tableLines.push(nextLine);
          boundary.feed(nextLine);
          if (boundary.closed) break;
        }
        blocks.push(createBlock({
          documentId: args.documentId, order: order++, type: "table",
          text: tableLines.join("\n").trim(), headingPath: activeHeadingPath(headingStack),
          pageNumber, lineStart: startLine, lineEnd: lineIndex, metadata: { encoding: "html" }
        }));
        continue;
      }

      const headingMatch = line.match(HEADING_RE);
      if (headingMatch) {
        const level = headingMatch[1]?.length ?? 1;
        const headingText = plainHeadingText(headingMatch[2] ?? line);
        while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
          headingStack.pop();
        }
        headingStack.push({ level, text: headingText });
        lineIndex++;
        blocks.push(createBlock({
          documentId: args.documentId,
          order: order++,
          type: "heading",
          text: line.trim(),
          headingPath: activeHeadingPath(headingStack),
          pageNumber,
          lineStart: startLine,
          lineEnd: startLine,
          metadata: { level }
        }));
        continue;
      }

      if (isTableStart(lines, lineIndex)) {
        const tableLines: string[] = [];
        while (lineIndex < lines.length && isTableLine(lines[lineIndex] ?? "")) {
          tableLines.push(lines[lineIndex] ?? "");
          lineIndex++;
        }
        blocks.push(createBlock({
          documentId: args.documentId,
          order: order++,
          type: "table",
          text: tableLines.join("\n").trim(),
          headingPath: activeHeadingPath(headingStack),
          pageNumber,
          lineStart: startLine,
          lineEnd: lineIndex,
          metadata: { rows: tableLines.length }
        }));
        continue;
      }

      if (isListLine(line)) {
        const listLines: string[] = [];
        while (lineIndex < lines.length) {
          const nextLine = lines[lineIndex] ?? "";
          if (nextLine.trim() === "") {
            break;
          }
          if (!isListLine(nextLine) && !isIndentedContinuation(nextLine)) {
            break;
          }
          listLines.push(nextLine);
          lineIndex++;
        }
        blocks.push(createBlock({
          documentId: args.documentId,
          order: order++,
          type: "list",
          text: listLines.join("\n").trim(),
          headingPath: activeHeadingPath(headingStack),
          pageNumber,
          lineStart: startLine,
          lineEnd: lineIndex,
          metadata: {}
        }));
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const quoteLines: string[] = [];
        while (lineIndex < lines.length) {
          const nextLine = lines[lineIndex] ?? "";
          if (nextLine.trim() === "" || !QUOTE_RE.test(nextLine)) {
            break;
          }
          quoteLines.push(nextLine);
          lineIndex++;
        }
        blocks.push(createBlock({
          documentId: args.documentId,
          order: order++,
          type: "quote",
          text: quoteLines.join("\n").trim(),
          headingPath: activeHeadingPath(headingStack),
          pageNumber,
          lineStart: startLine,
          lineEnd: lineIndex,
          metadata: {}
        }));
        continue;
      }

      const paragraphLines: string[] = [];
      while (lineIndex < lines.length) {
        const nextLine = lines[lineIndex] ?? "";
        if (nextLine.trim() === "") {
          break;
        }
        if (
          CODE_FENCE_RE.test(nextLine.trim()) ||
          HEADING_RE.test(nextLine) ||
          isTableStart(lines, lineIndex) ||
          /^ {0,3}<table(?=\s|>|$)/i.test(nextLine) ||
          isListLine(nextLine) ||
          QUOTE_RE.test(nextLine)
        ) {
          break;
        }
        paragraphLines.push(nextLine);
        lineIndex++;
      }

      blocks.push(createBlock({
        documentId: args.documentId,
        order: order++,
        type: "paragraph",
        text: paragraphLines.join("\n").trim(),
        headingPath: activeHeadingPath(headingStack),
        pageNumber,
        lineStart: startLine,
        lineEnd: Math.max(startLine, lineIndex),
        metadata: {}
      }));
    }

    // Where each block sits inside this page's text, so a citation can highlight the exact passage.
    const lineOffsets: number[] = [];
    let cursor = 0;
    for (const line of lines) { lineOffsets.push(cursor); cursor += line.length + 1; }
    for (let i = pageFirstBlock; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.lineStart === null || block.lineEnd === null) continue;
      const raw = lines.slice(block.lineStart - 1, block.lineEnd).join("\n");
      const charStart = (lineOffsets[block.lineStart - 1] ?? 0) + (raw.length - raw.trimStart().length);
      block.metadata = { ...block.metadata, charStart, charEnd: charStart + block.text.length };
    }
  }

  return {
    documentId: args.documentId,
    generator: "heuristic-markdown-block-tree@v1",
    source: {
      format: "markdown",
      artifactUri: args.sourceArtifactUri ?? null,
      extractor: args.extractor,
      parser: null,
      parserArtifactUri: null
    },
    stats: {
      blockCount: blocks.length,
      headingCount: countBlocks(blocks, "heading"),
      paragraphCount: countBlocks(blocks, "paragraph"),
      codeBlockCount: countBlocks(blocks, "code"),
      tableCount: countBlocks(blocks, "table"),
      pageCount: Math.max(args.pageCount, pages.length)
    },
    blocks
  };
}

export function canonicalDocumentToText(document: CanonicalDocument): string {
  return document.blocks
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function buildCanonicalChunksFromDocument(
  document: CanonicalDocument,
  fallback: string,
  options?: { chunkOverlap?: boolean; maxChars?: number; sourceKind?: "image" | null; evidenceBoundaries?: boolean }
): CanonicalChunk[] {
  const maxChars = options?.maxChars ?? MAX_CHARS;
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new RangeError("maxChars must be a positive safe integer");
  const meaningfulBlocks = document.blocks.filter((block) => block.text.trim().length > 0);

  if (meaningfulBlocks.length === 0) {
    return [{
      text: fallback,
      headingPath: [],
      pageNumber: null,
      pageNumbers: [],
      blockIds: [],
      blockTypes: ["raw"],
      evidenceType: "raw",
      chunkIndex: 0
    }];
  }

  const baseChunks: Array<Omit<CanonicalChunk, "chunkIndex" | "overlapIndex">> = [];
  let currentBlocks: CanonicalBlock[] = [];
  let currentText = "";

  const flushCurrent = () => {
    if (!currentBlocks.length || !currentText.trim()) {
      currentBlocks = [];
      currentText = "";
      return;
    }
    baseChunks.push(materializeChunk(currentText.trim(), currentBlocks));
    currentBlocks = [];
    currentText = "";
  };

  for (const block of meaningfulBlocks) {
    const blockText = block.text.trim();
    if (!blockText) {
      continue;
    }

    if (block.type === "table") {
      flushCurrent();
      for (const tableChunk of buildTableChunks(block, maxChars)) {
        baseChunks.push(tableChunk);
      }
      continue;
    }

    if (blockText.length > maxChars) {
      flushCurrent();
      for (const splitText of splitOversizedText(blockText, maxChars)) {
        baseChunks.push(materializeChunk(splitText, [block]));
      }
      continue;
    }

    const nextText = currentText ? `${currentText}\n\n${blockText}` : blockText;
    const startsNewSection = block.type === "heading" && currentBlocks.length > 0;

    if (startsNewSection || nextText.length > maxChars || (options?.evidenceBoundaries !== false && evidenceBoundary(currentBlocks, block, currentText.length))) {
      flushCurrent();
    }

    currentBlocks.push(block);
    currentText = currentText ? `${currentText}\n\n${blockText}` : blockText;
  }

  flushCurrent();

  attachLocators(baseChunks, meaningfulBlocks, options?.sourceKind ?? null);
  return withOverlap(baseChunks, options?.chunkOverlap ? 0.5 : 0, maxChars);
}

function attachLocators(
  chunks: Array<Omit<CanonicalChunk, "chunkIndex" | "overlapIndex">>,
  blocks: CanonicalBlock[],
  sourceKind: "image" | null
) {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  // Pieces of one oversized block are consecutive; search forward so repeated text cannot match an earlier piece.
  const searchFrom = new Map<string, number>();
  for (const chunk of chunks) {
    const own = chunk.blockIds.map((id) => byId.get(id)).filter((block): block is CanonicalBlock => block !== undefined);
    let slice: { start: number; end: number } | null = null;
    if (own.length === 1 && chunk.text !== own[0]!.text.trim()) {
      const blockId = own[0]!.id;
      const full = own[0]!.text.trim();
      let at = full.indexOf(chunk.text, searchFrom.get(blockId) ?? 0);
      if (at < 0) at = full.indexOf(chunk.text);
      if (at >= 0) { slice = { start: at, end: at + chunk.text.length }; searchFrom.set(blockId, at + chunk.text.length); }
    }
    chunk.locator = buildChunkLocator(own, {
      sourceKind,
      slice,
      table: chunk.tableGranularity
        ? { granularity: chunk.tableGranularity, rowIndex: chunk.tableRowIndex ?? null, cell: chunk.tableCell ?? null }
        : undefined
    });
  }
}

function createBlock(args: {
  documentId: string;
  order: number;
  type: CanonicalBlockType;
  text: string;
  headingPath: string[];
  pageNumber: number | null;
  lineStart: number;
  lineEnd: number;
  metadata: Record<string, unknown>;
}): CanonicalBlock {
  return {
    id: `${args.documentId}:block:${args.order.toString().padStart(4, "0")}`,
    type: args.type,
    order: args.order,
    text: args.text,
    headingPath: [...args.headingPath],
    pageNumber: args.pageNumber,
    lineStart: args.lineStart,
    lineEnd: args.lineEnd,
    bbox: null,
    metadata: args.metadata
  };
}

function materializeChunk(
  text: string,
  blocks: CanonicalBlock[],
  tableMetadata?: Partial<Pick<
    CanonicalChunk,
    "tableGranularity" | "tableRowIndex" | "tableRowCount" | "tableColumnNames" | "tableColumnTypes" | "tableCells" | "tableCell"
  >>
): Omit<CanonicalChunk, "chunkIndex" | "overlapIndex"> {
  const pageNumbers = normalizePageNumbers(blocks.map((block) => block.pageNumber));
  const blockTypes = [...new Set(blocks.map((block) => block.type))];
  const headingPath = [...findLastHeadingPath(blocks)];
  const regionBoxes = collectRegionBoxes(blocks);
  const sourceTrace = collectSourceTrace(blocks);

  return {
    text,
    headingPath,
    pageNumber: pageNumbers.length === 1 ? pageNumbers[0]! : null,
    pageNumbers,
    blockIds: blocks.map((block) => block.id),
    blockTypes,
    evidenceType: blockTypes.length === 1 ? blockTypes[0]! : "mixed",
    regionBoxes,
    regions: regionBoxes,
    regionCoordinateSpace: collectRegionCoordinateSpace(blocks),
    tableGranularity: tableMetadata?.tableGranularity ?? null,
    tableRowIndex: tableMetadata?.tableRowIndex ?? null,
    tableRowCount: tableMetadata?.tableRowCount ?? null,
    tableColumnNames: tableMetadata?.tableColumnNames ?? [],
    tableColumnTypes: tableMetadata?.tableColumnTypes ?? [],
    tableCells: tableMetadata?.tableCells ?? [],
    tableCell: tableMetadata?.tableCell ?? null,
    sourceTrace
  };
}

function findLastHeadingPath(blocks: CanonicalBlock[]): string[] {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block && block.headingPath.length > 0) {
      return block.headingPath;
    }
  }
  return [];
}

function withOverlap(
  baseChunks: Array<Omit<CanonicalChunk, "chunkIndex" | "overlapIndex">>,
  overlapFraction: number,
  maxChars: number
): CanonicalChunk[] {
  const chunks: CanonicalChunk[] = [];
  let chunkIndex = 0;

  for (let index = 0; index < baseChunks.length; index++) {
    const current = baseChunks[index]!;
    chunks.push({
      ...current,
      chunkIndex,
      overlapIndex: 0
    });
    chunkIndex++;

    if (overlapFraction <= 0 || index + 1 >= baseChunks.length) {
      continue;
    }

    const next = baseChunks[index + 1]!;
    if (current.blockTypes.includes("table") || next.blockTypes.includes("table")) continue;
    const tailLength = Math.floor(current.text.length * overlapFraction);
    const headLength = Math.floor(next.text.length * overlapFraction);
    const overlapText = `${current.text.slice(-tailLength)} ${next.text.slice(0, headLength)}`.trim();

    if (!overlapText || overlapText.length > maxChars) {
      continue;
    }

    const blockTypes = [...new Set([...current.blockTypes, ...next.blockTypes])];
    const pageNumbers = normalizePageNumbers([...current.pageNumbers, ...next.pageNumbers]);

    chunks.push({
      text: overlapText,
      headingPath: [...current.headingPath],
      pageNumber: pageNumbers.length === 1 ? pageNumbers[0]! : null,
      pageNumbers,
      blockIds: [...new Set([...current.blockIds, ...next.blockIds])],
      blockTypes,
      evidenceType: blockTypes.length === 1 ? blockTypes[0]! : "mixed",
      regionBoxes: [...(current.regionBoxes ?? []), ...(next.regionBoxes ?? [])],
      regions: [...(current.regions ?? current.regionBoxes ?? []), ...(next.regions ?? next.regionBoxes ?? [])],
      regionCoordinateSpace: current.regionCoordinateSpace ?? next.regionCoordinateSpace ?? null,
      sourceTrace: {
        canonicalDocumentUri: current.sourceTrace?.canonicalDocumentUri ?? next.sourceTrace?.canonicalDocumentUri ?? null,
        parserArtifactUri: current.sourceTrace?.parserArtifactUri ?? next.sourceTrace?.parserArtifactUri ?? null,
        sourceArtifactUri: current.sourceTrace?.sourceArtifactUri ?? next.sourceTrace?.sourceArtifactUri ?? null,
        blockIds: [...new Set([...(current.sourceTrace?.blockIds ?? []), ...(next.sourceTrace?.blockIds ?? [])])],
        pageNumbers: normalizePageNumbers([...(current.sourceTrace?.pageNumbers ?? []), ...(next.sourceTrace?.pageNumbers ?? [])]),
        extractor: current.sourceTrace?.extractor ?? next.sourceTrace?.extractor ?? null
      },
      locator: mergeLocators(current.locator, next.locator),
      chunkIndex,
      overlapIndex: 1
    });
    chunkIndex++;
  }

  return chunks;
}

function activeHeadingPath(headingStack: Array<{ level: number; text: string }>): string[] {
  return headingStack.map((entry) => entry.text).filter(Boolean);
}

function countBlocks(blocks: CanonicalBlock[], type: CanonicalBlockType): number {
  return blocks.filter((block) => block.type === type).length;
}

function isTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  if (!isTableLine(current)) {
    return false;
  }

  const next = lines[index + 1] ?? "";
  return /\|\s*[-:]+/.test(next) || isTableLine(next);
}

function isTableLine(line: string): boolean {
  return TABLE_LINE_RE.test(line);
}

function isListLine(line: string): boolean {
  return ORDERED_LIST_RE.test(line) || UNORDERED_LIST_RE.test(line);
}

function isIndentedContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line);
}

function splitOversizedText(text: string, maxChars: number): string[] {
  const slices: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    slices.push(text.slice(cursor, cursor + maxChars).trim());
    cursor += maxChars;
  }
  return slices.filter(Boolean);
}

function collectRegionBoxes(blocks: CanonicalBlock[]): LayoutRegion[] {
  const boxes: LayoutRegion[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    if (!block.bbox || block.pageNumber == null) {
      continue;
    }
    const key = [block.pageNumber, block.bbox.x, block.bbox.y, block.bbox.width, block.bbox.height].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    boxes.push({
      pageNumber: block.pageNumber,
      x: block.bbox.x,
      y: block.bbox.y,
      width: block.bbox.width,
      height: block.bbox.height,
      polygon: rectToPolygon(block.bbox)
    });
  }

  return boxes;
}

function collectRegionCoordinateSpace(blocks: CanonicalBlock[]): string | null {
  for (const block of blocks) {
    const coordinateSpace = block.metadata?.bboxCoordinateSpace;
    if (typeof coordinateSpace === "string" && coordinateSpace.trim().length > 0) {
      return coordinateSpace;
    }
  }
  return null;
}

function collectSourceTrace(blocks: CanonicalBlock[]): SourceTrace {
  const pageNumbers = normalizePageNumbers(blocks.map((block) => block.pageNumber));
  const blockIds = blocks.map((block) => block.id);
  const sourceArtifactUri = blocks.find((block) => typeof block.metadata?.sourceArtifactUri === "string")?.metadata?.sourceArtifactUri;
  const parserArtifactUri = blocks.find((block) => typeof block.metadata?.parserArtifactUri === "string")?.metadata?.parserArtifactUri;
  const canonicalDocumentUri = blocks.find((block) => typeof block.metadata?.canonicalDocumentUri === "string")?.metadata?.canonicalDocumentUri;
  const extractor = blocks.find((block) => typeof block.metadata?.extractor === "string")?.metadata?.extractor;

  return {
    canonicalDocumentUri: typeof canonicalDocumentUri === "string" ? canonicalDocumentUri : null,
    parserArtifactUri: typeof parserArtifactUri === "string" ? parserArtifactUri : null,
    sourceArtifactUri: typeof sourceArtifactUri === "string" ? sourceArtifactUri : null,
    blockIds,
    pageNumbers,
    extractor: typeof extractor === "string" ? extractor : null
  };
}

function rectToPolygon(bbox: { x: number; y: number; width: number; height: number }) {
  return [
    { x: bbox.x, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y },
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
    { x: bbox.x, y: bbox.y + bbox.height }
  ];
}

function buildTableChunks(
  block: CanonicalBlock,
  maxChars: number
): Array<Omit<CanonicalChunk, "chunkIndex" | "overlapIndex">> {
  if (/^\s*<table(?=\s|>|$)/i.test(block.text)) {
    return [...tableChunks(block.text.trim(), maxChars, block.order + 1)]
      .map(text => materializeChunk(text, [block], { tableGranularity: "table" }));
  }
  const parsed = parseMarkdownTable(block.text);
  const chunks = materializeOversizedBlock(block, maxChars, {
    tableGranularity: "table",
    tableRowCount: parsed?.rowCount ?? null,
    tableColumnNames: parsed?.columnNames ?? [],
    tableColumnTypes: parsed?.columnTypes ?? []
  });

  if (!parsed || parsed.rows.length === 0) {
    return chunks;
  }

  for (const row of parsed.rows) {
    const rowCells = row.cells.map((cell) => withBlockFallbackGeometry(cell, block));
    const rowText = [
      `Table row ${row.rowIndex + 1} of ${parsed.rowCount}.`,
      ...rowCells.map((cell) => `${cell.columnName}: ${cell.rawValue || "(empty)"}`)
    ].join("\n");

    chunks.push(materializeChunk(rowText, [block], {
      tableGranularity: "row",
      tableRowIndex: row.rowIndex,
      tableRowCount: parsed.rowCount,
      tableColumnNames: parsed.columnNames,
      tableColumnTypes: parsed.columnTypes,
      tableCells: rowCells
    }));

    for (const cell of rowCells) {
      const cellText = [
        `Table cell from row ${row.rowIndex + 1} of ${parsed.rowCount}.`,
        `${cell.columnName}: ${cell.rawValue || "(empty)"}`
      ].join("\n");

      chunks.push(materializeChunk(cellText, [block], {
        tableGranularity: "cell",
        tableRowIndex: row.rowIndex,
        tableRowCount: parsed.rowCount,
        tableColumnNames: parsed.columnNames,
        tableColumnTypes: parsed.columnTypes,
        tableCells: row.cells,
        tableCell: cell
      }));
    }
  }

  return chunks;
}

function withBlockFallbackGeometry(cell: TableCell, block: CanonicalBlock): TableCell {
  if (!block.bbox || block.pageNumber == null) {
    return cell;
  }
  return {
    ...cell,
    pageNumber: cell.pageNumber ?? block.pageNumber,
    bbox: cell.bbox ?? block.bbox,
    polygon: cell.polygon ?? rectToPolygon(block.bbox),
    coordinateSpace: cell.coordinateSpace ?? (typeof block.metadata?.bboxCoordinateSpace === "string" ? block.metadata.bboxCoordinateSpace : null),
    geometrySource: cell.geometrySource ?? "block-fallback"
  };
}

function materializeOversizedBlock(
  block: CanonicalBlock,
  maxChars: number,
  tableMetadata?: Partial<Pick<
    CanonicalChunk,
    "tableGranularity" | "tableRowIndex" | "tableRowCount" | "tableColumnNames" | "tableColumnTypes" | "tableCells" | "tableCell"
  >>
): Array<Omit<CanonicalChunk, "chunkIndex" | "overlapIndex">> {
  const blockText = block.text.trim();
  if (!blockText) {
    return [];
  }

  if (blockText.length <= maxChars) {
    return [materializeChunk(blockText, [block], tableMetadata)];
  }

  return splitOversizedText(blockText, maxChars).map((text) => materializeChunk(text, [block], tableMetadata));
}

function parseMarkdownTable(text: string): {
  columnNames: string[];
  columnTypes: TableCellValueType[];
  rowCount: number;
  rows: Array<{ rowIndex: number; cells: TableCell[] }>;
} | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return null;
  }

  const headerCells = splitMarkdownTableCells(lines[0] ?? "");
  const separatorCells = splitMarkdownTableCells(lines[1] ?? "");
  if (headerCells.length === 0 || separatorCells.length === 0) {
    return null;
  }

  const columnNames = headerCells.map((cell, index) => cell || `Column ${index + 1}`);
  const bodyLines = lines.slice(2).filter((line) => isTableLine(line));
  const rawRows = bodyLines.map((line) => normalizeTableRow(splitMarkdownTableCells(line), columnNames.length));
  const columnTypes = columnNames.map((_, columnIndex) => inferColumnValueType(rawRows.map((row) => row[columnIndex] ?? "")));
  const rows = rawRows.map((row, rowIndex) => ({
    rowIndex,
    cells: row.map((rawValue, columnIndex) => buildTableCell(columnIndex, columnNames[columnIndex]!, rawValue))
  }));

  return {
    columnNames,
    columnTypes,
    rowCount: rows.length,
    rows
  };
}

function splitMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function normalizeTableRow(cells: string[], width: number): string[] {
  const normalized = cells.slice(0, width);
  while (normalized.length < width) {
    normalized.push("");
  }
  return normalized;
}

function buildTableCell(columnIndex: number, columnName: string, rawValue: string): TableCell {
  const valueType = inferCellValueType(rawValue);
  return {
    columnIndex,
    columnName,
    rawValue,
    valueType,
    typedValue: coerceTypedCellValue(rawValue, valueType)
  };
}

function inferColumnValueType(values: string[]): TableCellValueType {
  const nonEmpty = values
    .map((value) => inferCellValueType(value))
    .filter((value) => value !== "empty");

  if (nonEmpty.length === 0) {
    return "empty";
  }

  const distinct = [...new Set(nonEmpty)];
  return distinct.length === 1 ? distinct[0]! : "string";
}

function inferCellValueType(value: string): TableCellValueType {
  const trimmed = value.trim();
  if (!trimmed) {
    return "empty";
  }
  if (/^(true|false|yes|no)$/i.test(trimmed)) {
    return "boolean";
  }
  if (/^[+-]?\d+(\.\d+)?%$/.test(trimmed)) {
    return "percentage";
  }
  if (/^[$€£]\s*[+-]?\d[\d,]*(\.\d+)?$/.test(trimmed)) {
    return "currency";
  }
  if (/^[+-]?\d[\d,]*(\.\d+)?$/.test(trimmed)) {
    return "number";
  }
  if (normalizeDateValue(trimmed)) {
    return "date";
  }
  return "string";
}

function coerceTypedCellValue(value: string, valueType: TableCellValueType): string | number | boolean | null {
  const trimmed = value.trim();
  if (valueType === "empty") {
    return null;
  }
  if (valueType === "boolean") {
    return /^(true|yes)$/i.test(trimmed);
  }
  if (valueType === "percentage") {
    return Number.parseFloat(trimmed.replace(/%$/, ""));
  }
  if (valueType === "currency") {
    return Number.parseFloat(trimmed.replace(/[^\d.+-]/g, ""));
  }
  if (valueType === "number") {
    return Number.parseFloat(trimmed.replace(/,/g, ""));
  }
  if (valueType === "date") {
    return normalizeDateValue(trimmed) ?? trimmed;
  }
  return trimmed;
}

function normalizeDateValue(value: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const monthDayYear = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (monthDayYear) {
    const [, month, day, year] = monthDayYear;
    return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}
