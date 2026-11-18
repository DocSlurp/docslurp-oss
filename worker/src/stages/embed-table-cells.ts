/**
 * Store the parser VM's cells for the HTML tables embed will chunk, from the last stage that writes the document's
 * tables before pii-detect (extract-markdown, or vision-extract when it re-reads pages), on a parser VM lane already
 * warm for the document, so embed reuses them instead of starting a VM of its own.
 *
 * Best effort: any failure, or running past its own deadline, is logged and leaves embed on its VM path; it never
 * fails the calling stage. The stage's own abort still propagates. Table HTML is only ever parsed in the parser VM
 * (prepareHtmlTableCells).
 */
import type { CanonicalDocument } from "@docslurp/shared";
import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import { hasVmHtmlTableWork, prepareHtmlTableCells } from "../pipeline/html-table-vm.js";
import {
  embedHtmlTableSources,
  readTableCellsArtifact,
  reportUnknownGuest,
  tableCellsArtifactKey,
  tableCellsByteCap,
  tableCellsCacheActive,
  tableCellsGuestVersion,
  writeTableCellsArtifact,
  type TableCellsStorage,
} from "../pipeline/html-table-cells-cache.js";
import { embedTextFromMarkdown } from "./embedding-runtime.js";

/** Total time the best-effort writer may take (one warm VM command plus one read and one write). */
export const STORE_TABLE_CELLS_DEADLINE_MS = 90_000;

export interface StoreEmbedTableCellsStats {
  status: "off" | "pii-policy" | "vision-pending" | "no-tables" | "unavailable" | "current" | "written" | "too-large" | "failed";
  tables?: number;
  vmTables?: number;
  reusedTables?: number;
  vmCommands?: number;
  bytes?: number;
  ms?: number;
  /** Internal diagnostics only: at most 200 characters, one line (the public API withholds `error` keys). */
  error?: string;
}

const diagnostic = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

/** Cheap in-memory check before any work: no `<table` anywhere means embed has no VM table work. */
export function mayHaveHtmlTables(text: string | null | undefined, blocks: ReadonlyArray<{ text: string }> = []): boolean {
  return (!!text && /<table/i.test(text)) || blocks.some(block => /<table/i.test(block.text));
}

export async function storeEmbedTableCells(args: {
  run: { id: string; storagePrefix?: string | null; pipeline: { piiPolicy?: { enabled?: boolean } | null } };
  document: Document;
  runner: Pick<CommandRunner, "run">;
  storage: TableCellsStorage;
  stage: string;
  /** The Markdown just written to the document's markdown slot, and its canonical document (in memory: no re-read). */
  markdown: string;
  canonicalDocument: CanonicalDocument | undefined;
  signal?: AbortSignal;
  deadlineMs?: number;
}): Promise<StoreEmbedTableCellsStats> {
  const started = Date.now();
  if (!tableCellsCacheActive(args.run.pipeline)) {
    return { status: args.run.pipeline && tableCellsCacheActive({}) ? "pii-policy" : "off" };
  }
  // The key is the run's; a document of another run never writes under it (fails closed: no stored cells).
  if (args.document.runId !== args.run.id) return { status: "unavailable", error: "document belongs to another run" };
  if (!mayHaveHtmlTables(args.markdown, args.canonicalDocument?.blocks)) return { status: "no-tables" };
  // What embed will chunk: computed from the text this stage holds, exactly as embed derives it from the artifact.
  const sources = embedHtmlTableSources({ text: embedTextFromMarkdown(args.markdown, args.canonicalDocument), canonicalDocument: args.canonicalDocument });
  if (!hasVmHtmlTableWork(sources)) return { status: "no-tables" };
  const guest = tableCellsGuestVersion();
  if (guest.version === null) { reportUnknownGuest(guest.reason); return { status: "unavailable", error: guest.reason }; }
  const deadline = AbortSignal.timeout(args.deadlineMs ?? STORE_TABLE_CELLS_DEADLINE_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, deadline]) : deadline;
  try {
    const key = tableCellsArtifactKey(args.run, args.document);
    const scope = { storage: args.storage, key, runId: args.run.id, documentId: args.document.id, guestVersion: guest.version };
    // A retried stage, or vision-extract after extract-markdown: keep the tables already parsed, parse only new ones.
    const existing = await readTableCellsArtifact({ ...scope, sources, signal });
    const { prepared, vmTables, cachedTables, vmCommands } = await prepareHtmlTableCells(sources, args.runner, signal, { cached: existing.cached });
    if (existing.status === "hit") return { status: "current", tables: prepared.size, reusedTables: cachedTables, vmTables: 0, vmCommands: 0, ms: Date.now() - started };
    signal.throwIfAborted();
    const written = await writeTableCellsArtifact({ ...scope, prepared, byteCap: tableCellsByteCap(sources) });
    const stats: StoreEmbedTableCellsStats = { status: written.status, tables: written.tables, vmTables, reusedTables: cachedTables, vmCommands, bytes: written.bytes, ms: Date.now() - started };
    console.log(`[table-cells] stored stage=${args.stage} document=${args.document.id} status=${stats.status} tables=${stats.tables} vmTables=${vmTables} reused=${cachedTables} bytes=${written.bytes} ms=${stats.ms}`);
    return stats;
  } catch (error) {
    // The stage's own abort (cancellation, shutdown) propagates; our deadline and every other failure do not.
    if (args.signal?.aborted) throw args.signal.reason ?? error;
    const message = deadline.aborted ? `deadline of ${args.deadlineMs ?? STORE_TABLE_CELLS_DEADLINE_MS} ms exceeded` : diagnostic(error);
    console.warn(`[table-cells] not stored stage=${args.stage} document=${args.document.id}; embed parses its tables in a VM: ${message}`);
    return { status: "failed", error: message, ms: Date.now() - started };
  }
}
