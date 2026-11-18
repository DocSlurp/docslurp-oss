/**
 * Stored HTML table cells: the parser VM's cell records for a document's HTML tables, written by the extract-markdown
 * stage (whose parser VM lane is already warm for the document) and read by embed, so embed does not start a parser VM
 * of its own only to turn tables into cells.
 *
 * The host never parses table HTML here. The writer stores what the VM returned, after the same checks as any VM
 * result; the reader re-checks every record with those checks and only ever hands a table's cells to chunking under
 * the sha256 of the exact source chunking asks for. Anything unexpected (a missing, oversized, malformed or foreign
 * artifact, another guest parser version) discards the whole artifact, and every table goes to a parser VM as before.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { CanonicalDocument } from "@docslurp/shared";
import { htmlTableSources } from "./chunking.js";
import { assertHtmlTableCells, vmTableSources, type PreparedHtmlTableCells } from "./html-table-vm.js";
import type { HtmlTableCell } from "./table-cells-guest.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { registeredParserSandbox } from "../sandbox/startup.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import { StorageObjectTooLargeError, type ArtifactStore } from "../tools/storage.js";

export const TABLE_CELLS_ARTIFACT_SCHEMA = "docslurp.html-table-cells.v1";
/** Larger results are not stored (embed parses them in a VM as before); larger objects are never read. */
export const TABLE_CELLS_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_TABLES = 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type TableCellsStorage = Pick<ArtifactStore, "putJson" | "getJson">;

/**
 * DOCSLURP_TABLE_CELLS_CACHE: `on` (default) stores table cells at extract-markdown and lets embed reuse them; `off`
 * keeps the old path (embed parses every table in a VM of its own). Only meaningful where parsing is VM-only.
 */
export function tableCellsCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DOCSLURP_TABLE_CELLS_CACHE?.trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

/** Run-scoped, under the document's artifact root; the purge's `/<documentId>.` match covers it. */
export function tableCellsArtifactKey(run: { id: string; storagePrefix?: string | null }, document: { id: string; userId: string }): string {
  return `${runArtifactRoot(run, document.userId)}/table-cells/${document.id}.json`;
}

export function tableSourceSha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * The table sources embed chunks, from the same inputs embed reads (extractTextForEmbedding): every canonical block's
 * text and the HTML tables inside it, and the HTML tables of the document text.
 */
export function embedHtmlTableSources(extracted: { text: string; canonicalDocument?: CanonicalDocument }): string[] {
  return [
    ...(extracted.canonicalDocument?.blocks.flatMap(block => [block.text.trim(), ...htmlTableSources(block.text)]) ?? []),
    ...htmlTableSources(extracted.text),
  ];
}

let hostGuestDigest: Promise<string | null> | undefined;
/**
 * Which guest parser produced the cells: this worker's copy of the guest script, its compiled parser and limits, the
 * parse5 version, and the registered sandbox's provider and image. Cells stored by one parser are never reused by
 * another (a deploy between extract-markdown and embed), so embed's chunks match what its own VM would return.
 * Null when the guest files cannot be read: then nothing is stored or reused.
 */
export async function tableCellsGuestVersion(): Promise<string | null> {
  hostGuestDigest ??= (async () => {
    try {
      const scripts = resolveScriptsDir();
      const files = [
        path.join(scripts, "table-cells.mjs"),
        path.join(scripts, "..", "dist", "pipeline", "table-cells-guest.js"),
        path.join(scripts, "..", "dist", "pipeline", "html-table-limits.js"),
      ];
      const hash = createHash("sha256");
      for (const file of files) hash.update(await readFile(file)).update("\0");
      const require = createRequire(import.meta.url);
      hash.update(String((require("parse5/package.json") as { version?: unknown }).version ?? ""));
      return hash.digest("hex");
    } catch (error) {
      console.warn(`[table-cells] guest parser files unreadable; stored table cells are off: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();
  const host = await hostGuestDigest;
  if (!host) return null;
  const sandbox = registeredParserSandbox();
  const config = sandbox?.config ?? {};
  const image = (config as { imageId?: unknown; image?: unknown }).imageId ?? (config as { image?: unknown }).image ?? null;
  return createHash("sha256").update(JSON.stringify([host, sandbox?.provider.id ?? null, sandbox?.isolation.location ?? null, typeof image === "string" ? image : null])).digest("hex");
}

/** For tests: forget the cached host digest. */
export function resetTableCellsGuestVersionForTests(): void { hostGuestDigest = undefined; }

interface TableCellsArtifact {
  schema: typeof TABLE_CELLS_ARTIFACT_SCHEMA;
  runId: string;
  documentId: string;
  guestVersion: string;
  tables: Array<{ sha256: string; cells: HtmlTableCell[] | null }>;
}

/**
 * Store the VM's cells for a document's tables. Returns how much was stored, or why nothing was. Never throws for an
 * oversized result: embed then parses those tables in a VM, as it did before.
 */
export async function writeTableCellsArtifact(args: {
  storage: TableCellsStorage;
  key: string;
  runId: string;
  documentId: string;
  guestVersion: string;
  prepared: PreparedHtmlTableCells;
}): Promise<{ status: "written" | "too-large"; tables: number; bytes: number }> {
  const artifact: TableCellsArtifact = {
    schema: TABLE_CELLS_ARTIFACT_SCHEMA,
    runId: args.runId,
    documentId: args.documentId,
    guestVersion: args.guestVersion,
    tables: [...args.prepared].map(([source, cells]) => ({ sha256: tableSourceSha256(source), cells })),
  };
  // Measured once: putJson serializes again, but a document's tables are bounded (32 MiB of source) and this runs once.
  const bytes = Buffer.byteLength(JSON.stringify(artifact));
  if (bytes > TABLE_CELLS_ARTIFACT_MAX_BYTES || artifact.tables.length > MAX_TABLES) return { status: "too-large", tables: artifact.tables.length, bytes };
  await args.storage.putJson(args.key, artifact);
  return { status: "written", tables: artifact.tables.length, bytes };
}

export type TableCellsLookup =
  | { status: "hit" | "partial" | "unused"; cached: Map<string, HtmlTableCell[] | null>; hits: number; misses: number }
  | { status: "missing" | "invalid"; cached: Map<string, HtmlTableCell[] | null>; hits: 0; misses: number; reason: string };

function isStorageNotFound(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const meta = (current as { $metadata?: { httpStatusCode?: number } }).$metadata;
    const name = (current as { name?: unknown }).name;
    if (meta?.httpStatusCode === 404 || name === "NoSuchKey" || name === "NotFound" || (current as { code?: unknown }).code === "ENOENT") return true;
  }
  return false;
}

/** Strict reader: exact top-level keys, this run and document, this guest parser, bounded tables, unique hashes. */
function parseArtifact(raw: unknown, expected: { runId: string; documentId: string; guestVersion: string }): Map<string, HtmlTableCell[] | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "documentId,guestVersion,runId,schema,tables") throw new Error("unexpected fields");
  if (value.schema !== TABLE_CELLS_ARTIFACT_SCHEMA) throw new Error("schema mismatch");
  if (value.runId !== expected.runId || value.documentId !== expected.documentId) throw new Error("artifact belongs to another run or document");
  if (value.guestVersion !== expected.guestVersion) throw new Error("guest parser version changed");
  if (!Array.isArray(value.tables) || value.tables.length > MAX_TABLES) throw new Error("invalid tables");
  const bySha = new Map<string, HtmlTableCell[] | null>();
  for (const entry of value.tables as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid table entry");
    const table = entry as Record<string, unknown>;
    if (Object.keys(table).sort().join(",") !== "cells,sha256") throw new Error("invalid table entry fields");
    if (typeof table.sha256 !== "string" || !SHA256_HEX.test(table.sha256)) throw new Error("invalid table hash");
    if (bySha.has(table.sha256)) throw new Error("duplicate table hash");
    const cells: unknown = table.cells;
    assertHtmlTableCells(cells);
    if (cells) for (const cell of cells) {
      const keys = Object.keys(cell);
      if (keys.some(key => key !== "label" && key !== "value" && key !== "header")) throw new Error("invalid HTML table cell fields");
    }
    bySha.set(table.sha256, cells);
  }
  return bySha;
}

/**
 * Cells for the document's VM table sources from the stored artifact, keyed by the exact source each was looked up
 * by. Every failure is a full miss (`missing`, `invalid`): the caller sends every table to a VM.
 */
export async function readTableCellsArtifact(args: {
  storage: TableCellsStorage;
  key: string;
  runId: string;
  documentId: string;
  guestVersion: string | null;
  sources: string[];
}): Promise<TableCellsLookup> {
  const unique = vmTableSources(args.sources);
  const miss = (status: "missing" | "invalid", reason: string): TableCellsLookup => ({ status, cached: new Map(), hits: 0, misses: unique.length, reason });
  if (unique.length === 0) return { status: "unused", cached: new Map(), hits: 0, misses: 0 };
  if (!args.guestVersion) return miss("invalid", "guest parser version unknown");
  let raw: unknown;
  try {
    raw = await args.storage.getJson<unknown>(args.key, { maxBytes: TABLE_CELLS_ARTIFACT_MAX_BYTES });
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) return miss("invalid", "artifact exceeds size limit");
    if (isStorageNotFound(error)) return miss("missing", "no stored table cells");
    return miss("invalid", `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let bySha: Map<string, HtmlTableCell[] | null>;
  try {
    bySha = parseArtifact(raw, { runId: args.runId, documentId: args.documentId, guestVersion: args.guestVersion });
  } catch (error) {
    return miss("invalid", error instanceof Error ? error.message : String(error));
  }
  const cached = new Map<string, HtmlTableCell[] | null>();
  for (const source of unique) {
    const sha = tableSourceSha256(source);
    if (bySha.has(sha)) cached.set(source, bySha.get(sha) ?? null);
  }
  const hits = cached.size;
  return { status: hits === unique.length ? "hit" : "partial", cached, hits, misses: unique.length - hits };
}

/** Whether this process should store or reuse table cells at all. */
export function tableCellsCacheActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return vmOnlyParsing(env) && tableCellsCacheEnabled(env);
}
