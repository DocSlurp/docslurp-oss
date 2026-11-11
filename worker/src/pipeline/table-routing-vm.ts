/**
 * HTML tables in extracted page Markdown, for born-digital table repair (extract-markdown) and table routing
 * (classify-route): scanned in the parser VM, validated on the host.
 *
 * Doppler's `--html` output passes PDF prose through unescaped and a model's transcription can write any HTML, so the
 * text is customer-controlled. In the service profile (`vmOnlyParsing`) the shared table scanner (`scanPageTables`)
 * runs only in the VM guest (`table-routing-guest.ts`); all of a document's pages that hold `<table` go together, in as
 * few jobs as MAX_BATCH_BYTES / TABLE_ROUTING_MAX_PAGES allow (one for nearly every document). The host checks the typed
 * result against the page (spans in order, inside the page, starting at `<table` and ending at `</table>`; cell text no
 * longer than its table's source; block counts matching its own presence count) before the shared repair and
 * reliability checks use it. Outside the service profile the same scanner runs in-process.
 *
 * Fail closed: a page the VM did not read (unavailable, failed, invalid result, too large for a job) gets `null`: no
 * HTML repair (repairMarkdownTables), `table:html-unscanned` from tableReliability, and no HTML table counted toward
 * table-heavy. Never a host scan.
 *
 * Host-side, without a scan: GFM pipe tables (line shape checks, no HTML) and the `<table` presence checks
 * (`hasHtmlTableMarkup`, `htmlTableBlockCount`) that decide which pages need the VM.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  hasHtmlTableMarkup,
  htmlTableBlockCount,
  repairMarkdownTables,
  scanPageTables,
  TABLE_SCAN_MAX_PAGE_CHARS,
  type HtmlTableScan,
  type TableRepairs,
} from "@docslurp/shared";

import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import type { CommandRunner } from "../tools/runner.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import { TABLE_ROUTING_MAX_PAGES } from "./table-routing-guest.js";

const MAX_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;

export interface TableScanStats {
  /** Pages that held `<table` and needed a scan. */
  pages: number;
  /** Of those, pages the VM did not read (fail closed: no HTML repair, `table:html-unscanned`). */
  unscanned: number;
  vmCalls: number;
  vmMs: number;
}
const emptyStats = (): TableScanStats => ({ pages: 0, unscanned: 0, vmCalls: 0, vmMs: 0 });

class InvalidScan extends Error {}
const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
/** ASCII-only lower case of a short slice (offsets stay aligned). */
const asciiLower = (value: string) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

/** The guest's scan of `page`, checked against the page; throws InvalidScan on any contract violation. */
export function validateTableScan(page: string, raw: unknown): HtmlTableScan {
  const scan = raw as Partial<HtmlTableScan> | null;
  if (!scan || typeof scan !== "object" || !Array.isArray(scan.tables) || !Array.isArray(scan.blocks)) throw new InvalidScan("shape");
  if (scan.blocks.length !== htmlTableBlockCount(page)) throw new InvalidScan("blocks");
  for (const block of scan.blocks as unknown[]) {
    const counts = block as { rows?: unknown; columns?: unknown } | null;
    if (!counts || !isInt(counts.rows, 0, page.length) || !isInt(counts.columns, 0, page.length)) throw new InvalidScan("block");
  }
  if (page.length > TABLE_SCAN_MAX_PAGE_CHARS && scan.tables.length > 0) throw new InvalidScan("oversized");
  let cursor = 0;
  for (const entry of scan.tables as unknown[]) {
    const table = entry as { start?: unknown; end?: unknown; rows?: unknown; simple?: unknown } | null;
    if (!table || !isInt(table.start, cursor, page.length) || !isInt(table.end, (table.start as number) + 1, page.length)) throw new InvalidScan("span");
    const start = table.start as number, end = table.end as number;
    const open = asciiLower(page.slice(start, start + 7));
    if (!open.startsWith("<table") || !(open[6] === ">" || /\s/.test(open[6] ?? ""))) throw new InvalidScan("open");
    if (end - start < 15 || asciiLower(page.slice(end - 8, end)) !== "</table>") throw new InvalidScan("close");
    if (typeof table.simple !== "boolean" || !Array.isArray(table.rows)) throw new InvalidScan("table");
    // Cell text is the source's own text, entity-decoded and whitespace-collapsed: never longer than the table's source.
    let chars = 0;
    for (const row of table.rows as unknown[]) {
      if (!Array.isArray(row)) throw new InvalidScan("row");
      for (const cell of row as unknown[]) {
        if (typeof cell !== "string") throw new InvalidScan("cell");
        chars += cell.length + 1;
        if (chars > end - start) throw new InvalidScan("cell text");
      }
    }
    cursor = end;
  }
  return scan as HtmlTableScan;
}

async function runGuest(pages: string[], runner: Pick<CommandRunner, "run">, signal?: AbortSignal): Promise<unknown[]> {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-table-routing-"));
  try {
    const input = path.join(dir, "pages.json"), output = path.join(dir, "scans.json");
    await writeFile(input, JSON.stringify(pages), { mode: 0o600 });
    await runner.run({ binary: "node", args: [path.join(resolveScriptsDir(), "table-routing.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, signal);
    if ((await stat(output)).size > MAX_RESULT_BYTES) throw new Error("table routing result exceeds limit");
    const parsed = JSON.parse(await readFile(output, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== pages.length) throw new Error("invalid table routing result");
    return parsed;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Scan the HTML tables of every page that holds `<table`, batched: `undefined` for a page without `<table` (nothing to
 * scan), `null` for a page the VM did not read (fail closed), else the validated scan. Never throws for a VM failure.
 */
export async function scanDocumentTables(
  pages: readonly string[],
  runner: Pick<CommandRunner, "run"> | null | undefined,
  options: { signal?: AbortSignal; documentId?: string; vmOnly?: boolean } = {},
): Promise<{ scans: Array<HtmlTableScan | null | undefined>; stats: TableScanStats }> {
  const stats = emptyStats();
  const scans: Array<HtmlTableScan | null | undefined> = pages.map(() => undefined);
  const work = pages.map((text, index) => ({ text, index })).filter(({ text }) => hasHtmlTableMarkup(text));
  if (!work.length) return { scans, stats };
  stats.pages = work.length;
  const vmOnly = options.vmOnly ?? vmOnlyParsing();
  if (!vmOnly) {
    for (const { text, index } of work) scans[index] = scanPageTables(text);
    return { scans, stats };
  }
  const unread = (items: typeof work, reason: string) => {
    if (!items.length) return;
    console.error(`[table-routing] document=${options.documentId ?? "unknown"} pages=${items.length} ${reason}; HTML tables unread (fail closed)`);
    for (const { index } of items) scans[index] = null;
    stats.unscanned += items.length;
  };
  const tooLarge = work.filter(({ text }) => Buffer.byteLength(JSON.stringify(text)) + 3 > MAX_BATCH_BYTES);
  unread(tooLarge, "page exceeds VM job limit");
  const pending = work.filter((item) => !tooLarge.includes(item));
  if (!runner) { unread(pending, "parser VM unavailable"); return { scans, stats }; }
  for (let start = 0; start < pending.length;) {
    const batch: typeof pending = [];
    let bytes = 2;
    while (start < pending.length && batch.length < TABLE_ROUTING_MAX_PAGES) {
      const size = Buffer.byteLength(JSON.stringify(pending[start]!.text)) + 1;
      if (batch.length && bytes + size > MAX_BATCH_BYTES) break;
      batch.push(pending[start]!); bytes += size; start += 1;
    }
    const started = Date.now();
    try {
      const results = await runGuest(batch.map((item) => item.text), runner, options.signal);
      const invalid: typeof batch = [];
      batch.forEach((item, i) => {
        try {
          scans[item.index] = validateTableScan(item.text, results[i]);
        } catch (error) {
          if (!(error instanceof InvalidScan)) throw error;
          invalid.push(item);
        }
      });
      unread(invalid, "invalid guest result");
    } catch (error) {
      if (options.signal?.aborted) throw error;
      unread(batch, `parser VM failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      stats.vmMs += Date.now() - started;
      stats.vmCalls += 1;
    }
  }
  return { scans, stats };
}

/**
 * repairMarkdownTables over a whole document (pages separated by form feeds) with its HTML tables scanned by
 * scanDocumentTables: byte-identical to the in-process repair when the VM reads every page; a page it did not read gets
 * its pipe-table repairs only.
 */
export async function repairDocumentTables(
  markdown: string,
  runner: Pick<CommandRunner, "run"> | null | undefined,
  options: { signal?: AbortSignal; documentId?: string; vmOnly?: boolean } = {},
): Promise<{ markdown: string; repairs: TableRepairs; stats: TableScanStats }> {
  const pages = markdown.split("\f");
  // repairMarkdownTables skips oversized pages before scanning; they are never sent.
  const { scans, stats } = await scanDocumentTables(pages.map((page) => (page.length > TABLE_SCAN_MAX_PAGE_CHARS ? "" : page)), runner, options);
  const repaired = repairMarkdownTables(markdown, (_page, index) => scans[index] ?? null);
  return { ...repaired, stats };
}
