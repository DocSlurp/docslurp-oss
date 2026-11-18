/**
 * Store the parser VM's cells for the HTML tables embed will chunk, from a stage whose parser VM lane is already warm
 * for the document (extract-markdown, vision-extract), so embed reuses them instead of starting a VM of its own.
 *
 * Best effort: any failure is logged and leaves embed on its VM path; it never fails the calling stage (an abort still
 * propagates). Table HTML is only ever parsed in the parser VM (prepareHtmlTableCells).
 */
import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { hasVmHtmlTableWork, prepareHtmlTableCells } from "../pipeline/html-table-vm.js";
import {
  embedHtmlTableSources,
  readTableCellsArtifact,
  tableCellsArtifactKey,
  tableCellsCacheActive,
  tableCellsGuestVersion,
  writeTableCellsArtifact,
} from "../pipeline/html-table-cells-cache.js";
import { extractTextForEmbedding } from "./embedding-runtime.js";

export interface StoreEmbedTableCellsStats {
  status: "off" | "no-tables" | "unavailable" | "current" | "written" | "too-large" | "failed";
  tables?: number;
  vmTables?: number;
  reusedTables?: number;
  vmCommands?: number;
  bytes?: number;
  ms?: number;
  error?: string;
}

export async function storeEmbedTableCells(args: {
  run: { id: string; storagePrefix?: string | null };
  document: Document;
  runner: Pick<CommandRunner, "run">;
  storage: ArtifactStore;
  stage: string;
  /** The Markdown artifact embed will read (required: without one embed would read the source, and nothing is stored). */
  markdownUri: string | undefined;
  canonicalUri: string | undefined;
  signal?: AbortSignal;
}): Promise<StoreEmbedTableCellsStats> {
  const started = Date.now();
  if (!tableCellsCacheActive()) return { status: "off" };
  if (!args.markdownUri) return { status: "unavailable", error: "no markdown artifact" };
  try {
    // Exactly what embed reads (artifacts only: a Markdown artifact is given, so nothing re-extracts the source).
    const extracted = await extractTextForEmbedding(args.document, args.runner as CommandRunner, args.storage, args.markdownUri, args.signal, args.canonicalUri);
    const sources = embedHtmlTableSources(extracted);
    if (!hasVmHtmlTableWork(sources)) return { status: "no-tables" };
    const guestVersion = await tableCellsGuestVersion();
    if (!guestVersion) return { status: "unavailable", error: "guest parser version unknown" };
    const key = tableCellsArtifactKey(args.run, args.document);
    const scope = { storage: args.storage, key, runId: args.run.id, documentId: args.document.id };
    // A retried stage, or vision-extract after extract-markdown: keep the tables already parsed, parse only new ones.
    const existing = await readTableCellsArtifact({ ...scope, guestVersion, sources });
    const { prepared, vmTables, cachedTables, vmCommands } = await prepareHtmlTableCells(sources, args.runner, args.signal, { cached: existing.cached });
    if (existing.status === "hit") return { status: "current", tables: prepared.size, reusedTables: cachedTables, vmTables: 0, vmCommands: 0, ms: Date.now() - started };
    const written = await writeTableCellsArtifact({ ...scope, guestVersion, prepared });
    const stats: StoreEmbedTableCellsStats = { status: written.status, tables: written.tables, vmTables, reusedTables: cachedTables, vmCommands, bytes: written.bytes, ms: Date.now() - started };
    console.log(`[table-cells] stored stage=${args.stage} document=${args.document.id} status=${stats.status} tables=${stats.tables} vmTables=${vmTables} reused=${cachedTables} bytes=${written.bytes} ms=${stats.ms}`);
    return stats;
  } catch (error) {
    if (args.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[table-cells] not stored stage=${args.stage} document=${args.document.id}; embed parses its tables in a VM: ${message}`);
    return { status: "failed", error: message, ms: Date.now() - started };
  }
}

/** Cheap in-memory check before reading artifacts back: no `<table` anywhere means embed has no VM table work. */
export function mayHaveHtmlTables(text: string | null | undefined, blocks: ReadonlyArray<{ text: string }> = []): boolean {
  return (!!text && /<table/i.test(text)) || blocks.some(block => /<table/i.test(block.text));
}
