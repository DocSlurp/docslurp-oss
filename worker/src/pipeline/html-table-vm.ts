import { HTML_TABLE_MAX_SOURCE_CHARS, HTML_TABLE_MAX_CELLS, HTML_TABLE_MAX_BATCH_BYTES } from "./html-table-limits.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import type { CommandRunner } from "../tools/runner.js";
import type { HtmlTableCell } from "./table-cells-guest.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
/** Parsed cells per trimmed table source; null when the guest could not read the table (chunked as unparsed source). */
export type PreparedHtmlTableCells = Map<string, HtmlTableCell[] | null>;
const cellsContext = new AsyncLocalStorage<PreparedHtmlTableCells>();
export function preparedHtmlTableCells(source: string): HtmlTableCell[] | null | undefined { return cellsContext.getStore()?.get(source); }
const DOCUMENT_MAX_TABLES = 1024;
const DOCUMENT_MAX_SOURCE_CHARS = 32 * 1024 * 1024;
const DOCUMENT_MAX_CELLS = 256_000;
const DOCUMENT_MAX_TEXT_CHARS = 32 * 1024 * 1024;
const CELL_LABEL = /^(caption|row [1-9][0-9]{0,3} column [1-9][0-9]{0,3} rowspan [1-9][0-9]{0,3} colspan [1-9][0-9]{0,3})$/;
/** The distinct table sources a document sends to the parser VM (trimmed, bounded, starting with `<table`). */
export function vmTableSources(sources: string[]): string[] {
  return [...new Set(sources.map(s => s.trim()).filter(s => /^<table(?=\s|>|$)/i.test(s) && s.length > 0 && s.length <= HTML_TABLE_MAX_SOURCE_CHARS))];
}
/** True when withPreparedHtmlTables would send these sources to a parser VM (no I/O). */
export function hasVmHtmlTableWork(sources: string[]): boolean {
  return vmOnlyParsing() && vmTableSources(sources).length > 0;
}
/**
 * One table's guest result, checked exactly as it is checked when it comes back from the VM: null, or a list of flat
 * records `{ label, value, header? }` with nothing else in them (no extra or nested fields), closed-form labels and
 * bounded values. Throws on anything else. Used for VM output and for cells read back from storage.
 */
export function assertHtmlTableCells(cells: unknown): asserts cells is HtmlTableCell[] | null {
  if (cells === null) return;
  if (!Array.isArray(cells) || cells.length > HTML_TABLE_MAX_CELLS) throw new Error("HTML table cell count exceeds limit");
  for (const cell of cells as unknown[]) {
    if (!cell || typeof cell !== "object" || Array.isArray(cell)) throw new Error("invalid HTML table cell");
    const record = cell as Record<string, unknown>;
    for (const key in record) if (key !== "label" && key !== "value" && key !== "header") throw new Error("invalid HTML table cell");
    if (typeof record.label !== "string" || !CELL_LABEL.test(record.label) || typeof record.value !== "string" || record.value.length > HTML_TABLE_MAX_SOURCE_CHARS || !(record.header === undefined || typeof record.header === "boolean")) throw new Error("invalid HTML table cell");
  }
}
/** A whole-document limit on tables' cells (as opposed to one malformed table). */
export class HtmlTableBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "HtmlTableBudgetError"; }
}
/** Whole-document budgets, applied to every table's cells whether they come from the VM or a stored result. */
function documentBudget() {
  let chars = 0, cellCount = 0;
  return (cells: HtmlTableCell[] | null) => {
    if (cells === null) return;
    cellCount += cells.length; if (cellCount > DOCUMENT_MAX_CELLS) throw new HtmlTableBudgetError("HTML table document cell count exceeds limit");
    for (const cell of cells) { chars += cell.value.length; if (chars > DOCUMENT_MAX_TEXT_CHARS) throw new HtmlTableBudgetError("HTML table text exceeds limit"); }
  };
}
/** The whole-document budgets, for readers of stored cells that reject an over-budget artifact up front. */
export const HTML_TABLE_DOCUMENT_LIMITS = { tables: DOCUMENT_MAX_TABLES, cells: DOCUMENT_MAX_CELLS, textChars: DOCUMENT_MAX_TEXT_CHARS } as const;
export interface PrepareHtmlTablesOptions {
  /**
   * Cells already parsed in a parser VM for some of these sources (an earlier stage's stored result, validated by the
   * caller against the source it was looked up by). They are re-checked here like VM output; only the rest go to a VM.
   */
  cached?: ReadonlyMap<string, HtmlTableCell[] | null>;
}
/** Parse the document's HTML tables into flat typed records in the parser VM (no host parsing). Returns them by source. */
export async function prepareHtmlTableCells(sources: string[], runner: Pick<CommandRunner, "run">, signal?: AbortSignal, options: PrepareHtmlTablesOptions = {}): Promise<{ prepared: PreparedHtmlTableCells; vmTables: number; cachedTables: number; vmCommands: number }> {
  if (!options.cached?.size) return await prepareOnce(sources, runner, signal, {});
  try {
    return await prepareOnce(sources, runner, signal, options);
  } catch (error) {
    // Stored cells must never cost the document its tables: when they push it over a whole-document budget, drop every
    // stored cell and parse all tables in the VM once, exactly as without them (which fails the same way if it must).
    if (!(error instanceof HtmlTableBudgetError) || signal?.aborted) throw error;
    console.warn(`[table-cells] stored cells exceed the document budget (${error.message}); parsing every table in a VM`);
    return await prepareOnce(sources, runner, signal, {});
  }
}
async function prepareOnce(sources: string[], runner: Pick<CommandRunner, "run">, signal: AbortSignal | undefined, options: PrepareHtmlTablesOptions): Promise<{ prepared: PreparedHtmlTableCells; vmTables: number; cachedTables: number; vmCommands: number }> {
  const unique = vmTableSources(sources);
  if (unique.length > DOCUMENT_MAX_TABLES) throw new Error("HTML table count exceeds VM limit");
  if (unique.reduce((total, source) => total + source.length, 0) > DOCUMENT_MAX_SOURCE_CHARS) throw new Error("HTML table document source exceeds limit");
  const prepared: PreparedHtmlTableCells = new Map();
  const charge = documentBudget();
  const misses: string[] = [];
  for (const source of unique) {
    if (!options.cached?.has(source)) { misses.push(source); continue; }
    const cells = options.cached.get(source) ?? null;
    assertHtmlTableCells(cells);
    charge(cells);
    prepared.set(source, cells);
  }
  let vmCommands = 0;
  if (misses.length) {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-"));
    try {
      for (let start = 0; start < misses.length;) {
        const batch: string[] = []; let batchBytes = 2;
        while (start < misses.length && batch.length < 64) {
          const source = misses[start]!; const bytes = Buffer.byteLength(JSON.stringify(source)) + 1;
          if (bytes + 2 > HTML_TABLE_MAX_BATCH_BYTES) throw new Error("HTML table source exceeds VM batch limit");
          if (batchBytes + bytes > HTML_TABLE_MAX_BATCH_BYTES) break;
          batch.push(source); batchBytes += bytes; start++;
        }
        const input = path.join(dir, `tables-${start}.json`), output = path.join(dir, `cells-${start}.json`);
        await writeFile(input, JSON.stringify(batch), { mode: 0o600 });
        vmCommands++;
        await runner.run({ binary: "node", args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "table-cells.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, signal);
        if ((await stat(output)).size > 64 * 1024 * 1024) throw new Error("HTML table result exceeds limit");
        const result = JSON.parse(await readFile(output, "utf8")) as unknown;
        if (!Array.isArray(result) || result.length !== batch.length) throw new Error("invalid HTML table result");
        for (let i = 0; i < result.length; i++) {
          const cells: unknown = result[i];
          assertHtmlTableCells(cells);
          charge(cells);
          prepared.set(batch[i]!, cells);
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return { prepared, vmTables: misses.length, cachedTables: unique.length - misses.length, vmCommands };
}
/** Prepare flat typed records in the VM, then keep synchronous chunking scoped to this document. */
export async function withPreparedHtmlTables<T>(sources: string[], runner: Pick<CommandRunner, "run">, fn: () => T, signal?: AbortSignal, options: PrepareHtmlTablesOptions = {}): Promise<T> {
  if (!vmOnlyParsing()) return fn();
  const { prepared } = await prepareHtmlTableCells(sources, runner, signal, options);
  return cellsContext.run(prepared, fn);
}
