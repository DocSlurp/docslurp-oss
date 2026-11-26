import { createReadStream } from "node:fs";

import { TEXT_PAGE_CHARS, TEXT_PAGE_LINES, type FileEncoding, type NormalizedFormat } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";
import { TEXT_MEASURE_MAX_BYTES, type TextPagesInspection, type TextPagesRequest } from "./text-pages-guest.js";

export { TEXT_MEASURE_MAX_BYTES } from "./text-pages-guest.js";

/** Text formats whose pages are the text rule's (shared measuredTextPages); Office, RTF and EPUB are measured from their extractor. */
export const TEXT_RULE_FORMATS: ReadonlySet<NormalizedFormat> = new Set<NormalizedFormat>(["plain-text", "markdown", "html", "structured-csv", "structured-json", "latex"]);

/**
 * The parser image capability whose quarantine inspection returns the text answer (scripts/quarantine-inspect.mjs `text`,
 * probed by parser-vm-contract.mjs). Required at worker startup under the VM-only floor (sandbox/startup.ts), and by the
 * app's deploy probe, so a worker never takes traffic against an image that cannot count text.
 */
export const INSPECTION_TEXT_PAGES_CAPABILITY = "inspection-text-pages";

/** A text page count the guest gave is not a count of this file. The document fails (never billed on an estimate). */
export class TextPageCountRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextPageCountRefusedError";
  }
}

/**
 * The platform cannot count text pages right now: the parser image's inspection has no text answer (an image older than
 * the worker), or no parser VM runner is configured. Never the document's fault: retried (lib/document-failure.ts), and
 * never answered by decoding on the host. Startup refuses such an image under the VM-only floor, so this is the backstop.
 */
export class TextPageCountUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextPageCountUnavailableError";
  }
}

/** Whether `document` still owes a measured text page count (intake estimated it and nothing counted it yet). */
export function needsTextPageCount(document: Pick<Document, "pageCountSource">, format: NormalizedFormat): boolean {
  return TEXT_RULE_FORMATS.has(format) && document.pageCountSource === "assumed";
}

/** What the inspection is asked for a document whose provisional format is `format`. */
export function textPagesRequestFor(document: Pick<Document, "pageCountSource">, format: NormalizedFormat): TextPagesRequest | null {
  if (document.pageCountSource !== "assumed") return null;
  // Text-rule formats are counted whatever the sniff says; any other assumed file is counted when the bytes are text, so a
  // file intake could not type (no extension, a generic declared type) still has its count once quarantine types it.
  return { markup: format === "html", force: TEXT_RULE_FORMATS.has(format) };
}

/**
 * Facts the host takes from the bytes by fixed per-byte comparisons while it streams them for their hash (no decoder, no
 * state machine; the same class of work as the hash): the size, the number of 0x0A bytes, and the number of printable
 * ASCII bytes other than space (0x21-0x7E). They bound the guest's count from both sides (textPagesBounds).
 */
export interface HostTextEvidence {
  bytes: number;
  newlines: number;
  printableAscii: number;
}

export class TextEvidenceCounter {
  private bytes = 0;
  private newlines = 0;
  private printableAscii = 0;

  update(data: Uint8Array): void {
    this.bytes += data.length;
    // One pass, two comparisons per byte: about 2 ms of CPU per MiB whatever the content (an indexOf loop costs 35 ms per
    // MiB on a file of newlines).
    let newlines = 0, printable = 0;
    for (let index = 0; index < data.length; index++) {
      const byte = data[index]!;
      if (byte === 0x0a) newlines++;
      else if (byte > 0x20 && byte < 0x7f) printable++;
    }
    this.newlines += newlines;
    this.printableAscii += printable;
  }

  result(): HostTextEvidence {
    return { bytes: this.bytes, newlines: this.newlines, printableAscii: this.printableAscii };
  }
}

/** HostTextEvidence of a staged file, read as a stream (constant memory). */
export async function hostTextEvidenceOfFile(file: string): Promise<HostTextEvidence> {
  const counter = new TextEvidenceCounter();
  for await (const chunk of createReadStream(file)) counter.update(chunk as Buffer);
  return counter.result();
}

/** Encodings in which every 0x0A byte is a line feed and every printable ASCII byte one character (8-bit and UTF-8 forms). */
const ASCII_COMPATIBLE: ReadonlySet<FileEncoding> = new Set<FileEncoding>(["utf-8", "utf-8-bom", "8-bit"]);

/**
 * The fewest and most pages the text rule can give bytes with this evidence. Upper, any encoding: lines are at most the
 * 0x0A bytes plus one (a UTF-16 line feed holds one), and weighted characters at most 1.5 per byte (UTF-16 East Asian
 * text: two bytes, weight three); with markup every tag may also break a line, a tag being at least three bytes. Lower,
 * only when the sniffed encoding is ASCII-compatible and without markup: the lines are exactly the 0x0A bytes plus one, and
 * every printable ASCII byte is a character trimming keeps. Otherwise the lower bound is one page (see core TODO.md).
 */
export function textPagesBounds(evidence: HostTextEvidence, options: { encoding: FileEncoding | null; markup: boolean }): { min: number; max: number } {
  const lineCap = options.markup ? Math.min(evidence.bytes, evidence.newlines + 1 + Math.floor(evidence.bytes / 3)) : evidence.newlines + 1;
  const max = Math.max(1, Math.ceil(lineCap / TEXT_PAGE_LINES), Math.ceil((evidence.bytes * 1.5) / TEXT_PAGE_CHARS));
  const exact = !options.markup && options.encoding !== null && ASCII_COMPATIBLE.has(options.encoding);
  const min = exact ? Math.max(1, Math.ceil((evidence.newlines + 1) / TEXT_PAGE_LINES), Math.ceil(evidence.printableAscii / TEXT_PAGE_CHARS)) : 1;
  return { min: Math.min(min, max), max };
}

/**
 * The guest's `text` answer (quarantine inspection result), checked against the staged file: `undefined` when the result
 * has no `text` key at all (an image older than this worker: the caller treats it as unavailable, retried), null when the
 * guest measured nothing, or the answer within textPagesBounds. Anything else is a TextPageCountRefusedError.
 */
export function validateTextPagesInspection(
  result: Record<string, unknown>,
  evidence: HostTextEvidence,
  encoding: FileEncoding | null,
): TextPagesInspection | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(result, "text")) return undefined;
  const raw = result.text as Partial<TextPagesInspection> | null;
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => key !== "pages" && key !== "bytes" && key !== "markupPages")) {
    throw new TextPageCountRefusedError("invalid text page count result");
  }
  if (raw.bytes !== evidence.bytes) throw new TextPageCountRefusedError("text page count result does not describe the staged source");
  const plain = textPagesBounds(evidence, { encoding, markup: false });
  const inRange = (pages: unknown, bounds: { min: number; max: number }) => typeof pages === "number" && Number.isSafeInteger(pages) && pages >= bounds.min && pages <= bounds.max;
  if (!inRange(raw.pages, plain)) throw new TextPageCountRefusedError("text page count result out of range");
  if (raw.markupPages !== undefined && !inRange(raw.markupPages, textPagesBounds(evidence, { encoding, markup: true }))) {
    throw new TextPageCountRefusedError("text page count result out of range");
  }
  return { bytes: raw.bytes, pages: raw.pages as number, ...(raw.markupPages !== undefined ? { markupPages: raw.markupPages } : {}) };
}

/**
 * The page count the text answer gives a document of `format`: the markup count for HTML, the plain count otherwise; null
 * when the answer does not hold it (not measured, or HTML without the markup count). `undefined` (no answer key: an older
 * image) is TextPageCountUnavailableError, retried, never a host decode.
 */
export function pagesFromTextInspection(text: TextPagesInspection | null | undefined, format: NormalizedFormat): number | null {
  if (text === undefined) {
    throw new TextPageCountUnavailableError(`text page count unavailable: the parser image's inspection has no text answer (capability ${INSPECTION_TEXT_PAGES_CAPABILITY}); no host decoder runs`);
  }
  if (text === null) return null;
  return format === "html" ? text.markupPages ?? null : text.pages;
}

/** Record a measured text page count as the document's `counted` count; the page basis authorizes pages above intake's. */
export async function recordTextPages(state: WorkflowState, document: Document, pages: number, bytes: number, via: string): Promise<{ pages: number; estimate: number }> {
  const estimate = Math.max(1, Math.trunc(document.pageCount) || 1);
  console.log(`[text-pages] document=${document.id} measured=${pages} estimate=${estimate} bytes=${bytes} via=${via}`);
  // The page basis records the count (and authorizes a raise); format-detect authorizes it again on every attempt.
  await state.pageBasis.record(document, { kind: "page-count", pages });
  return { pages, estimate };
}

const tooLarge = () => new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);

/**
 * A text file whose intake count is not `counted` and that quarantine did not count (quarantine disabled in development, a
 * checkpoint left by an older build, an HTML file quarantine had no markup count for): count its pages with the text rule
 * over the whole decoded text and record that as the document's `counted` page count before any stage uses it or anything
 * bills. Billing reads only this count: a document still `assumed` with no measured pages never bills (db/page-base-fee.ts).
 *
 * `measure` is the caller's: under the VM-only floor the same in-VM quarantine inspection, on the hash-verified staged
 * source (format-detect), never a host decode; in development the shared rule in-process.
 */
export async function recordMeasuredTextPageCount(args: {
  state: WorkflowState;
  document: Document;
  format: NormalizedFormat;
  measure: (request: TextPagesRequest) => Promise<TextPagesInspection | null | undefined>;
}): Promise<{ pages: number; estimate: number } | null> {
  const { state, document, format } = args;
  if (!needsTextPageCount(document, format)) return null;
  let text: TextPagesInspection | null | undefined;
  try {
    text = await args.measure({ markup: format === "html", force: true });
  } catch (error) {
    if (error instanceof StorageObjectTooLargeError) {
      console.error(`[text-pages] refused document=${document.id}: over ${TEXT_MEASURE_MAX_BYTES} bytes, too large to measure; not billed on an estimate`);
      throw tooLarge();
    }
    if (error instanceof TextPageCountRefusedError || error instanceof TextPageCountUnavailableError) console.error(`[text-pages] refused document=${document.id}: ${error.message}`);
    throw error;
  }
  let pages: number | null;
  try {
    pages = pagesFromTextInspection(text, format);
  } catch (error) {
    console.error(`[text-pages] refused document=${document.id}: ${(error as Error).message}`);
    throw error;
  }
  if (pages === null) {
    // Asked with `force` and the size within the limit, the guest always answers; no answer is not a count of this file.
    console.error(`[text-pages] refused document=${document.id}: the inspection measured no text pages`);
    throw new TextPageCountRefusedError("text page count result missing");
  }
  return await recordTextPages(state, document, pages, text!.bytes, "format-detect");
}
