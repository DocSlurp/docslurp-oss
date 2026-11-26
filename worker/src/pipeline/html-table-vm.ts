import { HTML_TABLE_MAX_SOURCE_CHARS, HTML_TABLE_MAX_CELLS, HTML_TABLE_MAX_BATCH_BYTES } from "./html-table-limits.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import type { CommandRunner } from "../tools/runner.js";
import type { HtmlTableCell } from "./table-cells-guest.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
import { assertJsonShape } from "../lib/json-shape.js";
import { SandboxOutputLimitError } from "../sandbox/types.js";
/** Parsed cells per trimmed table source; null when the guest could not read the table (chunked as unparsed source). */
export type PreparedHtmlTableCells = Map<string, HtmlTableCell[] | null>;
const cellsContext = new AsyncLocalStorage<PreparedHtmlTableCells>();
export function preparedHtmlTableCells(source: string): HtmlTableCell[] | null | undefined { return cellsContext.getStore()?.get(source); }
export function hasPreparedHtmlTableContext(): boolean { return cellsContext.getStore() !== undefined; }
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
class HtmlTableBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "HtmlTableBudgetError"; }
}
/** Whole-document budgets, applied to every table's cells whether they come from the VM or a stored result. */
function documentBudget() {
  let chars = 0, cellCount = 0;
  return (cells: HtmlTableCell[] | null) => {
    if (cells === null) return;
    if (cellCount + cells.length > DOCUMENT_MAX_CELLS) throw new HtmlTableBudgetError("HTML table document cell count exceeds limit");
    const textChars = cells.reduce((total, cell) => total + cell.value.length, 0);
    if (chars + textChars > DOCUMENT_MAX_TEXT_CHARS) throw new HtmlTableBudgetError("HTML table text exceeds limit");
    cellCount += cells.length;
    chars += textChars;
  };
}
/** The whole-document budgets, for readers of stored cells that reject an over-budget artifact up front. */
export const HTML_TABLE_DOCUMENT_LIMITS = { tables: DOCUMENT_MAX_TABLES, cells: DOCUMENT_MAX_CELLS, textChars: DOCUMENT_MAX_TEXT_CHARS } as const;
// Retained decoded records must not block acquisition of the transient parse budget. A full retention budget
// degrades the excess tables to source text instead of letting readers deadlock while they hold earlier batches.
const TABLE_RETENTION_BYTES = 64 * 1024 * 1024;
let retainedTableBytes = 0;

export class TableCellRetention {
  private bytes = 0;

  retain(cells: HtmlTableCell[] | null): boolean {
    const bytes = cells?.reduce((total, cell) => total + 192 + 2 * (cell.label.length + cell.value.length), 0) ?? 0;
    if (retainedTableBytes + bytes > TABLE_RETENTION_BYTES) return false;
    this.bytes += bytes;
    retainedTableBytes += bytes;
    return true;
  }

  release(): void {
    retainedTableBytes -= this.bytes;
    this.bytes = 0;
  }
}

export interface PrepareHtmlTablesOptions {
  /** Retain newly parsed cells until their consumer finishes. Cached cells already have their own reservation. */
  retention?: TableCellRetention;
  /**
   * Cells already parsed in a parser VM for some of these sources (an earlier stage's stored result, validated by the
   * caller against the source it was looked up by). They are re-checked here like VM output; only the rest go to a VM.
   */
  cached?: ReadonlyMap<string, HtmlTableCell[] | null>;
}
/** What the output bounds need to know about one table source, from a single character scan (htmlTableSourceStats). */
export interface HtmlTableSourceStats {
  /** UTF-8 bytes (a lone surrogate counts 3, as its replacement). */
  bytes: number;
  /** Bytes JSON escaping can add to its text (see htmlTableValueBound). */
  growth: number;
  /** Cell-creating tags (`<td`, `<th`, `<caption` followed by whitespace, `/` or `>`), case-insensitive. */
  tags: number;
}

/** One pass over the source's character codes, no allocation. */
export function htmlTableSourceStats(source: string): HtmlTableSourceStats {
  let bytes = 0, growth = 0, tags = 0;
  const n = source.length;
  for (let i = 0; i < n; i++) {
    const c = source.charCodeAt(i);
    if (c < 0x80) {
      bytes += 1;
      if (c < 32 || c === 127) growth += 5;
      else if (c === 34 || c === 92) growth += 1;
      else if (c === 38) growth += 2;
      else if (c === 60) tags += cellTagAt(source, i + 1);
    } else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      growth += 3;
      const next = i + 1 < n ? source.charCodeAt(i + 1) : 0;
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { bytes += 4; growth += 3; i++; }
      else bytes += 3;
    } else bytes += 3;
  }
  return { bytes, growth, tags };
}

/** 1 when `<` at position at-1 opens a td, th or caption tag (any case), else 0. */
function cellTagAt(source: string, at: number): number {
  const lower = (k: number) => source.charCodeAt(at + k) | 0x20;
  let length = 0;
  if (lower(0) === 116 && (lower(1) === 100 || lower(1) === 104)) length = 2; // td, th
  else if (lower(0) === 99 && lower(1) === 97 && lower(2) === 112 && lower(3) === 116 && lower(4) === 105 && lower(5) === 111 && lower(6) === 110) length = 7; // caption
  if (!length) return 0;
  const after = source.charCodeAt(at + length);
  return after === 9 || after === 10 || after === 12 || after === 13 || after === 32 || after === 47 || after === 62 ? 1 : 0;
}

/** Per-operation memo of htmlTableSourceStats: each source is scanned once however many bounds read it. */
export type HtmlTableStatsMemo = Map<string, HtmlTableSourceStats>;
export function statsOf(source: string, memo?: HtmlTableStatsMemo): HtmlTableSourceStats {
  let stats = memo?.get(source);
  if (!stats) { stats = htmlTableSourceStats(source); memo?.set(source, stats); }
  return stats;
}

export function htmlTableCellTagCount(source: string, memo?: HtmlTableStatsMemo): number {
  return statsOf(source, memo).tags;
}
/**
 * The most bytes a table's text can take once JSON-encoded: never more than the source, except where escaping grows it.
 * A control character becomes 6 bytes (+5), a quote or backslash 2 (+1), a lone surrogate 6 (+3 over its UTF-8
 * replacement; counted for every surrogate code unit), and a character reference, which starts with `&`, at most 6
 * (`&#1;`, +2). Markup and `<br>` only shrink it.
 */
export function htmlTableValueBound(source: string, memo?: HtmlTableStatsMemo): number {
  const stats = statsOf(source, memo);
  return stats.bytes + stats.growth;
}
/**
 * The most bytes the guest can legitimately return for these tables, from their structure: their text (above) plus at
 * most 96 bytes of label, header and punctuation per record (one record per cell tag). The transfer cap of a batch.
 */
export function htmlTableCellsOutputBound(sources: readonly string[], memo?: HtmlTableStatsMemo): number {
  let bound = 64;
  for (const source of sources) { const stats = statsOf(source, memo); bound += stats.bytes + stats.growth + 96 * stats.tags + 8; }
  return bound;
}
/** Several tables share a batch only while their output bound stays under this. */
export const HTML_TABLE_BATCH_OUTPUT_TARGET = 16 * 1024 * 1024;
/**
 * DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES (default 16 MiB): the most guest output one table may produce. A table whose
 * bound is above it runs alone under this cap; if its output really is larger, it is treated as unparseable (null
 * cells, chunked as its source text), exactly like a table the guest cannot read. The document does not fail.
 */
export function htmlTableMaxOutputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES);
  return Number.isSafeInteger(value) && value >= 64 * 1024 ? value : 16 * 1024 * 1024;
}
/**
 * Worker-budget bytes held per byte of a result being parsed: the transferred bytes (1), the decoded string (at most
 * 2), and headroom for JSON.parse's heap on the shapes admitted by the pre-scan, including short records.
 */
export const TABLE_PARSE_HEAP_FACTOR = 32;
/**
 * The per-table output cap in effect: DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES, lowered so one table's reservation
 * (cap × TABLE_PARSE_HEAP_FACTOR) fits the worker budget. Part of the stored cells' identity (tableCellsGeneration).
 */
export function effectiveHtmlTableOutputCap(): number {
  return Math.min(htmlTableMaxOutputBytes(), Math.floor(tableParseMemoryBudget().total / TABLE_PARSE_HEAP_FACTOR));
}
/** The output bound a batch of several tables may reach, likewise fitted to the worker budget. */
export function effectiveHtmlTableBatchTarget(): number {
  return Math.min(HTML_TABLE_BATCH_OUTPUT_TARGET, Math.floor(tableParseMemoryBudget().total / TABLE_PARSE_HEAP_FACTOR));
}

/**
 * Worker-wide budget for table-parse results in flight (DOCSLURP_HTML_TABLE_PARSE_MEMORY_BYTES, default 256 MiB): a batch reserves its output cap × that factor before
 * its output is staged and releases it once decoded. A document parses one batch at a time, so it holds at most one
 * reservation; concurrent documents queue FIFO. Caps are fitted to the budget (effectiveHtmlTableOutputCap), so no
 * reservation is larger than the whole budget (one that is, is refused).
 */
export class TableParseMemoryBudget {
  private used = 0;
  private peakUsed = 0;
  private readonly waiting: Array<{ bytes: number; grant: () => void }> = [];
  constructor(readonly total: number) {}
  get inUse(): number { return this.used; }
  get peak(): number { return this.peakUsed; }
  async reserve(bytes: number, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    // Never clamped: caps are fitted to the configured budget (effectiveHtmlTableOutputCap), so a reservation over the
    // whole budget is a bug, refused rather than silently under-reserved.
    const amount = Math.max(0, bytes);
    if (amount > this.total) throw new Error(`table-parse reservation of ${amount} bytes exceeds the worker budget of ${this.total}`);
    if (this.waiting.length > 0 || this.used + amount > this.total) {
      await new Promise<void>((resolve, reject) => {
        const entry = { bytes: amount, grant: () => { signal?.removeEventListener("abort", onAbort); resolve(); } };
        const onAbort = () => { const index = this.waiting.indexOf(entry); if (index >= 0) this.waiting.splice(index, 1); this.pump(); reject(signal!.reason); };
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiting.push(entry);
      });
    } else this.take(amount);
    let released = false;
    return () => { if (released) return; released = true; this.used -= amount; this.pump(); };
  }
  private take(amount: number): void { this.used += amount; this.peakUsed = Math.max(this.peakUsed, this.used); }
  private pump(): void {
    while (this.waiting.length > 0 && this.used + this.waiting[0]!.bytes <= this.total) {
      const next = this.waiting.shift()!;
      this.take(next.bytes);
      next.grant();
    }
  }
}
let workerBudget: TableParseMemoryBudget | undefined;
export function tableParseMemoryBudget(env: NodeJS.ProcessEnv = process.env): TableParseMemoryBudget {
  if (!workerBudget) {
    const value = Number(env.DOCSLURP_HTML_TABLE_PARSE_MEMORY_BYTES);
    workerBudget = new TableParseMemoryBudget(Number.isSafeInteger(value) && value >= 1024 * 1024 ? value : 256 * 1024 * 1024);
  }
  return workerBudget;
}
/** For tests: replace the worker-wide budget. */
export function setTableParseMemoryBudgetForTests(budget: TableParseMemoryBudget | undefined): void { workerBudget = budget; }

/** A transfer refused for its size (SandboxOutputLimitError) or an output file over its cap. */
function isOutputLimit(error: unknown): boolean {
  return error instanceof SandboxOutputLimitError || (error instanceof Error && error.message === "HTML table result exceeds limit");
}

/** Parse the document's HTML tables into flat typed records in the parser VM (no host parsing). Returns them by source. */
export async function prepareHtmlTableCells(sources: string[], runner: Pick<CommandRunner, "run">, signal?: AbortSignal, options: PrepareHtmlTablesOptions = {}): Promise<{ prepared: PreparedHtmlTableCells; vmTables: number; cachedTables: number; vmCommands: number; overCap: number }> {
  if (!options.cached?.size) return await prepareOnce(sources, runner, signal, { retention: options.retention });
  try {
    return await prepareOnce(sources, runner, signal, options);
  } catch (error) {
    // When stored cells push the document over its budget, parse the selected tables again in source order.
    if (!(error instanceof HtmlTableBudgetError) || signal?.aborted) throw error;
    options.retention?.release();
    console.warn(`[table-cells] stored cells exceed the document budget (${error.message}); parsing every table in a VM`);
    return await prepareOnce(sources, runner, signal, { retention: options.retention });
  }
}

interface TableBatch { sources: string[]; cap: number; single: boolean }

/** Group tables into batches: by input bytes, at most 64, and by output bound; a table over the per-table cap alone. */
function planBatches(misses: string[], tableCap: number, batchTarget: number, memo: HtmlTableStatsMemo): TableBatch[] {
  const batches: TableBatch[] = [];
  let current: TableBatch | null = null;
  let inputBytes = 2;
  for (const source of misses) {
    const bytes = Buffer.byteLength(JSON.stringify(source)) + 1;
    if (bytes + 2 > HTML_TABLE_MAX_BATCH_BYTES) throw new Error("HTML table source exceeds VM batch limit");
    const bound = htmlTableCellsOutputBound([source], memo) - 64;
    if (bound + 64 > tableCap) {
      batches.push({ sources: [source], cap: tableCap, single: true });
      continue;
    }
    if (!current || current.sources.length >= 64 || inputBytes + bytes > HTML_TABLE_MAX_BATCH_BYTES || current.cap + bound > batchTarget) {
      current = { sources: [], cap: 64, single: false };
      batches.push(current);
      inputBytes = 2;
    }
    current.sources.push(source);
    current.cap += bound;
    inputBytes += bytes;
  }
  return batches;
}

async function prepareOnce(sources: string[], runner: Pick<CommandRunner, "run">, signal: AbortSignal | undefined, options: PrepareHtmlTablesOptions): Promise<{ prepared: PreparedHtmlTableCells; vmTables: number; cachedTables: number; vmCommands: number; overCap: number }> {
  const unique: string[] = [];
  const seen = new Set<string>();
  let sourceChars = 0;
  for (const raw of sources) {
    if (unique.length === DOCUMENT_MAX_TABLES) break;
    const source = raw.trim();
    if (!/^<table(?=\s|>|$)/i.test(source) || source.length > HTML_TABLE_MAX_SOURCE_CHARS || seen.has(source)) continue;
    if (sourceChars + source.length > DOCUMENT_MAX_SOURCE_CHARS) continue;
    sourceChars += source.length;
    seen.add(source);
    unique.push(source);
  }
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
  let vmCommands = 0, overCap = 0;
  let documentBudgetExceeded = false;
  if (misses.length) {
    // Every batch's transfer cap times TABLE_PARSE_HEAP_FACTOR fits the worker budget, so each reservation is the
    // whole cost of the batch, never clamped: a table over the effective cap is null (below), several share a batch
    // only up to the fitted target.
    const tableCap = effectiveHtmlTableOutputCap();
    const budget = tableParseMemoryBudget();
    const memo: HtmlTableStatsMemo = new Map();
    const batches = planBatches(misses, tableCap, effectiveHtmlTableBatchTarget(), memo);
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-"));
    try {
      // One batch at a time in source order, with at most one transient worker-budget reservation per document.
      for (let index = 0; index < batches.length; index++) {
        signal?.throwIfAborted();
        if (documentBudgetExceeded) break;
        const batch = batches[index]!;
        const release = await budget.reserve(batch.cap * TABLE_PARSE_HEAP_FACTOR, signal);
        try {
          // Each batch stages into its own directories: its input, and an output directory holding only its result
          // file (the command's only writable path), so no batch sees or downloads another's files.
          const input = path.join(dir, `in-${index}`, "tables.json"), outputDir = path.join(dir, `docslurp-out-${index}`), output = path.join(outputDir, "cells.json");
          await mkdir(path.dirname(input), { mode: 0o700 });
          await mkdir(outputDir, { mode: 0o700 });
          await writeFile(input, JSON.stringify(batch.sources), { mode: 0o600 });
          vmCommands++;
          let text: string | null = null;
          try {
            // The output may not exceed what these tables can produce (or the per-table cap): enforced while it is
            // transferred out of the VM (SandboxLimits.maxOutputBytes) and again here, before it is read.
            const args = [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "table-cells.mjs"), input, output];
            if (batch.single) args.push(String(batch.cap));
            const command = await runner.run({ binary: "node", args, available: true, readOnlyInputs: true, timeoutMs: 60_000, maxOutputBytes: batch.cap }, signal);
            if (batch.single && command.stderr.trim() === "[table-cells] output over single-table limit") overCap++;
            if ((await stat(output)).size > batch.cap) throw new Error("HTML table result exceeds limit");
            text = await readFile(output, "utf8");
          } catch (error) {
            // One table larger than the per-table cap is unparseable (null cells), never a document failure.
            if (!batch.single || !isOutputLimit(error) || signal?.aborted) throw error;
            console.warn(`[table-cells] table output over its ${batch.cap}-byte cap; chunked as source text`);
            overCap++;
            prepared.set(batch.sources[0]!, null);
            continue;
          }
          // Before JSON.parse builds anything: the guest's result is [ table [ record {…} ] ], one record per cell tag,
          // each with at most three keys and three values, and no string longer than its table's text can encode to.
          const tags = batch.sources.reduce((total, source) => total + htmlTableCellTagCount(source, memo), 0);
          assertJsonShape(text, {
            maxDepth: 3,
            maxContainers: 1 + batch.sources.length + tags,
            maxScalars: batch.sources.length + 6 * tags,
            maxStringLength: Math.max(...batch.sources.map((source) => htmlTableValueBound(source, memo))) + 64,
          });
          const result = JSON.parse(text) as unknown;
          text = null;
          if (!Array.isArray(result) || result.length !== batch.sources.length) throw new Error("invalid HTML table result");
          for (const cells of result as unknown[]) assertHtmlTableCells(cells);
          // Keep only the cells that fit. Chunking uses source text for tables omitted by the budget.
          for (let i = 0; i < batch.sources.length; i++) {
            const cells = (result[i] ?? null) as HtmlTableCell[] | null;
            try {
              charge(cells);
            } catch (error) {
              if (!(error instanceof HtmlTableBudgetError) || options.cached?.size) throw error;
              documentBudgetExceeded = true;
              console.warn(`[table-cells] ${error.message}; remaining tables chunked as source text`);
              break;
            }
            if (options.retention && !options.retention.retain(cells)) {
              documentBudgetExceeded = true;
              console.warn("[table-cells] worker retention budget exhausted; remaining tables chunked as source text");
              break;
            }
            prepared.set(batch.sources[i]!, cells);
          }
        } finally {
          release();
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return { prepared, vmTables: misses.length, cachedTables: unique.length - misses.length, vmCommands, overCap };
}
/** Prepare flat typed records in the VM, then keep synchronous chunking scoped to this document. */
export async function withPreparedHtmlTables<T>(sources: string[], runner: Pick<CommandRunner, "run">, fn: () => T, signal?: AbortSignal, options: PrepareHtmlTablesOptions = {}): Promise<T> {
  if (!vmOnlyParsing()) return fn();
  const retention = new TableCellRetention();
  try {
    const { prepared } = await prepareHtmlTableCells(sources, runner, signal, { ...options, retention });
    return await cellsContext.run(prepared, fn);
  } finally {
    retention.release();
  }
}
