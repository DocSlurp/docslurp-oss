import { MAX_LOCATOR_BOXES, type CanonicalBlock, type CitationLocator, type NormalizedBox, type TableCell, type TableChunkGranularity } from "@docslurp/shared";

/** Longest stretch of a recording one chunk may cover, so a hit never points at a vague 10-minute span. */
export const MAX_MEDIA_CHUNK_SECONDS = 90;
/** Silence or unrelated material longer than this splits chunks even if the span cap is not reached. */
export const MAX_MEDIA_CHUNK_GAP_SECONDS = 20;

/**
 * A speaker change only closes a chunk once the chunk has this much text and the incoming turn is not a tiny reply
 * ("Yeah.", "Right."). Tiny turns stay in the chunk text (which keeps their speaker label), so diarization does not
 * multiply chunks and embedding calls; the chunk locator keeps the dominant speaker and the full time span.
 */
export const MIN_SPEAKER_CHUNK_CHARS = 500;
export const MIN_SPEAKER_TURN_CHARS = 48;

export interface BlockMediaMeta {
  media: "audio" | "video"; mode: "said" | "shown"; start: number; end: number; speaker: string | null;
  timing: "word" | "segment" | "chunk"; frameSeconds: number[]; durationSeconds: number | null;
}
export interface BlockSlideMeta { number: number; count: number | null; title: string | null; notes: boolean; box: NormalizedBox | null; }
export interface BlockSheetMeta { name: string | null; headerRow: number | null; firstRow: number; firstCol: number; colCount: number; rowNumbers: number[] | null; lastRow: number | null; }

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function readMediaMeta(block: CanonicalBlock): BlockMediaMeta | null {
  const m = block.metadata;
  if (!m || (m.mode !== "said" && m.mode !== "shown") || !num(m.startSeconds) || !num(m.endSeconds)) return null;
  return {
    media: m.mediaKind === "video" ? "video" : "audio", mode: m.mode, start: m.startSeconds, end: Math.max(m.startSeconds, m.endSeconds),
    speaker: typeof m.speaker === "string" ? m.speaker : null,
    timing: m.timing === "word" || m.timing === "chunk" ? m.timing : "segment",
    frameSeconds: Array.isArray(m.frameSeconds) ? m.frameSeconds.filter(num) : [],
    durationSeconds: num(m.durationSeconds) ? m.durationSeconds : null,
  };
}
export function readSlideMeta(block: CanonicalBlock): BlockSlideMeta | null {
  const s = block.metadata?.slide as Record<string, unknown> | undefined;
  if (!s || !num(s.number) || s.number < 1) return null;
  return { number: s.number, count: num(s.count) ? s.count : null, title: typeof s.title === "string" && s.title ? s.title : null,
    notes: s.notes === true, box: readBox(s.box) };
}
export function readSheetMeta(block: CanonicalBlock): BlockSheetMeta | null {
  const s = block.metadata?.sheet as Record<string, unknown> | undefined;
  if (!s || !num(s.firstRow) || !num(s.firstCol) || !num(s.colCount)) return null;
  return { name: typeof s.name === "string" ? s.name : null, headerRow: num(s.headerRow) ? s.headerRow : null,
    firstRow: s.firstRow, firstCol: s.firstCol, colCount: s.colCount,
    rowNumbers: Array.isArray(s.rowNumbers) && s.rowNumbers.every(num) ? s.rowNumbers as number[] : null,
    lastRow: num(s.lastRow) ? s.lastRow : null };
}
function readBox(v: unknown): NormalizedBox | null {
  const b = v as Record<string, unknown> | null | undefined;
  return b && num(b.x) && num(b.y) && num(b.width) && num(b.height) ? clampBox({ x: b.x, y: b.y, width: b.width, height: b.height }) : null;
}
function clampBox(b: NormalizedBox): NormalizedBox {
  const c = (n: number) => Math.min(1, Math.max(0, n));
  const x = c(b.x); const y = c(b.y);
  return { x: round(x), y: round(y), width: round(Math.min(c(b.width), 1 - x)), height: round(Math.min(c(b.height), 1 - y)) };
}
const round = (n: number) => Math.round(n * 10000) / 10000;

/** 1 -> A, 27 -> AA. */
export function columnLetters(index: number): string {
  let n = Math.max(1, Math.floor(index)); let out = "";
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}
export const a1 = (col: number, row: number) => `${columnLetters(col)}${row}`;

/**
 * Should `next` start a new chunk? Evidence that is drawn differently must not share a chunk: a different
 * slide (or slide vs. its notes), a different sheet, or media that changes speaker/mode, stretches past
 * the span cap or follows a long gap.
 */
export function evidenceBoundary(current: CanonicalBlock[], next: CanonicalBlock, currentChars = Number.POSITIVE_INFINITY): boolean {
  const last = current[current.length - 1];
  if (last) {
    const a = readSlideMeta(last); const b = readSlideMeta(next);
    if ((a || b) && (a?.number !== b?.number || a?.notes !== b?.notes)) return true;
    const sa = readSheetMeta(last); const sb = readSheetMeta(next);
    if ((sa || sb) && sa?.name !== sb?.name) return true;
  }
  return mediaBoundary(current, next, currentChars);
}

function mediaBoundary(current: CanonicalBlock[], next: CanonicalBlock, currentChars: number): boolean {
  const n = readMediaMeta(next);
  const first = current[0] && readMediaMeta(current[0]);
  const last = current.length ? readMediaMeta(current[current.length - 1]!) : null;
  if (!n && !first) return false;
  if (!n || !first || !last) return current.length > 0;
  if (n.mode === "shown" || first.mode === "shown") return true;
  const speakerChange = n.speaker !== last.speaker && currentChars >= MIN_SPEAKER_CHUNK_CHARS && next.text.trim().length >= MIN_SPEAKER_TURN_CHARS;
  return speakerChange || n.end - first.start > MAX_MEDIA_CHUNK_SECONDS || n.start - last.end > MAX_MEDIA_CHUNK_GAP_SECONDS;
}

export function blockBox(block: CanonicalBlock): NormalizedBox | null {
  const bbox = block.bbox; const m = block.metadata ?? {};
  if (!bbox) return null;
  const space = typeof m.bboxCoordinateSpace === "string" ? m.bboxCoordinateSpace.toLowerCase() : "";
  if (space.includes("normalized")) return clampBox(bbox);
  const pw = m.pageWidth; const ph = m.pageHeight;
  if (!num(pw) || !num(ph) || pw <= 0 || ph <= 0) return null;
  const y = space.includes("bottom-left") ? ph - bbox.y - bbox.height : bbox.y;
  if (bbox.width <= 0 || bbox.height <= 0) return null;
  return clampBox({ x: bbox.x / pw, y: y / ph, width: bbox.width / pw, height: bbox.height / ph });
}

function dominant<T>(items: Array<[T, number]>): T | null {
  const totals = new Map<T, number>();
  for (const [key, weight] of items) totals.set(key, (totals.get(key) ?? 0) + weight);
  let best: T | null = null; let bestWeight = -1;
  for (const [key, weight] of totals) if (weight > bestWeight) { best = key; bestWeight = weight; }
  return best;
}

export interface LocatorContext {
  /** Set for image sources: pages are one flat picture, not paginated text. */
  sourceKind?: "image" | null;
  table?: { granularity: TableChunkGranularity | null; rowIndex: number | null; cell: TableCell | null };
  /** Offsets of this chunk inside the first block's text (oversized-block splits). */
  slice?: { start: number; end: number } | null;
}

export function buildChunkLocator(blocks: CanonicalBlock[], context: LocatorContext = {}): CitationLocator | null {
  if (!blocks.length) return null;
  const media = blocks.map(readMediaMeta);
  if (media.every(Boolean)) {
    const m = media as BlockMediaMeta[];
    const rank = { word: 2, segment: 1, chunk: 0 } as const;
    let startSeconds = Math.min(...m.map(x => x.start)); let endSeconds = Math.max(...m.map(x => x.end));
    let sliceTiming: "chunk" | null = null;
    const textLength = blocks[0]!.text.trim().length;
    if (context.slice && m.length === 1 && textLength > 0 && context.slice.end > context.slice.start) {
      // One long segment split by size: place each piece proportionally instead of repeating the whole span.
      const span = endSeconds - startSeconds;
      endSeconds = round(startSeconds + span * Math.min(1, context.slice.end / textLength));
      startSeconds = round(startSeconds + span * Math.min(1, context.slice.start / textLength));
      sliceTiming = "chunk";
    }
    return {
      kind: "media", media: m[0]!.media,
      startSeconds, endSeconds: Math.max(startSeconds, endSeconds),
      durationSeconds: m[0]!.durationSeconds, mode: m.some(x => x.mode === "shown") ? "shown" : "said",
      speaker: dominant(m.flatMap((x, i): Array<[string, number]> => x.speaker ? [[x.speaker, Math.max(1, blocks[i]?.text.length ?? 1)]] : [])),
      timing: sliceTiming ?? m.reduce((lowest, x) => rank[x.timing] < rank[lowest] ? x.timing : lowest, m[0]!.timing),
      frameSeconds: [...new Set(m.flatMap(x => x.frameSeconds))].sort((a, b) => a - b), boxes: [],
    };
  }
  const slides = blocks.map(readSlideMeta);
  if (slides[0] && slides.every(s => s && s.number === slides[0]!.number)) {
    const s = slides as BlockSlideMeta[];
    return { kind: "slide", slideNumber: s[0]!.number, slideCount: s[0]!.count, notes: s.every(x => x.notes),
      title: s.find(x => x.title)?.title ?? null, boxes: s.map(x => x.box).filter((b): b is NormalizedBox => b !== null).slice(0, MAX_LOCATOR_BOXES) };
  }
  const sheets = blocks.map(readSheetMeta);
  if (sheets[0] && sheets.every(s => s && s.name === sheets[0]!.name)) {
    const sheet = sheets[0];
    const range = sheetRange(sheet, context.table);
    if (range) return { kind: "sheet", sheetName: sheet.name, range, headerRow: sheet.headerRow };
  }
  const boxes = blocks.map(blockBox).filter((b): b is NormalizedBox => b !== null).slice(0, MAX_LOCATOR_BOXES);
  if (context.sourceKind === "image") return { kind: "image", boxes };
  const pages = [...new Set(blocks.map(b => b.pageNumber).filter((p): p is number => p !== null))];
  if (!pages.length) return null;
  const pageNumber = pages[0]!;
  const onPage = blocks.filter(b => b.pageNumber === pageNumber);
  const starts = onPage.map(b => b.metadata?.charStart).filter(num);
  const ends = onPage.map(b => b.metadata?.charEnd).filter(num);
  let charStart: number | null = starts.length === onPage.length && starts.length ? Math.min(...starts) : null;
  let charEnd: number | null = ends.length === onPage.length && ends.length ? Math.max(...ends) : null;
  if (context.slice && charStart !== null && onPage.length === 1) { charEnd = charStart + context.slice.end; charStart += context.slice.start; }
  return { kind: "page", pageNumber, charStart, charEnd, boxes: onPage.map(blockBox).filter((b): b is NormalizedBox => b !== null).slice(0, MAX_LOCATOR_BOXES) };
}

function sheetRange(sheet: BlockSheetMeta, table?: LocatorContext["table"]): string | null {
  const lastCol = sheet.firstCol + Math.max(1, sheet.colCount) - 1;
  const header = sheet.headerRow ?? sheet.firstRow;
  const rows = sheet.rowNumbers?.length ? sheet.rowNumbers : null;
  if (!rows) {
    // Without exact source row numbers (blank rows were dropped, or the scan was bounded) a row index would cite the
    // wrong row, so only the table itself is located: header through the last known row, never a guessed row or cell.
    return `${a1(sheet.firstCol, header)}:${a1(lastCol, Math.max(header, sheet.lastRow ?? header))}`;
  }
  const rowNumber = (index: number) => rows[index];
  if (table?.granularity === "cell" && table.rowIndex !== null && table.cell && rowNumber(table.rowIndex) !== undefined) {
    return a1(sheet.firstCol + table.cell.columnIndex, rowNumber(table.rowIndex)!);
  }
  if (table?.granularity === "row" && table.rowIndex !== null && rowNumber(table.rowIndex) !== undefined) {
    const row = rowNumber(table.rowIndex)!;
    return `${a1(sheet.firstCol, row)}:${a1(lastCol, row)}`;
  }
  const bottom = rows.reduce((max, r) => Math.max(max, r), header);
  return `${a1(sheet.firstCol, header)}:${a1(lastCol, bottom)}`;
}

/** Combine the locators of two neighboring chunks into the span of an overlap chunk. */
export function mergeLocators(a: CitationLocator | null | undefined, b: CitationLocator | null | undefined): CitationLocator | null {
  if (!a || !b || a.kind !== b.kind) return a ?? b ?? null;
  if (a.kind === "media" && b.kind === "media") {
    return { ...a, startSeconds: Math.min(a.startSeconds, b.startSeconds), endSeconds: Math.max(a.endSeconds, b.endSeconds),
      mode: a.mode === b.mode ? a.mode : "said", speaker: a.speaker === b.speaker ? a.speaker : null,
      frameSeconds: [...new Set([...a.frameSeconds, ...b.frameSeconds])].sort((x, y) => x - y) };
  }
  if (a.kind === "page" && b.kind === "page") {
    return a.pageNumber === b.pageNumber
      ? { ...a, charStart: a.charStart !== null && b.charStart !== null ? Math.min(a.charStart, b.charStart) : null,
        charEnd: a.charEnd !== null && b.charEnd !== null ? Math.max(a.charEnd, b.charEnd) : null, boxes: [...a.boxes, ...b.boxes].slice(0, MAX_LOCATOR_BOXES) }
      : a;
  }
  return a;
}
