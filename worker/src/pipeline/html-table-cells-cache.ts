/**
 * Stored HTML table cells: the parser VM's cell records for a document's HTML tables, written by the last stage that
 * writes the document's tables before pii-detect (extract-markdown, or vision-extract when it re-reads pages), from a
 * parser VM lane already warm for the document, and read by embed, so embed does not start a parser VM of its own only
 * to turn tables into cells.
 *
 * The host never parses table HTML here. The writer stores what the VM returned, after the same checks as any VM
 * result; the reader re-checks every record with those checks and only ever hands a table's cells to chunking under
 * the sha256 of the exact source chunking asks for. Anything unexpected (a missing, oversized, malformed or foreign
 * artifact, an unknown guest parser) discards the whole artifact, and every table goes to a parser VM as before.
 *
 * Never on a run with a PII policy: the artifact would hold table text from before pii-detect redacts or blocks it.
 */
import { createHash } from "node:crypto";
import type { CanonicalDocument } from "@docslurp/shared";
import { htmlTableSources } from "./chunking.js";
import { assertHtmlTableCells, HTML_TABLE_DOCUMENT_LIMITS, HTML_TABLE_OUTPUT_CEILING, htmlTableCellTagCount, vmTableSources, type PreparedHtmlTableCells } from "./html-table-vm.js";
import { assertJsonShape } from "../lib/json-shape.js";
import type { HtmlTableCell } from "./table-cells-guest.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { registeredParserSandbox, type InitializedParserSandbox } from "../sandbox/startup.js";
import type { ArtifactStore } from "../tools/storage.js";

export const TABLE_CELLS_ARTIFACT_SCHEMA = "docslurp.html-table-cells.v3";
/** Absolute ceiling on a stored artifact (the guest output ceiling); the per-document cap (tableCellsByteCap) is usually far lower. */
export const TABLE_CELLS_ARTIFACT_MAX_BYTES = HTML_TABLE_OUTPUT_CEILING;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROW_LABEL = /^row ([1-9][0-9]{0,3}) column ([1-9][0-9]{0,3}) rowspan ([1-9][0-9]{0,3}) colspan ([1-9][0-9]{0,3})$/;

export type TableCellsStorage = Pick<ArtifactStore, "putBytes" | "openStream">;

/**
 * DOCSLURP_TABLE_CELLS_CACHE. Default off (owner, 2026-11-17: turned on after a production comparison). Only `on`
 * (or `1`, `true`) stores table cells before embed and lets embed reuse them; anything else, unset included, keeps the
 * old path, where embed parses every table in a VM of its own. Only meaningful where parsing is VM-only.
 */
export function tableCellsCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DOCSLURP_TABLE_CELLS_CACHE?.trim().toLowerCase();
  return value === "on" || value === "1" || value === "true";
}

/** A PII policy on the run (any action, matches or not): its artifacts are scanned after extraction, so none is stored. */
export function piiPolicyActive(pipeline: { piiPolicy?: { enabled?: boolean } | null } | null | undefined): boolean {
  return pipeline?.piiPolicy?.enabled === true;
}

/** Whether this run should store or reuse table cells at all (fails closed on a missing pipeline). */
export function tableCellsCacheActive(pipeline: { piiPolicy?: { enabled?: boolean } | null } | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return vmOnlyParsing(env) && tableCellsCacheEnabled(env) && !!pipeline && !piiPolicyActive(pipeline);
}

/** Run-scoped, under the document's artifact root; the purge's `/<documentId>.` match covers it. */
export function tableCellsArtifactKey(run: { id: string; storagePrefix?: string | null }, document: { id: string; userId: string }): string {
  return `${runArtifactRoot(run, document.userId)}/table-cells/${document.id}.json`;
}

/**
 * The table's key: sha256 of the exact bytes the parser VM receives for it (its JSON string, as staged in the batch).
 * Lossless, unlike hashing UTF-8 directly, which maps every unpaired surrogate to U+FFFD.
 */
export function tableSourceSha256(source: string): string {
  return createHash("sha256").update(JSON.stringify(source), "utf8").digest("hex");
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

/**
 * The writer's byte cap for a document's artifact, from the structure of its tables: each stored record costs at most
 * 40 bytes of position, flag and punctuation, its value at most 6 bytes per source byte (JSON escapes), each table 80
 * bytes; never above TABLE_CELLS_ARTIFACT_MAX_BYTES. The reader then reads exactly the length the header records.
 */
export function tableCellsByteCap(sources: string[]): number {
  let bound = 1024;
  for (const source of vmTableSources(sources)) bound += 6 * Buffer.byteLength(source, "utf8") + 40 * htmlTableCellTagCount(source) + 80;
  return Math.min(TABLE_CELLS_ARTIFACT_MAX_BYTES, bound);
}

export type TableCellsGuestVersion = { version: string; reason?: undefined } | { version: null; reason: string };

/**
 * Which guest parser produces the cells: the parser VM image, which carries the guest script, its compiled parser and
 * parse5. Only an immutable reference counts: a Modal image import id (`im-…`) or an image pinned by sha256 digest. A
 * mutable tag, an unregistered sandbox or any other provider has no known guest, and the cache is off (null): cells
 * from one parser are never reused by another (a deploy between the writing stage and embed).
 */
export function tableCellsGuestVersion(...given: [InitializedParserSandbox | undefined] | []): TableCellsGuestVersion {
  const sandbox = given.length ? given[0] : registeredParserSandbox();
  if (!sandbox) return { version: null, reason: "no registered parser sandbox" };
  if (sandbox.provider.id !== "modal" || sandbox.isolation.location !== "remote") return { version: null, reason: `provider ${sandbox.provider.id} has no immutable guest image` };
  const config = sandbox.config as { imageId?: unknown; image?: unknown };
  const imageId = typeof config.imageId === "string" && /^im-[A-Za-z0-9]+$/.test(config.imageId) ? config.imageId : null;
  const pinned = typeof config.image === "string" && /@sha256:[0-9a-f]{64}$/.test(config.image) ? config.image : null;
  const image = imageId ?? pinned;
  if (!image) return { version: null, reason: "parser image is not pinned (no image id or sha256 digest)" };
  return { version: createHash("sha256").update(JSON.stringify([TABLE_CELLS_ARTIFACT_SCHEMA, sandbox.provider.id, image])).digest("hex") };
}

let reportedUnknownGuest = false;
/** Log once per process when the cache is on but no guest identity is known (it then never activates). */
export function reportUnknownGuest(reason: string): void {
  if (reportedUnknownGuest) return;
  reportedUnknownGuest = true;
  console.warn(`[table-cells] status=unavailable metric=table_cells_guest_unknown reason=${JSON.stringify(reason)}: stored table cells are off`);
}

/** Compact cell encoding: a caption is `[h, value]`, a cell `[row, column, rowspan, colspan, h, value]`; h 0 false, 1 true, 2 absent. */
type EncodedCell = [number, string] | [number, number, number, number, number, string];
const encodeHeader = (header: boolean | undefined) => header === undefined ? 2 : header ? 1 : 0;
const decodeHeader = (h: number) => h === 2 ? undefined : h === 1;

function encodeCells(cells: HtmlTableCell[] | null): EncodedCell[] | null {
  if (cells === null) return null;
  return cells.map((cell) => {
    if (cell.label === "caption") return [encodeHeader(cell.header), cell.value];
    const match = ROW_LABEL.exec(cell.label);
    if (!match) throw new Error("invalid HTML table cell label");
    return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), encodeHeader(cell.header), cell.value];
  });
}

const smallInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 9999;

function decodeCells(encoded: unknown): HtmlTableCell[] | null {
  if (encoded === null) return null;
  if (!Array.isArray(encoded)) throw new Error("cells not a list");
  return encoded.map((entry: unknown) => {
    if (!Array.isArray(entry)) throw new Error("invalid encoded cell");
    const h = entry.length === 2 ? entry[0] : entry.length === 6 ? entry[4] : -1;
    if (h !== 0 && h !== 1 && h !== 2) throw new Error("invalid encoded cell");
    const value = entry[entry.length - 1];
    if (typeof value !== "string") throw new Error("invalid encoded cell");
    const header = decodeHeader(h);
    let cell: HtmlTableCell;
    if (entry.length === 2) cell = { label: "caption", value };
    else {
      const [row, column, rowspan, colspan] = entry;
      if (![row, column, rowspan, colspan].every(smallInt)) throw new Error("invalid encoded cell");
      cell = { label: `row ${row} column ${column} rowspan ${rowspan} colspan ${colspan}`, value };
    }
    if (header !== undefined) cell.header = header;
    return cell;
  });
}

/** What an artifact is bound to: this run, document, Markdown generation (the markdown slot it was written for) and guest. */
export interface TableCellsScope { runId: string; documentId: string; markdownUri: string; guestVersion: string }
const LENGTH_DIGITS = 10;

/** The header up to the length field; then `LENGTH_DIGITS` digits, then HEADER_TAIL. Fixed for a scope, so read first. */
function headerHead(scope: TableCellsScope): string {
  return `${JSON.stringify({ schema: TABLE_CELLS_ARTIFACT_SCHEMA, runId: scope.runId, documentId: scope.documentId, markdownUri: scope.markdownUri, guestVersion: scope.guestVersion }).slice(0, -1)},"bytes":"`;
}
const HEADER_TAIL = `","tables":[`;
const FOOTER = "]}";

/**
 * Store the VM's cells for a document's tables. Serialized one table at a time, counting bytes as it goes, and stopped
 * at the cap before the whole artifact is built; then uploaded as those bytes under the caller's signal. Returns how
 * much was stored, or why nothing was (over the byte cap or the table limit: embed then parses those tables in a VM).
 *
 * Last writer wins: each write is a complete artifact for one Markdown generation, and a reader refuses any other
 * generation, so a lost or stale write is only a miss, which embed parses in a VM. No conditional put is needed.
 */
export async function writeTableCellsArtifact(args: TableCellsScope & {
  storage: Pick<ArtifactStore, "putBytes">;
  key: string;
  prepared: PreparedHtmlTableCells;
  byteCap: number;
  signal?: AbortSignal;
}): Promise<{ status: "written" | "too-large"; tables: number; bytes: number }> {
  const tables = args.prepared.size;
  if (tables > HTML_TABLE_DOCUMENT_LIMITS.tables) return { status: "too-large", tables, bytes: 0 };
  const cap = Math.min(args.byteCap, TABLE_CELLS_ARTIFACT_MAX_BYTES);
  const head = Buffer.from(headerHead(args), "utf8");
  const tail = Buffer.from(HEADER_TAIL, "utf8");
  const parts: Buffer[] = [];
  let bytes = head.length + LENGTH_DIGITS + tail.length + FOOTER.length;
  for (const [source, cells] of args.prepared) {
    const part = Buffer.from(`${parts.length ? "," : ""}${JSON.stringify([tableSourceSha256(source), encodeCells(cells)])}`, "utf8");
    bytes += part.length;
    if (bytes > cap) return { status: "too-large", tables, bytes };
    parts.push(part);
  }
  const length = Buffer.from(String(bytes).padStart(LENGTH_DIGITS, "0"), "utf8");
  await args.storage.putBytes(args.key, Buffer.concat([head, length, tail, ...parts, Buffer.from(FOOTER)], bytes), "application/json", { signal: args.signal });
  return { status: "written", tables, bytes };
}

export type TableCellsLookup =
  | { status: "hit" | "partial" | "unused"; cached: Map<string, HtmlTableCell[] | null>; hits: number; misses: number }
  | { status: "missing" | "invalid" | "unavailable"; cached: Map<string, HtmlTableCell[] | null>; hits: 0; misses: number; reason: string };

class TableCellsRefused extends Error {}

function isStorageNotFound(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const meta = (current as { $metadata?: { httpStatusCode?: number } }).$metadata;
    const name = (current as { name?: unknown }).name;
    if (meta?.httpStatusCode === 404 || name === "NoSuchKey" || name === "NotFound") return true;
  }
  return false;
}

/**
 * Read the artifact header first and only then its body: the header (a fixed length for this scope) must match this
 * run, document, Markdown generation and guest exactly and record the artifact's total length, which bounds the rest
 * of the read (never above the ceiling). The transfer stops at the first byte past it, whether or not the store
 * reports a length.
 */
async function readArtifactBytes(storage: Pick<ArtifactStore, "openStream">, key: string, scope: TableCellsScope, signal?: AbortSignal): Promise<string> {
  const head = Buffer.from(headerHead(scope), "utf8");
  const headerBytes = head.length + LENGTH_DIGITS + HEADER_TAIL.length;
  const { stream, size } = await storage.openStream(key, signal);
  const iterator = stream[Symbol.asyncIterator]();
  const stop = async (reason: string): Promise<never> => {
    await iterator.return?.();
    (stream as { destroy?: () => void }).destroy?.();
    throw new TableCellsRefused(reason);
  };
  if (size !== null && size > TABLE_CELLS_ARTIFACT_MAX_BYTES) return await stop("artifact exceeds size limit");
  const chunks: Buffer[] = [];
  let received = 0;
  let total = Number.POSITIVE_INFINITY;
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    chunks.push(Buffer.from(next.value));
    received += next.value.length;
    if (total === Number.POSITIVE_INFINITY && received >= headerBytes) {
      const header = Buffer.concat(chunks, received).subarray(0, headerBytes);
      if (!header.subarray(0, head.length).equals(head) || header.subarray(head.length + LENGTH_DIGITS).toString("utf8") !== HEADER_TAIL) return await stop("artifact header mismatch (schema, run, document, generation or guest)");
      const digits = header.subarray(head.length, head.length + LENGTH_DIGITS).toString("utf8");
      if (!/^[0-9]{10}$/.test(digits)) return await stop("invalid artifact length");
      total = Number(digits);
      if (total < headerBytes + FOOTER.length || total > TABLE_CELLS_ARTIFACT_MAX_BYTES || (size !== null && size !== total)) return await stop("artifact length mismatch");
    }
    if (received > total || (total === Number.POSITIVE_INFINITY && received > headerBytes + 64 * 1024)) return await stop("artifact exceeds its recorded length");
  }
  if (received !== total) throw new TableCellsRefused("artifact truncated");
  return Buffer.concat(chunks, received).toString("utf8");
}

/**
 * Strict reader, after the header and length checks above. Before JSON.parse: nesting at most 5 deep and at most one
 * array or object per 6 bytes (the smallest stored record), so parsing cannot amplify the bounded body much. Then
 * exact top-level keys; entries are `[sha256, cells]` pairs with lowercase hex hashes, unique, at most 1,024; cells
 * decode to flat records that pass the VM-output check; and the artifact stays within the document's cell and text
 * budgets.
 */
function parseArtifact(body: string, scope: TableCellsScope): Map<string, HtmlTableCell[] | null> {
  if (!body.endsWith(FOOTER)) throw new Error("artifact truncated");
  assertJsonShape(body, { maxDepth: 5, maxContainers: Math.floor(body.length / 6) + 8 });
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).join(",") !== "schema,runId,documentId,markdownUri,guestVersion,bytes,tables") throw new Error("unexpected fields");
  if (value.schema !== TABLE_CELLS_ARTIFACT_SCHEMA || value.runId !== scope.runId || value.documentId !== scope.documentId || value.markdownUri !== scope.markdownUri || value.guestVersion !== scope.guestVersion) throw new Error("artifact header mismatch");
  if (!Array.isArray(value.tables) || value.tables.length > HTML_TABLE_DOCUMENT_LIMITS.tables) throw new Error("invalid tables");
  const bySha = new Map<string, HtmlTableCell[] | null>();
  let cellCount = 0, textChars = 0;
  for (const entry of value.tables as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("invalid table entry");
    const [sha, encoded] = entry;
    if (typeof sha !== "string" || !SHA256_HEX.test(sha)) throw new Error("invalid table hash");
    if (bySha.has(sha)) throw new Error("duplicate table hash");
    const cells = decodeCells(encoded);
    assertHtmlTableCells(cells);
    if (cells) {
      cellCount += cells.length;
      for (const cell of cells) textChars += cell.value.length;
      if (cellCount > HTML_TABLE_DOCUMENT_LIMITS.cells || textChars > HTML_TABLE_DOCUMENT_LIMITS.textChars) throw new Error("artifact exceeds the document budget");
    }
    bySha.set(sha, cells);
  }
  return bySha;
}

/**
 * Cells for the document's VM table sources from the stored artifact, keyed by the exact source each was looked up
 * by. Every failure is a full miss (`missing`, `invalid`, `unavailable`): the caller sends every table to a VM.
 */
export async function readTableCellsArtifact(args: {
  storage: Pick<ArtifactStore, "openStream">;
  key: string;
  runId: string;
  documentId: string;
  /** The document's current markdown slot: an artifact written for another generation is refused. */
  markdownUri: string | undefined;
  guestVersion: string | null;
  sources: string[];
  signal?: AbortSignal;
}): Promise<TableCellsLookup> {
  const unique = vmTableSources(args.sources);
  const miss = (status: "missing" | "invalid" | "unavailable", reason: string): TableCellsLookup => ({ status, cached: new Map(), hits: 0, misses: unique.length, reason: reason.replace(/\s+/g, " ").slice(0, 200) });
  if (unique.length === 0) return { status: "unused", cached: new Map(), hits: 0, misses: 0 };
  if (!args.guestVersion) return miss("unavailable", "guest parser version unknown");
  if (!args.markdownUri) return miss("unavailable", "no markdown slot");
  const scope: TableCellsScope = { runId: args.runId, documentId: args.documentId, markdownUri: args.markdownUri, guestVersion: args.guestVersion };
  let body: string;
  try {
    body = await readArtifactBytes(args.storage, args.key, scope, args.signal);
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (error instanceof TableCellsRefused) return miss("invalid", error.message);
    if (isStorageNotFound(error)) return miss("missing", "no stored table cells");
    return miss("invalid", `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let bySha: Map<string, HtmlTableCell[] | null>;
  try {
    bySha = parseArtifact(body, scope);
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
