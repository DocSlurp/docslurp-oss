/**
 * HTML tables in vision-model page transcriptions: read in the parser VM, validated and rendered on the host.
 *
 * The page transcription prompts let a model write a table with merged cells or a multi-row header as an HTML `<table>`.
 * Model output is untrusted (the page image can carry instructions), so its HTML is parsed only by the VM guest
 * (`vision-tables-guest.ts`, parse5) in the service profile. The host never tokenizes, entity-decodes or builds a tree
 * from model text: it checks the guest's typed result (contiguous offsets into the page, integer spans, bounded
 * strings), then renders each table itself from that data:
 *
 * - elements `table`, `thead`, `tbody`, `tr`, `th`, `td` only, attributes `rowspan`/`colspan` only;
 * - cell text with controls, lone surrogates and noncharacters removed, whitespace collapsed, `& < > "` escaped;
 * - geometry checked on the typed grid: a rectangle whose spans never overlap and at most MAX_COLUMNS wide. Overlapping
 *   spans are dropped to a plain grid; short rows are padded; a grid wider than MAX_COLUMNS becomes plain text lines;
 * - a table larger than the app renderer accepts (RENDER_MAX_CHARS characters / RENDER_MAX_TAGS tags) becomes a GFM
 *   pipe table, so every kept table renders.
 * Everything outside a table region is copied verbatim; stray table tags outside a table are escaped.
 *
 * Fail closed: if the VM path is unavailable or its result is invalid, the page's table tags are escaped (the model's
 * text is kept, as text). The service profile never falls back to parsing on the host.
 *
 * Only tables are rebuilt. Raw HTML outside a table in model output is passed through as written, exactly as before
 * this pass existed: its safety rests on every consumer's own allow-list (the app renders Markdown with `skipHtml` and
 * rebuilds tables from its own parse5 allow-list; artifacts are served as text/markdown or under `default-src 'none'`;
 * the SDK widget uses textContent). Do not describe or rely on this pass as a general HTML sanitizer.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import type { CommandRunner } from "../tools/runner.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import {
  readVisionTablesBatch,
  VISION_TABLE_MAX_CELLS,
  VISION_TABLE_MAX_PAGE_CHARS,
  VISION_TABLE_MAX_PAGES,
  VISION_TABLE_MAX_ROWS,
  VISION_TABLE_MAX_SPAN,
  VISION_TABLE_MAX_TEXT_CHARS,
  type VisionTableCell,
  type VisionTablePageResult,
  type VisionTableRow,
} from "./vision-tables-guest.js";

export const MAX_COLUMNS = 100;
/** The app's chat/inspector/embed table renderer refuses a table above either bound (chat-html-tables.ts). */
export const RENDER_MAX_CHARS = 65_536;
export const RENDER_MAX_TAGS = 1_024;
/** Grid slots a table's spans may cover before its spans are dropped (bounds host geometry work). */
const MAX_SLOTS = 200_000;
const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

const HAS_TABLE_MARKUP = /<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)[\s/>]/i;
const TABLE_FAMILY = /<(\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|colgroup|col)(?=[\s/>]))/gi;

/** Fail-closed fallback: every table-family tag's `<` escaped, so the model's table renders as text. */
export function escapeVisionTableTags(text: string): string {
  return text.replace(TABLE_FAMILY, "&lt;$1");
}

export const escapeHtmlText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Controls (C0, DEL, C1), lone surrogates and noncharacters out; whitespace collapsed. */
export function cleanCellText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cs}\p{Noncharacter_Code_Point}]/gu, " ").replace(/\s+/g, " ").trim();
}

export interface VisionTableStats { pages: number; tables: number; spansDropped: number; gfm: number; textFallback: number; escapedPages: number; vmMs: number; vmCalls: number }
const emptyStats = (): VisionTableStats => ({ pages: 0, tables: 0, spansDropped: 0, gfm: 0, textFallback: 0, escapedPages: 0, vmMs: 0, vmCalls: 0 });

class InvalidResult extends Error {}
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const isText = (value: unknown): value is string => typeof value === "string" && value.length <= VISION_TABLE_MAX_TEXT_CHARS;

function validRows(rows: unknown): VisionTableRow[] {
  if (!Array.isArray(rows) || rows.length > VISION_TABLE_MAX_ROWS) throw new InvalidResult("rows");
  let cells = 0;
  for (const row of rows as Array<Partial<VisionTableRow>>) {
    if (!row || typeof row.head !== "boolean" || !Array.isArray(row.cells)) throw new InvalidResult("row");
    cells += row.cells.length;
    if (cells > VISION_TABLE_MAX_CELLS) throw new InvalidResult("cells");
    for (const cell of row.cells as Array<Partial<VisionTableCell>>) {
      if (!cell || typeof cell.h !== "boolean" || !isInt(cell.rs, 1, VISION_TABLE_MAX_SPAN) || !isInt(cell.cs, 1, VISION_TABLE_MAX_SPAN) || !isText(cell.t)) throw new InvalidResult("cell");
    }
  }
  return rows as VisionTableRow[];
}

interface Placed { row: number; col: number; rs: number; cs: number; cell: VisionTableCell }
interface Grid { width: number; placed: Placed[]; spansDropped: boolean }

/** Occupied-slot placement of one section; null when spans overlap or the grid is too wide or too large. */
function place(rows: VisionTableRow[], spans: boolean): { width: number; placed: Placed[]; filled: number[] } | null {
  const occupied: Array<Set<number>> = rows.map(() => new Set());
  const placed: Placed[] = [];
  let width = 0;
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    let col = 0;
    for (const cell of rows[r]!.cells) {
      while (occupied[r]!.has(col)) col += 1;
      const rs = spans ? Math.min(cell.rs, rows.length - r) : 1;
      const cs = spans ? cell.cs : 1;
      if (col + cs > MAX_COLUMNS) return null;
      slots += rs * cs;
      if (slots > MAX_SLOTS) return null;
      for (let rr = r; rr < r + rs; rr++) for (let cc = col; cc < col + cs; cc++) {
        if (occupied[rr]!.has(cc)) return null;
        occupied[rr]!.add(cc);
      }
      placed.push({ row: r, col, rs, cs, cell });
      col += cs;
      width = Math.max(width, col);
    }
  }
  return { width, placed, filled: occupied.map((set) => set.size) };
}

/** Both sections as one rectangle: spans when they fit, else a plain grid; null when even the plain grid is too wide. */
function buildGrid(sections: VisionTableRow[][]): (Grid & { sections: Placed[][]; padded: VisionTableRow[][] }) | null {
  for (const spans of [true, false]) {
    const placedSections = sections.map((rows) => place(rows, spans));
    if (placedSections.some((p) => p === null)) continue;
    const width = Math.max(0, ...placedSections.map((p) => p!.width));
    // Pad each short row with empty cells: placement fills a row's first free slots, so the pad closes it.
    const padded = sections.map((rows, s) => rows.map((row, r) => {
      const missing = width - placedSections[s]!.filled[r]!;
      return missing > 0 ? { head: row.head, cells: [...row.cells.map((c) => spans ? c : { ...c, rs: 1, cs: 1 }), ...Array.from({ length: missing }, () => ({ h: row.head, rs: 1, cs: 1, t: "" }))] } : { head: row.head, cells: spans ? row.cells : row.cells.map((c) => ({ ...c, rs: 1, cs: 1 })) };
    }));
    const final = padded.map((rows) => place(rows, true));
    if (final.some((p, i) => p === null || (padded[i]!.length > 0 && (p.width !== width || p.filled.some((n) => n !== width))))) continue;
    return { width, placed: final.flatMap((p) => p!.placed), sections: final.map((p) => p!.placed), padded, spansDropped: !spans };
  }
  return null;
}

function renderHtml(sections: Placed[][]): string {
  const section = (placed: Placed[]) => {
    const rows: string[][] = [];
    for (const p of placed) (rows[p.row] ??= []).push(`<${p.cell.h ? "th" : "td"}${p.rs > 1 ? ` rowspan="${p.rs}"` : ""}${p.cs > 1 ? ` colspan="${p.cs}"` : ""}>${escapeHtmlText(cleanCellText(p.cell.t))}</${p.cell.h ? "th" : "td"}>`);
    return Array.from(rows, (cells) => `<tr>${(cells ?? []).join("")}</tr>`).join("\n");
  };
  let html = "<table>\n";
  if (sections[0]!.length) html += `<thead>\n${section(sections[0]!)}\n</thead>\n`;
  if (sections[1]!.length) html += `<tbody>\n${section(sections[1]!)}\n</tbody>\n`;
  return `${html}</table>`;
}

const gfmCell = (text: string) => cleanCellText(text).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;");

function renderGfm(width: number, sections: Placed[][], rowCounts: number[]): string {
  const lines: string[] = [];
  let offset = 0;
  const grid: string[][] = [];
  sections.forEach((placed, s) => {
    for (let r = 0; r < rowCounts[s]!; r++) grid.push(Array.from({ length: width }, () => ""));
    for (const p of placed) grid[offset + p.row]![p.col] = gfmCell(p.cell.t);
    offset += rowCounts[s]!;
  });
  grid.forEach((row, index) => {
    lines.push(`| ${row.join(" | ")} |`);
    if (index === 0) lines.push(`|${" --- |".repeat(width)}`);
  });
  return lines.join("\n");
}

function renderTable(rows: VisionTableRow[], stats: VisionTableStats): string {
  const sections = [rows.filter((r) => r.head && r.cells.length), rows.filter((r) => !r.head && r.cells.length)];
  if (!sections[0]!.length && !sections[1]!.length) return "";
  stats.tables += 1;
  const grid = buildGrid(sections);
  if (!grid) {
    // Wider than any renderer keeps: every cell's text, one row per line.
    stats.textFallback += 1;
    return [...sections[0]!, ...sections[1]!].map((row) => row.cells.map((c) => escapeHtmlText(cleanCellText(c.t))).filter(Boolean).join(" | ")).filter(Boolean).join("\n");
  }
  if (grid.spansDropped) stats.spansDropped += 1;
  const html = renderHtml(grid.sections);
  if (html.length <= RENDER_MAX_CHARS && (html.match(/</g)?.length ?? 0) <= RENDER_MAX_TAGS) return html;
  stats.gfm += 1;
  return renderGfm(grid.width, grid.sections, grid.padded.map((s) => s.length));
}

/** Render one page from the guest's result; throws InvalidResult on any contract violation. */
function renderPage(text: string, result: VisionTablePageResult, stats: VisionTableStats): string {
  if (result === null) {
    // The guest saw no table markup; the host's own presence check must agree.
    if (HAS_TABLE_MARKUP.test(text)) throw new InvalidResult("missed markup");
    return text;
  }
  if (result === false) { stats.escapedPages += 1; return escapeVisionTableTags(text); }
  if (!Array.isArray(result) || result.length > 2 * text.length + 1) throw new InvalidResult("segments");
  let cursor = 0;
  const out: string[] = [];
  // The last two characters written: a rope's slice would flatten it on every table (quadratic on many tables).
  let tail = "";
  const write = (part: string) => { if (!part) return; out.push(part); tail = part.length >= 2 ? part.slice(-2) : (tail + part).slice(-2); };
  for (const segment of result) {
    if (!segment || !isInt(segment.from, 0, text.length) || segment.from !== cursor || !isInt(segment.to, segment.from + 1, text.length)) throw new InvalidResult("offsets");
    cursor = segment.to;
    if (segment.k === "keep") { write(text.slice(segment.from, segment.to)); continue; }
    if (segment.k === "lt") {
      if (segment.to !== segment.from + 1 || text[segment.from] !== "<") throw new InvalidResult("lt");
      write("&lt;");
      continue;
    }
    if (segment.k !== "table" || !/^<table[\s/>]/i.test(text.slice(segment.from, segment.from + 7))) throw new InvalidResult("kind");
    const rows = validRows(segment.rows);
    if (!Array.isArray(segment.extra) || segment.extra.length > 4096 || !segment.extra.every(isText)) throw new InvalidResult("extra");
    const table = renderTable(rows, stats);
    const extra = segment.extra.map((t) => escapeHtmlText(cleanCellText(t))).filter(Boolean).join("\n\n");
    const block = [table, extra].filter(Boolean).join("\n\n");
    if (!block) continue;
    // A table is a block: a blank line on each side keeps it and the Markdown around it intact.
    const lead = out.length === 0 || tail === "\n\n" ? "" : tail.endsWith("\n") ? "\n" : "\n\n";
    const rest = text.slice(segment.to, segment.to + 2);
    const trail = segment.to >= text.length || rest.startsWith("\n\n") ? "" : rest.startsWith("\n") ? "\n" : "\n\n";
    write(lead + block + trail);
  }
  if (cursor !== text.length) throw new InvalidResult("coverage");
  return out.join("");
}

/** Validate and render every page; a page whose result breaks the contract is escaped instead (fail closed). */
export function renderVisionTablePages(texts: string[], results: unknown, stats: VisionTableStats = emptyStats()): string[] {
  if (!Array.isArray(results) || results.length !== texts.length) throw new InvalidResult("batch");
  return texts.map((text, index) => {
    try {
      return renderPage(text, results[index] as VisionTablePageResult, stats);
    } catch (error) {
      if (!(error instanceof InvalidResult)) throw error;
      console.error(`[vision-tables] invalid guest result page-index=${index} reason=${error.message}; table tags escaped`);
      stats.escapedPages += 1;
      return escapeVisionTableTags(text);
    }
  });
}

async function runGuest(pages: string[], runner: Pick<CommandRunner, "run">, signal?: AbortSignal): Promise<unknown[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-vision-tables-"));
  try {
    const input = path.join(dir, "pages.json"), output = path.join(dir, "tables.json");
    await writeFile(input, JSON.stringify(pages), { mode: 0o600 });
    await runner.run({ binary: "node", args: [path.join(resolveScriptsDir(), "vision-tables.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, signal);
    if ((await stat(output)).size > MAX_RESULT_BYTES) throw new Error("vision table result exceeds limit");
    const parsed = JSON.parse(await readFile(output, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== pages.length) throw new Error("invalid vision table result");
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Rebuild the HTML tables in a document's page transcriptions: all of the document's pages that hold table markup go to
 * the parser VM together (one round trip per MAX_BATCH_BYTES / VISION_TABLE_MAX_PAGES), never one call per page.
 * Outside the service profile the same guest code runs in-process. Never throws for a VM failure: those pages are escaped.
 */
export async function sanitizeVisionPageTables(
  texts: string[],
  runner: Pick<CommandRunner, "run"> | null | undefined,
  options: { signal?: AbortSignal; documentId?: string; vmOnly?: boolean } = {},
): Promise<{ texts: string[]; stats: VisionTableStats }> {
  const stats = emptyStats();
  const out = [...texts];
  const work = texts.map((text, index) => ({ text, index })).filter(({ text }) => HAS_TABLE_MARKUP.test(text));
  if (!work.length) return { texts: out, stats };
  stats.pages = work.length;
  const vmOnly = options.vmOnly ?? vmOnlyParsing();
  const fallback = (items: typeof work, reason: string) => {
    console.error(`[vision-tables] document=${options.documentId ?? "unknown"} pages=${items.length} ${reason}; table tags escaped (fail closed)`);
    for (const { text, index } of items) out[index] = escapeVisionTableTags(text);
    stats.escapedPages += items.length;
  };
  // Oversized pages are never parsed anywhere: escaped.
  const oversized = work.filter(({ text }) => text.length > VISION_TABLE_MAX_PAGE_CHARS);
  if (oversized.length) fallback(oversized, "page exceeds parse limit");
  const pending = work.filter(({ text }) => text.length <= VISION_TABLE_MAX_PAGE_CHARS);
  if (!vmOnly) {
    const rendered = renderVisionTablePages(pending.map((p) => p.text), readVisionTablesBatch(pending.map((p) => p.text)), stats);
    pending.forEach(({ index }, i) => { out[index] = rendered[i]!; });
    return { texts: out, stats };
  }
  if (!runner) { fallback(pending, "parser VM unavailable"); return { texts: out, stats }; }
  for (let start = 0; start < pending.length;) {
    const batch: typeof pending = [];
    let bytes = 2;
    while (start < pending.length && batch.length < VISION_TABLE_MAX_PAGES) {
      const size = Buffer.byteLength(JSON.stringify(pending[start]!.text)) + 1;
      if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
      batch.push(pending[start]!); bytes += size; start += 1;
    }
    const started = Date.now();
    try {
      const results = await runGuest(batch.map((p) => p.text), runner, options.signal);
      const rendered = renderVisionTablePages(batch.map((p) => p.text), results, stats);
      batch.forEach(({ index }, i) => { out[index] = rendered[i]!; });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      fallback(batch, `parser VM failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stats.vmMs += Date.now() - started;
      stats.vmCalls += 1;
    }
  }
  return { texts: out, stats };
}
