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
const cellsContext = new AsyncLocalStorage<Map<string, HtmlTableCell[] | null>>();
export function preparedHtmlTableCells(source: string): HtmlTableCell[] | null | undefined { return cellsContext.getStore()?.get(source); }
function vmTableSources(sources: string[]): string[] {
  return [...new Set(sources.map(s => s.trim()).filter(s => /^<table(?=\s|>|$)/i.test(s) && s.length > 0 && s.length <= HTML_TABLE_MAX_SOURCE_CHARS))];
}
/** True when withPreparedHtmlTables would send these sources to a parser VM (no I/O). */
export function hasVmHtmlTableWork(sources: string[]): boolean {
  return vmOnlyParsing() && vmTableSources(sources).length > 0;
}
/** Prepare flat typed records in the VM, then keep synchronous chunking scoped to this document. */
export async function withPreparedHtmlTables<T>(sources: string[], runner: Pick<CommandRunner, "run">, fn: () => T, signal?: AbortSignal): Promise<T> {
  if (!vmOnlyParsing()) return fn();
  const unique = vmTableSources(sources);
  if (unique.length > 1024) throw new Error("HTML table count exceeds VM limit");
  if (unique.reduce((total, source) => total + source.length, 0) > 32 * 1024 * 1024) throw new Error("HTML table document source exceeds limit");
  const prepared = new Map<string, HtmlTableCell[] | null>();
  if (unique.length) {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-html-tables-"));
    try {
      let chars = 0, cellCount = 0;
      for (let start = 0; start < unique.length;) {
        const batch: string[] = []; let batchBytes = 2;
        while (start < unique.length && batch.length < 64) {
          const source = unique[start]!; const bytes = Buffer.byteLength(JSON.stringify(source)) + 1;
          if (bytes + 2 > HTML_TABLE_MAX_BATCH_BYTES) throw new Error("HTML table source exceeds VM batch limit");
          if (batchBytes + bytes > HTML_TABLE_MAX_BATCH_BYTES) break;
          batch.push(source); batchBytes += bytes; start++;
        }
        const input = path.join(dir, `tables-${start}.json`), output = path.join(dir, `cells-${start}.json`);
        await writeFile(input, JSON.stringify(batch), { mode: 0o600 });
        await runner.run({ binary: "node", args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "table-cells.mjs"), input, output], available: true, readOnlyInputs: true, timeoutMs: 60_000 }, signal);
        if ((await stat(output)).size > 64 * 1024 * 1024) throw new Error("HTML table result exceeds limit");
        const result = JSON.parse(await readFile(output, "utf8")) as Array<HtmlTableCell[] | null>;
        if (!Array.isArray(result) || result.length !== batch.length) throw new Error("invalid HTML table result");
        for (let i = 0; i < result.length; i++) {
          const cells = result[i];
          if (cells !== null) {
            if (!Array.isArray(cells) || cells.length > HTML_TABLE_MAX_CELLS) throw new Error("HTML table cell count exceeds limit");
            cellCount += cells.length; if (cellCount > 256_000) throw new Error("HTML table document cell count exceeds limit");
            for (const cell of cells) {
              if (!cell || typeof cell.label !== "string" || !/^(caption|row [1-9][0-9]{0,3} column [1-9][0-9]{0,3} rowspan [1-9][0-9]{0,3} colspan [1-9][0-9]{0,3})$/.test(cell.label) || typeof cell.value !== "string" || cell.value.length > HTML_TABLE_MAX_SOURCE_CHARS || !(cell.header === undefined || typeof cell.header === "boolean")) throw new Error("invalid HTML table cell");
              chars += cell.value.length; if (chars > 32 * 1024 * 1024) throw new Error("HTML table text exceeds limit");
            }
          }
          prepared.set(batch[i]!, cells ?? null);
        }
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  return cellsContext.run(prepared, fn);
}
