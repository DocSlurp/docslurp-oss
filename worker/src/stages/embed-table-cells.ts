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
import { hasVmHtmlTableWork, HTML_TABLE_DOCUMENT_LIMITS, prepareHtmlTableCells, vmTableSources } from "../pipeline/html-table-vm.js";
import {
  embedHtmlTableSources,
  reportUnknownGuest,
  tableCellsArtifactKey,
  tableCellsByteCap,
  tableCellsCacheActive,
  tableCellsGuestVersion,
  writeTableCellsArtifact,
  type TableCellsStorage,
} from "../pipeline/html-table-cells-cache.js";
import { embedTextFromMarkdown } from "./embedding-runtime.js";
import { normalizeNfc } from "../lib/unicode-text.js";

/** Total time the best-effort writer may take (one warm VM command plus one read and one write). */
export const STORE_TABLE_CELLS_DEADLINE_MS = 90_000;

export interface StoreEmbedTableCellsStats {
  status: "off" | "pii-policy" | "vision-pending" | "no-tables" | "unavailable" | "written" | "too-large" | "failed";
  tables?: number;
  vmTables?: number;
  vmCommands?: number;
  bytes?: number;
  ms?: number;
  /** Internal diagnostics only: at most 200 characters, one line (the public API withholds `error` keys). */
  error?: string;
}

const diagnostic = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

/**
 * The table sources embed will chunk, from the Markdown and canonical document a stage just wrote (in memory). Equal
 * to embed's own set (embedHtmlTableSources over extractTextForEmbedding of those artifacts): the text goes through
 * the same derivation, and canonical block text is NFC-normalized as readCanonicalDocumentArtifact does on read.
 */
export function writerTableSources(markdown: string, canonicalDocument: CanonicalDocument | undefined): string[] {
  const canonical = canonicalDocument && { ...canonicalDocument, blocks: canonicalDocument.blocks.map((block) => ({ ...block, text: normalizeNfc(block.text) })) };
  return embedHtmlTableSources({ text: embedTextFromMarkdown(markdown, canonical), canonicalDocument: canonical });
}

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
  /** That markdown slot's URI: the artifact is bound to this generation, and embed refuses it for any other. */
  markdownUri: string;
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
  const sources = writerTableSources(args.markdown, args.canonicalDocument);
  if (!hasVmHtmlTableWork(sources)) return { status: "no-tables" };
  const tables = vmTableSources(sources).length;
  if (tables > HTML_TABLE_DOCUMENT_LIMITS.tables) return { status: "too-large", tables };
  const guest = tableCellsGuestVersion();
  if (guest.version === null) { reportUnknownGuest(guest.reason); return { status: "unavailable", error: guest.reason }; }
  // The deadline covers the VM command and the upload (the signal reaches the storage request).
  const deadline = AbortSignal.timeout(args.deadlineMs ?? STORE_TABLE_CELLS_DEADLINE_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, deadline]) : deadline;
  try {
    // Always a fresh artifact for this generation: every table is parsed now, nothing carried over from an earlier write.
    const { prepared, vmTables, vmCommands } = await prepareHtmlTableCells(sources, args.runner, signal);
    signal.throwIfAborted();
    const written = await writeTableCellsArtifact({
      storage: args.storage, key: tableCellsArtifactKey(args.run, args.document), runId: args.run.id, documentId: args.document.id,
      markdownUri: args.markdownUri, guestVersion: guest.version, prepared, byteCap: tableCellsByteCap(sources), signal,
    });
    const stats: StoreEmbedTableCellsStats = { status: written.status, tables: written.tables, vmTables, vmCommands, bytes: written.bytes, ms: Date.now() - started };
    console.log(`[table-cells] stored stage=${args.stage} document=${args.document.id} status=${stats.status} tables=${stats.tables} vmTables=${vmTables} bytes=${written.bytes} ms=${stats.ms}`);
    return stats;
  } catch (error) {
    // The stage's own abort (cancellation, shutdown) propagates; our deadline and every other failure do not.
    if (args.signal?.aborted) throw args.signal.reason ?? error;
    const message = deadline.aborted ? `deadline of ${args.deadlineMs ?? STORE_TABLE_CELLS_DEADLINE_MS} ms exceeded` : diagnostic(error);
    console.warn(`[table-cells] not stored stage=${args.stage} document=${args.document.id}; embed parses its tables in a VM: ${message}`);
    return { status: "failed", error: message, ms: Date.now() - started };
  }
}
