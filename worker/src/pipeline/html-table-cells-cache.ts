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
import { assertHtmlTableCells, HTML_TABLE_DOCUMENT_LIMITS, vmTableSources, type PreparedHtmlTableCells } from "./html-table-vm.js";
import type { HtmlTableCell } from "./table-cells-guest.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { vmOnlyParsing } from "../lib/vm-only-parsing.js";
import { registeredParserSandbox, type InitializedParserSandbox } from "../sandbox/startup.js";
import type { ArtifactStore } from "../tools/storage.js";

export const TABLE_CELLS_ARTIFACT_SCHEMA = "docslurp.html-table-cells.v2";
/** Absolute ceiling on a stored artifact; the per-document cap (tableCellsByteCap) is usually far lower. */
export const TABLE_CELLS_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROW_LABEL = /^row ([1-9][0-9]{0,3}) column ([1-9][0-9]{0,3}) rowspan ([1-9][0-9]{0,3}) colspan ([1-9][0-9]{0,3})$/;

export type TableCellsStorage = Pick<ArtifactStore, "putBytes" | "openStream">;

/**
 * DOCSLURP_TABLE_CELLS_CACHE: `on` stores table cells before embed and lets embed reuse them; anything else (the
 * default, owner 2026-11-17: on after a production comparison) keeps the old path, where embed parses every table in a
 * VM of its own. Only meaningful where parsing is VM-only.
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

/**
 * The byte cap for a document's artifact: about twice its VM table sources (the compact encoding stores each cell's
 * text plus four small integers, so real tables come in well under), never above TABLE_CELLS_ARTIFACT_MAX_BYTES. The
 * writer does not store above it and the reader never reads past it.
 */
export function tableCellsByteCap(sources: string[]): number {
  const sourceBytes = vmTableSources(sources).reduce((total, source) => total + Buffer.byteLength(source, "utf8"), 0);
  return Math.min(TABLE_CELLS_ARTIFACT_MAX_BYTES, 2 * sourceBytes + 64 * 1024);
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

function artifactPrefix(scope: { runId: string; documentId: string; guestVersion: string }): string {
  return `${JSON.stringify({ schema: TABLE_CELLS_ARTIFACT_SCHEMA, runId: scope.runId, documentId: scope.documentId, guestVersion: scope.guestVersion }).slice(0, -1)},"tables":[`;
}

/**
 * Store the VM's cells for a document's tables, serialized once and uploaded as those bytes. Returns how much was
 * stored, or why nothing was (over the document's byte cap or table limit: embed then parses those tables in a VM).
 *
 * Last writer wins: two writers for one document (a retried stage beside its first attempt) each put a complete,
 * self-consistent artifact; whichever lands last is read. Losing the other writer's entries only turns them into misses,
 * which embed parses in a VM, so no conditional put is needed.
 */
export async function writeTableCellsArtifact(args: {
  storage: TableCellsStorage;
  key: string;
  runId: string;
  documentId: string;
  guestVersion: string;
  prepared: PreparedHtmlTableCells;
  byteCap: number;
}): Promise<{ status: "written" | "too-large"; tables: number; bytes: number }> {
  const tables = [...args.prepared];
  if (tables.length > HTML_TABLE_DOCUMENT_LIMITS.tables) return { status: "too-large", tables: tables.length, bytes: 0 };
  const body = artifactPrefix(args) + tables.map(([source, cells]) => JSON.stringify([tableSourceSha256(source), encodeCells(cells)])).join(",") + "]}";
  const bytes = Buffer.from(body, "utf8");
  if (bytes.length > args.byteCap) return { status: "too-large", tables: tables.length, bytes: bytes.length };
  await args.storage.putBytes(args.key, bytes, "application/json");
  return { status: "written", tables: tables.length, bytes: bytes.length };
}

export type TableCellsLookup =
  | { status: "hit" | "partial" | "unused"; cached: Map<string, HtmlTableCell[] | null>; hits: number; misses: number }
  | { status: "missing" | "invalid" | "unavailable"; cached: Map<string, HtmlTableCell[] | null>; hits: 0; misses: number; reason: string };

class TableCellsTooLarge extends Error {}

function isStorageNotFound(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const meta = (current as { $metadata?: { httpStatusCode?: number } }).$metadata;
    const name = (current as { name?: unknown }).name;
    if (meta?.httpStatusCode === 404 || name === "NoSuchKey" || name === "NotFound") return true;
  }
  return false;
}

/** Read at most `cap` bytes, whether or not the store reports a length: stop the transfer at the first byte past it. */
async function readBounded(storage: TableCellsStorage, key: string, cap: number, signal?: AbortSignal): Promise<Buffer> {
  const { stream, size } = await storage.openStream(key, signal);
  const destroy = () => (stream as { destroy?: () => void }).destroy?.();
  if (size !== null && size > cap) { destroy(); throw new TableCellsTooLarge(); }
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of stream) {
    received += chunk.length;
    if (received > cap) { destroy(); throw new TableCellsTooLarge(); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}

/**
 * Strict reader. Before anything is parsed, the bytes must start with this run's, document's and guest's exact header
 * and end the tables list, so a foreign or stale artifact is refused without building its tree. Then: entries are
 * `[sha256, cells]` pairs with lowercase hex hashes, unique, at most 1,024; cells decode to flat records that pass the
 * VM-output check; and the artifact as a whole stays within the document's cell and text budgets.
 */
function parseArtifact(body: string, expected: { runId: string; documentId: string; guestVersion: string }): Map<string, HtmlTableCell[] | null> {
  if (!body.startsWith(artifactPrefix(expected))) throw new Error("artifact header mismatch (schema, run, document or guest)");
  if (!body.endsWith("]}")) throw new Error("artifact truncated");
  const raw = JSON.parse(body) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("not an object");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).join(",") !== "schema,runId,documentId,guestVersion,tables") throw new Error("unexpected fields");
  if (value.schema !== TABLE_CELLS_ARTIFACT_SCHEMA || value.runId !== expected.runId || value.documentId !== expected.documentId || value.guestVersion !== expected.guestVersion) throw new Error("artifact header mismatch");
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
  storage: TableCellsStorage;
  key: string;
  runId: string;
  documentId: string;
  guestVersion: string | null;
  sources: string[];
  signal?: AbortSignal;
}): Promise<TableCellsLookup> {
  const unique = vmTableSources(args.sources);
  const miss = (status: "missing" | "invalid" | "unavailable", reason: string): TableCellsLookup => ({ status, cached: new Map(), hits: 0, misses: unique.length, reason });
  if (unique.length === 0) return { status: "unused", cached: new Map(), hits: 0, misses: 0 };
  if (!args.guestVersion) return miss("unavailable", "guest parser version unknown");
  let body: Buffer;
  try {
    body = await readBounded(args.storage, args.key, tableCellsByteCap(args.sources), args.signal);
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (error instanceof TableCellsTooLarge) return miss("invalid", "artifact exceeds size limit");
    if (isStorageNotFound(error)) return miss("missing", "no stored table cells");
    return miss("invalid", `artifact unreadable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
  }
  let bySha: Map<string, HtmlTableCell[] | null>;
  try {
    bySha = parseArtifact(body.toString("utf8"), { runId: args.runId, documentId: args.documentId, guestVersion: args.guestVersion });
  } catch (error) {
    return miss("invalid", (error instanceof Error ? error.message : String(error)).slice(0, 200));
  }
  const cached = new Map<string, HtmlTableCell[] | null>();
  for (const source of unique) {
    const sha = tableSourceSha256(source);
    if (bySha.has(sha)) cached.set(source, bySha.get(sha) ?? null);
  }
  const hits = cached.size;
  return { status: hits === unique.length ? "hit" : "partial", cached, hits, misses: unique.length - hits };
}
