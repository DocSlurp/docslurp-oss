import type { CanonicalBlock, CanonicalDocument, NormalizedBox } from "@docslurp/shared";

/**
 * Presentation and spreadsheet structure from the python-pptx / openpyxl sidecars, matched onto the
 * canonical blocks built from the general-purpose Markdown extraction. The Markdown stays the source
 * of text; this only adds *where* it came from (slide + shape box, sheet + A1 range). It never throws on
 * a mismatch: blocks it cannot place simply keep no slide/sheet metadata.
 */

const norm = (text: string) => text.toLowerCase().replace(/^#{1,6}\s+/gm, "").replace(/[*_`>|\\]/g, " ").replace(/\s+/g, " ").trim();
const isBox = (v: unknown): v is NormalizedBox => {
  const b = v as Record<string, unknown> | null;
  return !!b && ["x", "y", "width", "height"].every(k => typeof b[k] === "number" && Number.isFinite(b[k] as number));
};

interface PptxShape { text: string; norm: string; box: NormalizedBox | null }
interface PptxSlide { number: number; title: string | null; notes: string; shapes: PptxShape[] }

function readSlides(payload: unknown): PptxSlide[] {
  const slides = (payload as { slides?: unknown })?.slides;
  if (!Array.isArray(slides)) return [];
  return slides.map((raw, i): PptxSlide => {
    const s = raw as Record<string, unknown>;
    const shapes = Array.isArray(s.shapes) ? s.shapes : [];
    return {
      number: typeof s.index === "number" && s.index > 0 ? s.index : i + 1,
      title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : null,
      notes: typeof s.notes === "string" ? s.notes.trim() : "",
      shapes: shapes.flatMap((sh): PptxShape[] => {
        const text = (sh as { text?: unknown }).text;
        return typeof text === "string" && text.trim()
          ? [{ text, norm: norm(text), box: isBox((sh as { box?: unknown }).box) ? (sh as { box: NormalizedBox }).box : null }] : [];
      }),
    };
  });
}

/** Shorter blocks ("Q3", "Yes", "2") are too ambiguous to place by substring; they must equal a shape or one of its lines. */
const MIN_SUBSTRING_CHARS = 8;

function matchShape(blockNorm: string, slide: PptxSlide, allowShort: boolean): PptxShape | undefined {
  const exact = slide.shapes.find(s => s.norm === blockNorm);
  if (exact) return exact;
  if (blockNorm.length < MIN_SUBSTRING_CHARS) {
    // A short block may be one line of a larger shape, but only on the slide we are already on (never by looking ahead).
    return allowShort ? slide.shapes.find(s => s.text.split("\n").some(line => norm(line) === blockNorm)) : undefined;
  }
  return slide.shapes.find(s => s.norm.includes(blockNorm) || (s.norm.length >= MIN_SUBSTRING_CHARS && blockNorm.includes(s.norm)));
}

export function enrichCanonicalDocumentWithPptx(document: CanonicalDocument, payload: unknown): CanonicalDocument {
  const slides = readSlides(payload);
  if (!slides.length || !document.blocks.length) return document;
  const count = (payload as { slideCount?: unknown }).slideCount;
  const slideCount = typeof count === "number" && count > 0 ? count : slides.length;
  let cursor = 0;
  let placed = 0;
  const lastBlockOfSlide = new Map<number, number>();
  const annotated: CanonicalBlock[] = document.blocks.map((block, index) => {
    const text = norm(block.text);
    let slideIndex = -1;
    let shape: PptxShape | undefined;
    if (text) {
      for (let k = 0; k < slides.length && !shape; k++) {
        const candidate = (cursor + k) % slides.length;
        const found = matchShape(text, slides[candidate]!, k === 0);
        if (found) { shape = found; slideIndex = candidate; }
      }
    }
    // An unplaced heading may open the next slide, so it must not be pinned to the previous one; other unplaced
    // blocks (continuations) stay with the slide we are on, without a box.
    if (shape) { cursor = slideIndex; placed++; } else slideIndex = placed > 0 && block.type !== "heading" ? cursor : -1;
    if (slideIndex < 0) return block;
    const slide = slides[slideIndex]!;
    lastBlockOfSlide.set(slideIndex, index);
    return { ...block, metadata: { ...block.metadata, slide: { number: slide.number, count: slideCount, title: slide.title, notes: false, box: shape?.box ?? null } } };
  });
  if (placed === 0) return document;
  // An unplaced heading introduces what follows it: give it the slide of the next block (the Markdown order is slide order),
  // so it neither joins the previous slide nor becomes a heading-only chunk of its own.
  for (let i = annotated.length - 2; i >= 0; i--) {
    const block = annotated[i]!;
    const next = annotated[i + 1]!;
    if (block.type === "heading" && !block.metadata?.slide && next.metadata?.slide) {
      const slide = next.metadata.slide as Record<string, unknown>;
      annotated[i] = { ...block, metadata: { ...block.metadata, slide: { ...slide, notes: false, box: null } } };
    }
  }

  // Speaker notes are not in the Markdown extraction; index them as their own blocks after their slide.
  const out: CanonicalBlock[] = [];
  annotated.forEach((block, index) => {
    out.push(block);
    for (const [slideIndex, last] of lastBlockOfSlide) {
      const slide = slides[slideIndex]!;
      if (last === index && slide.notes) {
        out.push({ id: "", type: "paragraph", order: 0, text: slide.notes, headingPath: [slide.title ?? `Slide ${slide.number}`, "Speaker notes"],
          pageNumber: block.pageNumber, lineStart: null, lineEnd: null, bbox: null,
          metadata: { slide: { number: slide.number, count: slideCount, title: slide.title, notes: true, box: null } } });
      }
    }
  });
  return renumber(document, out);
}

function renumber(document: CanonicalDocument, blocks: CanonicalBlock[]): CanonicalDocument {
  const prefix = `${document.documentId}:block:`;
  const numbered = blocks.map((block, order) => ({ ...block, order, id: block.id && blocks.length === document.blocks.length ? block.id : `${prefix}${String(order).padStart(4, "0")}` }));
  const count = (type: CanonicalBlock["type"]) => numbered.filter(b => b.type === type).length;
  return { ...document, generator: `${document.generator}+office-structure@v1`, blocks: numbered,
    stats: { ...document.stats, blockCount: numbered.length, headingCount: count("heading"), paragraphCount: count("paragraph"), tableCount: count("table") } };
}

// ---------------------------------------------------------------------------------------------

interface SheetInfo { name: string; norm: string; firstRow: number; firstCol: number; headerRow: number; lastRow: number | null; dataRows: number[]; header: string[] }
/** Exact row numbers ride on every table block; beyond this a table is located as a whole instead. */
const MAX_LOCATOR_ROWS = 50_000;

/** First `limit` records of a CSV, honoring quoted fields (including embedded newlines). */
export function csvRecords(csv: string, limit: number): string[][] {
  const records: string[][] = [];
  let field = ""; let row: string[] = []; let quoted = false;
  for (let i = 0; i < csv.length && records.length < limit; i++) {
    const ch = csv[i]!;
    if (quoted) {
      if (ch === '"' && csv[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && csv[i + 1] === "\n") i++;
      row.push(field); field = ""; records.push(row); row = [];
    } else field += ch;
  }
  if (records.length < limit && (field || row.length)) { row.push(field); records.push(row); }
  return records;
}

function readSheets(payload: unknown): SheetInfo[] {
  const sheets = (payload as { sheets?: unknown })?.sheets;
  if (!Array.isArray(sheets)) return [];
  return sheets.flatMap((raw): SheetInfo[] => {
    const s = raw as Record<string, unknown>;
    if (typeof s.name !== "string" || typeof s.firstRow !== "number" || typeof s.firstCol !== "number" || typeof s.headerRow !== "number") return [];
    const records = typeof s.csv === "string" ? csvRecords(s.csv, s.headerRow) : [];
    const lastCol = typeof s.lastCol === "number" ? s.lastCol : s.firstCol;
    const header = (records[s.headerRow - 1] ?? []).slice(s.firstCol - 1, lastCol).map(norm);
    return [{ name: s.name, norm: norm(s.name), firstRow: s.firstRow, firstCol: s.firstCol, headerRow: s.headerRow, header,
      lastRow: typeof s.lastRow === "number" ? s.lastRow : null,
      dataRows: s.truncated === true ? [] : Array.isArray(s.dataRows) ? s.dataRows.filter((n): n is number => typeof n === "number") : [] }];
  });
}

function markdownTableShape(text: string): { header: string[]; bodyRows: number } | null {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 2 || !/\|\s*[-:]+/.test(lines[1]!)) return null;
  const cells = (line: string) => line.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(c => norm(c));
  return { header: cells(lines[0]!), bodyRows: lines.length - 2 };
}

export function enrichCanonicalDocumentWithXlsx(document: CanonicalDocument, payload: unknown): CanonicalDocument {
  const sheets = readSheets(payload);
  if (!sheets.length) return document;
  const used = new Set<string>();
  let current: SheetInfo | undefined;
  let placed = 0;
  const blocks = document.blocks.map((block): CanonicalBlock => {
    if (block.type === "heading") {
      const named = sheets.find(s => s.norm === norm(block.text));
      if (named) { current = named; return withSheet(block, named, named.header.length || 1, null); }
      return block;
    }
    if (block.type !== "table") return block;
    const table = markdownTableShape(block.text);
    if (!table) return block;
    const joined = table.header.join("|");
    const matches = (s: SheetInfo) => s.header.join("|") === joined;
    const sheet = (current && !used.has(current.name) && matches(current) ? current : undefined)
      ?? sheets.find(s => !used.has(s.name) && matches(s))
      ?? (current && !used.has(current.name) ? current : undefined);
    if (!sheet) return block;
    used.add(sheet.name); current = sheet; placed++;
    // Row numbers are exact when the Markdown kept every non-empty row; otherwise fall back to header-relative order.
    const rowNumbers = sheet.dataRows.length === table.bodyRows && table.bodyRows <= MAX_LOCATOR_ROWS ? sheet.dataRows : null;
    return withSheet(block, sheet, table.header.length, rowNumbers);
  });
  if (placed === 0) return document;
  return { ...document, generator: `${document.generator}+office-structure@v1`, blocks };
}

function withSheet(block: CanonicalBlock, sheet: SheetInfo, colCount: number, rowNumbers: number[] | null): CanonicalBlock {
  return { ...block, metadata: { ...block.metadata, sheet: { name: sheet.name, headerRow: sheet.headerRow, firstRow: sheet.firstRow,
    firstCol: sheet.firstCol, colCount, rowNumbers, lastRow: sheet.lastRow } } };
}
