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
import { assertHtmlTableCells, effectiveHtmlTableOutputCap, HTML_TABLE_DOCUMENT_LIMITS, htmlTableCellTagCount, htmlTableValueBound, TABLE_PARSE_HEAP_FACTOR, tableParseMemoryBudget, vmTableSources, type HtmlTableStatsMemo, type PreparedHtmlTableCells } from "./html-table-vm.js";
import { HTML_TABLE_MAX_CELLS, HTML_TABLE_MAX_SOURCE_CHARS } from "./html-table-limits.js";
import type { TableCellRetention } from "./html-table-vm.js";
import { assertJsonShape } from "../lib/json-shape.js";
import type { HtmlTableCell } from "./table-cells-guest.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { registeredParserSandbox, type InitializedParserSandbox } from "../sandbox/startup.js";
import type { ArtifactStore } from "../tools/storage.js";

export const TABLE_CELLS_ARTIFACT_SCHEMA = "docslurp.html-table-cells.v3";
/** Absolute ceiling on a stored artifact; the per-document cap (tableCellsByteCap, from the tables' structure) is usually far lower. */
export const TABLE_CELLS_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROW_LABEL = /^row ([1-9][0-9]{0,3}) column ([1-9][0-9]{0,3}) rowspan ([1-9][0-9]{0,3}) colspan ([1-9][0-9]{0,3})$/;

export type TableCellsStorage = Pick<ArtifactStore, "putBytes" | "openStream">;

/**
 * DOCSLURP_TABLE_CELLS_CACHE. Off until a production comparison (owner, 2026-11-17). Only `on`
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
 * The byte cap of a document's artifact, from the structure of the tables being stored or looked up (never from an
 * artifact): each table's encoded text (htmlTableValueBound), at most 40 bytes of position, flag and punctuation per
 * record (one per cell tag) and 80 per table, plus the header; never above TABLE_CELLS_ARTIFACT_MAX_BYTES. The writer
 * does not store above it; the reader refuses a longer artifact before reading its body.
 */
export function tableCellsByteCap(sources: string[], memo?: HtmlTableStatsMemo): number {
  let bound = 1024;
  for (const source of vmTableSources(sources)) bound += htmlTableValueBound(source, memo) + 40 * htmlTableCellTagCount(source, memo) + 80;
  return Math.min(TABLE_CELLS_ARTIFACT_MAX_BYTES, bound);
}

/**
 * The generation an artifact belongs to: sha256 over the distinct VM table sources it holds cells for, sorted and each
 * JSON-encoded (lossless, unambiguous), and the per-table output cap in effect. Cells depend on nothing else (a pure
 * function of the source, the guest and that cap), so this is exactly the content a stored artifact is valid for. The writer hashes the sources it derived from
 * what it wrote; embed hashes the sources it derived from what it read. Only an exact match is used, so a late write of
 * an older generation (a retried stage's slower PUT) is never served for a newer one, and neither side copies or
 * hashes the whole document text.
 */
export function tableCellsGeneration(sources: string[]): string {
  // The per-table output cap in effect is part of the identity: cells stored under another cap (a table that was
  // over it there is null) are a different generation, a miss.
  const hash = createHash("sha256").update(`cap:${effectiveHtmlTableOutputCap()}\n`);
  for (const source of vmTableSources(sources).sort()) hash.update(JSON.stringify(source), "utf8").update("\n");
  return hash.digest("hex");
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

/**
 * Decode one table's stored records. Its record count and every value's length are checked before anything is built,
 * and the document's running cell and text totals are charged as it goes (`budget`).
 */
function decodeCells(encoded: unknown, budget: { cells: number; textChars: number }): HtmlTableCell[] | null {
  if (encoded === null) return null;
  if (!Array.isArray(encoded)) throw new Error("cells not a list");
  if (encoded.length > HTML_TABLE_MAX_CELLS) throw new Error("table record count exceeds limit");
  budget.cells += encoded.length;
  if (budget.cells > HTML_TABLE_DOCUMENT_LIMITS.cells) throw new Error("artifact exceeds the document budget");
  for (const entry of encoded as unknown[]) {
    if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 6)) throw new Error("invalid encoded cell");
    const value = entry[entry.length - 1];
    if (typeof value !== "string" || value.length > HTML_TABLE_MAX_SOURCE_CHARS) throw new Error("invalid encoded cell");
    budget.textChars += value.length;
    if (budget.textChars > HTML_TABLE_DOCUMENT_LIMITS.textChars) throw new Error("artifact exceeds the document budget");
  }
  return (encoded as unknown[][]).map((entry) => {
    const h = entry.length === 2 ? entry[0] : entry[4];
    if (h !== 0 && h !== 1 && h !== 2) throw new Error("invalid encoded cell");
    const value = entry[entry.length - 1] as string;
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

/** What an artifact is bound to: this run, document, content generation (tableCellsGeneration) and guest. */
export interface TableCellsScope { runId: string; documentId: string; generation: string; guestVersion: string }
const LENGTH_DIGITS = 10;

/** The header up to the length field; then `LENGTH_DIGITS` digits, then HEADER_TAIL. Fixed for a scope, so read first. */
function headerHead(scope: TableCellsScope): string {
  return `${JSON.stringify({ schema: TABLE_CELLS_ARTIFACT_SCHEMA, runId: scope.runId, documentId: scope.documentId, generation: scope.generation, guestVersion: scope.guestVersion }).slice(0, -1)},"bytes":"`;
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
    // Charged before this table is serialized, from its cells: each value's JSON-encoded size (UTF-8 bytes plus escape
    // growth) and 40 bytes per record. Over the cap, nothing more is built.
    let estimate = 80;
    for (const cell of cells ?? []) estimate += 40 + jsonStringBound(cell.value);
    if (bytes + estimate > cap) return { status: "too-large", tables, bytes: bytes + estimate };
    const part = Buffer.from(`${parts.length ? "," : ""}${JSON.stringify([tableSourceSha256(source), encodeCells(cells)])}`, "utf8");
    bytes += part.length;
    parts.push(part);
  }
  const length = Buffer.from(String(bytes).padStart(LENGTH_DIGITS, "0"), "utf8");
  await args.storage.putBytes(args.key, Buffer.concat([head, length, tail, ...parts, Buffer.from(FOOTER)], bytes), "application/json", { signal: args.signal });
  return { status: "written", tables, bytes };
}

/** Upper bound of a string's JSON encoding: UTF-8 bytes, +5 per control character, +1 per quote or backslash, +3 per lone surrogate. */
function jsonStringBound(value: string): number {
  let growth = 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 32 || c === 127) growth += 5;
    else if (c === 34 || c === 92) growth += 1;
    else if (c >= 0xd800 && c <= 0xdfff) growth += 3;
  }
  return Buffer.byteLength(value, "utf8") + growth;
}

export type TableCellsLookup =
  | { status: "hit" | "partial" | "unused"; cached: Map<string, HtmlTableCell[] | null>; hits: number; misses: number }
  | { status: "missing" | "stale" | "invalid" | "unavailable"; cached: Map<string, HtmlTableCell[] | null>; hits: 0; misses: number; reason: string };

class TableCellsRefused extends Error {
  /** `stale`: a well-formed artifact for this run, document and guest, written for other table sources. */
  constructor(message: string, readonly stale = false) { super(message); }
}

function isStorageNotFound(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const meta = (current as { $metadata?: { httpStatusCode?: number } }).$metadata;
    const name = (current as { name?: unknown }).name;
    if (meta?.httpStatusCode === 404 || name === "NoSuchKey" || name === "NotFound") return true;
  }
  return false;
}

/** The limits a stored artifact for these tables must fit, from their structure alone (never from the artifact). */
interface ReadBudget { bytes: number; tables: number; containers: number; scalars: number; longestString: number; recordsBySha: ReadonlyMap<string, number> }
function readBudget(unique: string[]): ReadBudget {
  const memo: HtmlTableStatsMemo = new Map();
  // Records the artifact may hold: one per cell tag, but never more than a table's or the document's cell limit, so a
  // tag-heavy source cannot raise the pre-scan's container and scalar limits past what decoding would accept.
  const recordsBySha = new Map(unique.map((source) => [tableSourceSha256(source), Math.min(HTML_TABLE_MAX_CELLS, htmlTableCellTagCount(source, memo))]));
  const tags = Math.min(HTML_TABLE_DOCUMENT_LIMITS.cells, [...recordsBySha.values()].reduce((total, count) => total + count, 0));
  return {
    bytes: tableCellsByteCap(unique, memo),
    recordsBySha,
    tables: unique.length,
    // { tables [ [sha, [ [cell] ] ] ] }: the object, the tables list, a pair and a records list per table, one per record.
    containers: 2 + 2 * unique.length + tags,
    // 7 header keys and values, a hash (or null) per table, at most 6 per record.
    scalars: 16 + 2 * unique.length + 6 * tags,
    // A value is at most its table's encoded text; header strings (ids, hashes) are short.
    longestString: Math.max(256, ...unique.map((source) => htmlTableValueBound(source, memo) + 2)),
  };
}

/**
 * Read the artifact header first and only then its body. The header (a fixed length for this scope) must match this
 * run, document, generation and guest exactly. Its recorded length, and any length the store reports, must fit the
 * budget computed from the tables being looked up, or nothing past the header is read. The transfer stops at the
 * first byte past the recorded length, whether or not the store reports one.
 */
async function readArtifactBytes(storage: Pick<ArtifactStore, "openStream">, key: string, scope: TableCellsScope, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const head = Buffer.from(headerHead(scope), "utf8");
  const headerBytes = head.length + LENGTH_DIGITS + HEADER_TAIL.length;
  const { stream, size } = await storage.openStream(key, signal);
  const iterator = stream[Symbol.asyncIterator]();
  const stop = async (reason: string, stale = false): Promise<never> => {
    await iterator.return?.();
    (stream as { destroy?: () => void }).destroy?.();
    throw new TableCellsRefused(reason, stale);
  };
  if (size !== null && size > maxBytes) return await stop("artifact exceeds the read budget for these tables");
  // Until the header is known, at most a header's worth of chunks is held; then one buffer of exactly the recorded
  // length is allocated and filled in place (no concatenation copy).
  const pending: Buffer[] = [];
  let received = 0;
  let body: Buffer | null = null;
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
    if (body) {
      if (received + chunk.length > body.length) return await stop("artifact exceeds its recorded length");
      chunk.copy(body, received);
      received += chunk.length;
      continue;
    }
    pending.push(chunk);
    received += chunk.length;
    if (received < headerBytes) {
      if (received > 64 * 1024) return await stop("artifact header mismatch (schema, run, document, generation or guest)");
      continue;
    }
    const start = Buffer.concat(pending, received);
    const header = start.subarray(0, headerBytes);
    const tailMatches = header.subarray(head.length + LENGTH_DIGITS).toString("utf8") === HEADER_TAIL;
    if (!header.subarray(0, head.length).equals(head) || !tailMatches) {
      return await stop(staleGeneration(header.subarray(0, head.length), head) ? "artifact written for other table sources" : "artifact header mismatch (schema, run, document or guest)", staleGeneration(header.subarray(0, head.length), head) && tailMatches);
    }
    const digits = header.subarray(head.length, head.length + LENGTH_DIGITS).toString("utf8");
    if (!/^[0-9]{10}$/.test(digits)) return await stop("invalid artifact length");
    const total = Number(digits);
    if (total > maxBytes) return await stop("artifact exceeds the read budget for these tables");
    if (total < headerBytes + FOOTER.length || (size !== null && size !== total)) return await stop("artifact length mismatch");
    if (received > total) return await stop("artifact exceeds its recorded length");
    body = Buffer.allocUnsafe(total);
    start.copy(body, 0, 0, received);
    pending.length = 0;
  }
  if (!body || received !== body.length) throw new TableCellsRefused("artifact truncated");
  return body.toString("utf8");
}

/** Whether a header differs from the expected one only in its 64-hex generation. */
function staleGeneration(actual: Buffer, expected: Buffer): boolean {
  if (actual.length !== expected.length) return false;
  const marker = Buffer.from('"generation":"');
  const at = expected.indexOf(marker);
  if (at < 0) return false;
  const from = at + marker.length, to = from + 64;
  return actual.subarray(0, from).equals(expected.subarray(0, from)) && actual.subarray(to).equals(expected.subarray(to))
    && /^[0-9a-f]{64}$/.test(actual.subarray(from, to).toString("latin1"));
}

/**
 * Strict reader, after the header and length checks above. Before JSON.parse, the shape must fit the budget of the
 * tables being looked up: nesting at most 5 deep, at most one array or object per table and per record, at most 6
 * scalars per record, and no string longer than the longest table's encoded text. Then exact top-level keys; entries
 * are `[sha256, cells]` pairs, lowercase hex, unique, no more than the tables looked up; each table's record count and
 * value lengths are checked, and the document's cell and text budgets charged, before its records are decoded.
 */
function parseArtifact(body: string, scope: TableCellsScope, budget: ReadBudget): Map<string, HtmlTableCell[] | null> {
  if (!body.endsWith(FOOTER)) throw new Error("artifact truncated");
  let remainingRecords = 0;
  const seen = new Set<string>();
  assertJsonShape(body, {
    maxDepth: 5, maxContainers: budget.containers, maxScalars: budget.scalars, maxStringLength: budget.longestString,
    onContainer(depth, start, kind) {
      if (depth > 1 && kind !== 91) throw new Error("invalid table array");
      if (depth === 3) {
        // Artifacts written by this worker have compact entries and a fixed-width hash.
        const hash = body.slice(start + 2, start + 66);
        if (body[start + 1] !== '"' || body.slice(start + 66, start + 68) !== '",'
          || !budget.recordsBySha.has(hash) || seen.has(hash)) throw new Error("invalid table hash");
        seen.add(hash);
        remainingRecords = budget.recordsBySha.get(hash)!;
      } else if (depth === 5 && --remainingRecords < 0) {
        throw new Error("table record count exceeds source limit");
      }
    },
  });
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).join(",") !== "schema,runId,documentId,generation,guestVersion,bytes,tables") throw new Error("unexpected fields");
  if (value.schema !== TABLE_CELLS_ARTIFACT_SCHEMA || value.runId !== scope.runId || value.documentId !== scope.documentId || value.generation !== scope.generation || value.guestVersion !== scope.guestVersion) throw new Error("artifact header mismatch");
  if (!Array.isArray(value.tables) || value.tables.length > Math.min(budget.tables, HTML_TABLE_DOCUMENT_LIMITS.tables)) throw new Error("invalid tables");
  const bySha = new Map<string, HtmlTableCell[] | null>();
  const totals = { cells: 0, textChars: 0 };
  for (const entry of value.tables as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("invalid table entry");
    const [sha, encoded] = entry;
    if (typeof sha !== "string" || !SHA256_HEX.test(sha)) throw new Error("invalid table hash");
    if (bySha.has(sha)) throw new Error("duplicate table hash");
    const cells = decodeCells(encoded, totals);
    assertHtmlTableCells(cells);
    bySha.set(sha, cells);
  }
  return bySha;
}

/**
 * Cells for the document's VM table sources from the stored artifact, keyed by the exact source each was looked up
 * by. Every failure is a full miss (`missing`, `invalid`, `unavailable`): the caller sends every table to a VM. The
 * read holds its byte budget from the worker-wide table-parse budget while it reads and decodes.
 */
export async function readTableCellsArtifact(args: {
  storage: Pick<ArtifactStore, "openStream">;
  key: string;
  runId: string;
  documentId: string;
  /** tableCellsGeneration of what the caller read: only an artifact of exactly that generation is used. */
  generation: string;
  guestVersion: string | null;
  sources: string[];
  retention?: TableCellRetention;
  signal?: AbortSignal;
}): Promise<TableCellsLookup> {
  const unique = vmTableSources(args.sources);
  const miss = (status: "missing" | "stale" | "invalid" | "unavailable", reason: string): TableCellsLookup => ({ status, cached: new Map(), hits: 0, misses: unique.length, reason: reason.replace(/\s+/g, " ").slice(0, 200) });
  if (unique.length === 0) return { status: "unused", cached: new Map(), hits: 0, misses: 0 };
  if (!args.guestVersion) return miss("unavailable", "guest parser version unknown");
  if (unique.length > HTML_TABLE_DOCUMENT_LIMITS.tables) return miss("unavailable", "more tables than an artifact may hold");
  const scope: TableCellsScope = { runId: args.runId, documentId: args.documentId, generation: args.generation, guestVersion: args.guestVersion };
  const budget = readBudget(unique);
  // The read holds the worker budget for all it can cost: the bytes, the decoded string and JSON.parse's heap
  // (TABLE_PARSE_HEAP_FACTOR per byte). A read that could not fit is not attempted.
  const reservation = budget.bytes * TABLE_PARSE_HEAP_FACTOR;
  if (reservation > tableParseMemoryBudget().total) return miss("unavailable", "artifact read would exceed the worker table-parse budget");
  const release = await tableParseMemoryBudget().reserve(reservation, args.signal);
  try {
    let body: string;
    try {
      body = await readArtifactBytes(args.storage, args.key, scope, budget.bytes, args.signal);
    } catch (error) {
      if (args.signal?.aborted) throw error;
      if (error instanceof TableCellsRefused) return miss(error.stale ? "stale" : "invalid", error.message);
      if (isStorageNotFound(error)) return miss("missing", "no stored table cells");
      return miss("invalid", `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let bySha: Map<string, HtmlTableCell[] | null>;
    try {
      bySha = parseArtifact(body, scope, budget);
    } catch (error) {
      return miss("invalid", error instanceof Error ? error.message : String(error));
    }
    const cached = new Map<string, HtmlTableCell[] | null>();
    for (const source of unique) {
      const sha = tableSourceSha256(source);
      if (!bySha.has(sha)) continue;
      const cells = bySha.get(sha) ?? null;
      if (!args.retention || args.retention.retain(cells)) cached.set(source, cells);
    }
    const hits = cached.size;
    return { status: hits === unique.length ? "hit" : "partial", cached, hits, misses: unique.length - hits };
  } finally {
    release();
  }
}
