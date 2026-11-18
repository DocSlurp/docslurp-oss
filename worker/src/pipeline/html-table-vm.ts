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
import { assertJsonShape } from "../lib/json-shape.js";
import { SandboxOutputLimitError } from "../sandbox/types.js";
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
/** Cell-creating tags (`<td`, `<th`, `<caption`): each guest record needs one, so their count bounds the record count. */
const CELL_TAG = /<(?:td|th|caption)(?=[\t\n\f\r />])/gi;
export function htmlTableCellTagCount(source: string): number {
  return source.match(CELL_TAG)?.length ?? 0;
}
/**
 * The most bytes a table's text can take once JSON-encoded: never more than the source, except where escaping grows it.
 * A control character becomes 6 bytes (+5), a quote or backslash 2 (+1), a lone surrogate 6 (+3 over its UTF-8
 * replacement), and a character reference, which starts with `&`, at most 6 (`&#1;`, +2). Markup and `<br>` only shrink.
 */
export function htmlTableValueBound(source: string): number {
  const growth = 5 * (source.match(/[\u0000-\u001f\u007f]/g)?.length ?? 0) + (source.match(/["\\]/g)?.length ?? 0)
    + 2 * (source.match(/&/g)?.length ?? 0) + 3 * (source.match(/[\uD800-\uDFFF]/g)?.length ?? 0);
  return Buffer.byteLength(source, "utf8") + growth;
}
/**
 * The most bytes the guest can legitimately return for these tables, from their structure: their text (above) plus at
 * most 96 bytes of label, header and punctuation per record (one record per cell tag). The transfer cap of a batch.
 */
export function htmlTableCellsOutputBound(sources: readonly string[]): number {
  let bound = 64;
  for (const source of sources) bound += htmlTableValueBound(source) + 96 * htmlTableCellTagCount(source) + 8;
  return bound;
}
/** Several tables share a batch only while their output bound stays under this. */
export const HTML_TABLE_BATCH_OUTPUT_TARGET = 16 * 1024 * 1024;
/**
 * DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES (default 8 MiB): the most guest output one table may produce. A table whose
 * bound is above it runs alone under this cap; if its output really is larger, it is treated as unparseable (null
 * cells, chunked as its source text), exactly like a table the guest cannot read. The document does not fail.
 */
export function htmlTableMaxOutputBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.DOCSLURP_HTML_TABLE_MAX_OUTPUT_BYTES);
  return Number.isSafeInteger(value) && value >= 64 * 1024 ? value : 8 * 1024 * 1024;
}
/** Batches of one document parsed at once (each within the worker-wide budget). */
const DOCUMENT_BATCH_CONCURRENCY = 2;

/**
 * Worker-wide budget for table-parse results in flight (DOCSLURP_HTML_TABLE_PARSE_MEMORY_BYTES, default 128 MiB):
 * a batch reserves its output cap before its output is staged and releases it once decoded, so concurrent documents
 * never hold more than this between them. FIFO; a reservation larger than the whole budget waits for all of it.
 */
export class TableParseMemoryBudget {
  private used = 0;
  private peakUsed = 0;
  private readonly waiting: Array<{ bytes: number; grant: () => void }> = [];
  constructor(readonly total: number) {}
  get inUse(): number { return this.used; }
  get peak(): number { return this.peakUsed; }
  async reserve(bytes: number, signal?: AbortSignal): Promise<() => void> {
    const amount = Math.min(Math.max(0, bytes), this.total);
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
    workerBudget = new TableParseMemoryBudget(Number.isSafeInteger(value) && value >= 1024 * 1024 ? value : 128 * 1024 * 1024);
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

interface TableBatch { sources: string[]; cap: number; single: boolean }

/** Group tables into batches: by input bytes, at most 64, and by output bound; a table over the per-table cap alone. */
function planBatches(misses: string[], tableCap: number): TableBatch[] {
  const batches: TableBatch[] = [];
  let current: TableBatch | null = null;
  let inputBytes = 2;
  for (const source of misses) {
    const bytes = Buffer.byteLength(JSON.stringify(source)) + 1;
    if (bytes + 2 > HTML_TABLE_MAX_BATCH_BYTES) throw new Error("HTML table source exceeds VM batch limit");
    const bound = htmlTableCellsOutputBound([source]) - 64;
    if (bound + 64 > tableCap) {
      batches.push({ sources: [source], cap: tableCap, single: true });
      continue;
    }
    if (!current || current.sources.length >= 64 || inputBytes + bytes > HTML_TABLE_MAX_BATCH_BYTES || current.cap + bound > Math.min(HTML_TABLE_BATCH_OUTPUT_TARGET, tableParseMemoryBudget().total)) {
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
  let vmCommands = 0, overCap = 0;
  if (misses.length) {
    const tableCap = htmlTableMaxOutputBytes();
    const budget = tableParseMemoryBudget();
    const batches = planBatches(misses, tableCap);
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-"));
    // A failed batch stops its sibling: one document's batches share this controller.
    const stop = new AbortController();
    const batchSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    try {
      let next = 0;
      const results: Array<{ batch: TableBatch; result: unknown[] | null }> = [];
      const worker = async () => {
        while (next < batches.length) {
          const index = next++;
          const batch = batches[index]!;
          const release = await budget.reserve(batch.cap, batchSignal);
          try {
            const input = path.join(dir, `tables-${index}.json`), output = path.join(dir, `cells-${index}.json`);
            await writeFile(input, JSON.stringify(batch.sources), { mode: 0o600 });
            vmCommands++;
            let text: string | null = null;
            try {
              // The output may not exceed what these tables can produce (or the per-table cap): enforced while it is
              // transferred out of the VM (SandboxLimits.maxOutputBytes) and again here, before it is read.
              await runner.run({ binary: "node", args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "table-cells.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000, maxOutputBytes: batch.cap }, batchSignal);
              if ((await stat(output)).size > batch.cap) throw new Error("HTML table result exceeds limit");
              text = await readFile(output, "utf8");
            } catch (error) {
              // One table larger than the per-table cap is unparseable (null cells), never a document failure.
              if (!batch.single || !isOutputLimit(error) || batchSignal.aborted) throw error;
              console.warn(`[table-cells] table output over its ${batch.cap}-byte cap; chunked as source text`);
              overCap++;
              results.push({ batch, result: [null] });
              continue;
            }
            // Before JSON.parse builds anything: the guest's result is [ table [ record {…} ] ], one record per cell tag,
            // each with at most three keys and three values, and no string longer than its table's text can encode to.
            const tags = batch.sources.reduce((total, source) => total + htmlTableCellTagCount(source), 0);
            assertJsonShape(text, {
              maxDepth: 3,
              maxContainers: 1 + batch.sources.length + tags,
              maxScalars: batch.sources.length + 6 * tags,
              maxStringLength: Math.max(...batch.sources.map(htmlTableValueBound)) + 64,
            });
            const result = JSON.parse(text) as unknown;
            text = null;
            if (!Array.isArray(result) || result.length !== batch.sources.length) throw new Error("invalid HTML table result");
            for (const cells of result as unknown[]) assertHtmlTableCells(cells);
            results.push({ batch, result: result as unknown[] });
          } finally {
            release();
          }
        }
      };
      const workers = Array.from({ length: Math.min(DOCUMENT_BATCH_CONCURRENCY, batches.length) }, () => worker().catch((error: unknown) => { stop.abort(error); throw error; }));
      const settled = await Promise.allSettled(workers);
      const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (failed) throw failed.reason;
      // Charged in batch order, so the document budget fails the same way however the batches interleaved.
      results.sort((a, b) => batches.indexOf(a.batch) - batches.indexOf(b.batch));
      for (const { batch, result } of results) {
        for (let i = 0; i < batch.sources.length; i++) {
          const cells = (result![i] ?? null) as HtmlTableCell[] | null;
          charge(cells);
          prepared.set(batch.sources[i]!, cells);
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return { prepared, vmTables: misses.length, cachedTables: unique.length - misses.length, vmCommands, overCap };
}
/** Prepare flat typed records in the VM, then keep synchronous chunking scoped to this document. */
export async function withPreparedHtmlTables<T>(sources: string[], runner: Pick<CommandRunner, "run">, fn: () => T, signal?: AbortSignal, options: PrepareHtmlTablesOptions = {}): Promise<T> {
  if (!vmOnlyParsing()) return fn();
  const { prepared } = await prepareHtmlTableCells(sources, runner, signal, options);
  return cellsContext.run(prepared, fn);
}
