import { createReadStream } from "node:fs";

import { sniffFileBytes, TEXT_PAGE_CHARS, TEXT_PAGE_LINES, type FileEncoding, type NormalizedFormat } from "@docslurp/shared";

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
 * state machine; the same class of work as the hash): the size; the counts of 0x0A, NUL, bytes at or above 0x80, printable
 * ASCII other than space (0x21-0x7E) and `<`; the first and last byte that is not ASCII white space (0x09-0x0D, 0x20); and
 * the byte-order mark the first two or three bytes name. A file with no NUL and no byte at or above 0x80 is pure ASCII,
 * whose plain-text pages the host computes itself (hostTextPages); everything else bounds the guest's count
 * (textPagesBounds).
 */
export interface HostTextEvidence {
  bytes: number;
  newlines: number;
  printableAscii: number;
  nul: number;
  high: number;
  lt: number;
  /** Offset of the first and last byte that is not ASCII white space; -1 when there is none. */
  firstContent: number;
  lastContent: number;
  bom: FileEncoding | null;
}

export class TextEvidenceCounter {
  private bytes = 0;
  private newlines = 0;
  private printableAscii = 0;
  private nul = 0;
  private high = 0;
  private lt = 0;
  private firstContent = -1;
  private lastContent = -1;
  private readonly head = new Uint8Array(3);

  update(data: Uint8Array): void {
    const base = this.bytes;
    for (let index = 0; index < data.length && base + index < 3; index++) this.head[base + index] = data[index]!;
    // One pass of fixed comparisons per byte (measured in the PR: see core TODO.md), nothing decoded.
    let newlines = 0, printable = 0, nul = 0, high = 0, lt = 0, last = -1, first = -1;
    for (let index = 0; index < data.length; index++) {
      const byte = data[index]!;
      if (byte > 0x20 && byte < 0x7f) {
        printable++;
        if (byte === 0x3c) lt++;
      } else if (byte === 0x0a) {
        newlines++;
        continue;
      } else if (byte >= 0x80) high++;
      else if (byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)) continue;
      else if (byte === 0) nul++;
      last = index;
      if (first < 0) first = index;
    }
    this.bytes += data.length;
    this.newlines += newlines;
    this.printableAscii += printable;
    this.nul += nul;
    this.high += high;
    this.lt += lt;
    if (last >= 0) {
      this.lastContent = base + last;
      if (this.firstContent < 0) this.firstContent = base + first;
    }
  }

  result(): HostTextEvidence {
    const head = this.head.subarray(0, Math.min(3, this.bytes));
    const bom: FileEncoding | null = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? "utf-8-bom"
      : head[0] === 0xff && head[1] === 0xfe ? "utf-16le" : head[0] === 0xfe && head[1] === 0xff ? "utf-16be" : null;
    return { bytes: this.bytes, newlines: this.newlines, printableAscii: this.printableAscii, nul: this.nul, high: this.high, lt: this.lt,
      firstContent: this.firstContent, lastContent: this.lastContent, bom };
  }
}

/** HostTextEvidence of a staged file, read as a stream (constant memory). */
export async function hostTextEvidenceOfFile(file: string): Promise<HostTextEvidence> {
  const counter = new TextEvidenceCounter();
  for await (const chunk of createReadStream(file)) counter.update(chunk as Buffer);
  return counter.result();
}

/**
 * Whether the host counts a file's text byte facts while it hashes it: when its provisional format uses the text rule, or
 * when no binary magic number (fixed comparisons at the start, shared sniffFileBytes at header depth) claims its header.
 * A PDF, Office, image or media upload is not scanned for them.
 */
export function textEvidenceWanted(header: Uint8Array, filename: string, format: NormalizedFormat): boolean {
  if (TEXT_RULE_FORMATS.has(format)) return true;
  const sniffed = sniffFileBytes(header, filename, { depth: "header" });
  return sniffed.mimeType === null || sniffed.encoding !== null;
}

/** No NUL and no byte at or above 0x80: every decoder reads it as the same ASCII text. */
export function isPureAscii(evidence: HostTextEvidence): boolean {
  return evidence.nul === 0 && evidence.high === 0;
}

/** Formats counted by the plain rule (no markup removed): every text-rule format but HTML. */
function plainRuleFormat(format: NormalizedFormat): boolean {
  return TEXT_RULE_FORMATS.has(format) && format !== "html";
}

/** Whether the host counts this document's pages itself, without the guest: pure-ASCII text of a plain-rule format. */
export function hostCountsTextPages(evidence: HostTextEvidence | null | undefined, format: NormalizedFormat): boolean {
  return !!evidence && plainRuleFormat(format) && isPureAscii(evidence);
}

/**
 * The plain text rule (shared measuredTextPages) from the host's counters, exact for pure ASCII: lines are the 0x0A bytes
 * plus one, and characters the bytes between the first and last that are not white space (what `trim` keeps).
 */
export function hostTextPages(evidence: HostTextEvidence): number {
  if (!isPureAscii(evidence)) throw new TextPageCountRefusedError("the host counts only pure-ASCII text");
  const chars = evidence.firstContent < 0 ? 0 : evidence.lastContent - evidence.firstContent + 1;
  return Math.max(1, Math.ceil((evidence.newlines + 1) / TEXT_PAGE_LINES), Math.ceil(chars / TEXT_PAGE_CHARS));
}

/**
 * How the guest may have decoded these bytes, from the host's own facts and the encoding the guest's sniff claims. A claim
 * the bytes contradict is refused: a byte-order mark names the encoding, UTF-8's mark is never claimed without it, and
 * UTF-16 without a mark needs NUL bytes (the sniff recognises it by them). `utf-16`: a 0x0A byte need not be a line feed
 * and two bytes make one code unit; `ascii-compatible`: every 0x0A is a line feed and every byte at most one character.
 */
export function hostEncodingClass(evidence: HostTextEvidence, claimed: FileEncoding | null): "utf-16" | "ascii-compatible" {
  const wide = (encoding: FileEncoding | null) => encoding === "utf-16le" || encoding === "utf-16be";
  if (evidence.bom === "utf-16le" || evidence.bom === "utf-16be") {
    if (claimed !== null && claimed !== evidence.bom) throw new TextPageCountRefusedError("text page count result contradicts the byte-order mark");
    return "utf-16";
  }
  if (evidence.bom === "utf-8-bom") {
    if (claimed !== null && claimed !== "utf-8-bom") throw new TextPageCountRefusedError("text page count result contradicts the byte-order mark");
    return "ascii-compatible";
  }
  if (claimed === "utf-8-bom") throw new TextPageCountRefusedError("text page count result claims a byte-order mark the file does not have");
  if (wide(claimed) && evidence.nul === 0) throw new TextPageCountRefusedError("text page count result claims UTF-16 for bytes without NUL");
  // No claim (a forced count of bytes the sniff did not call text): the guest's detection may still read NUL-bearing bytes as UTF-16.
  return wide(claimed) || (claimed === null && evidence.nul > 0) ? "utf-16" : "ascii-compatible";
}

/**
 * The fewest and most pages the text rule can give bytes with this evidence, decoded as `encoding` claims (refused when the
 * bytes contradict it: hostEncodingClass). Characters (East Asian weighted three) are at most the bytes between the first
 * and last non-space byte for an ASCII-compatible decoding, and at most 1.5 per byte less one per NUL for UTF-16 (a code
 * unit holding a NUL byte is never East Asian); at least the printable ASCII bytes, or half of them for UTF-16. Lines are
 * exactly the 0x0A bytes plus one for an ASCII-compatible decoding, and at most the 0x0A bytes that can be line feeds (no
 * more than the NUL bytes) plus one for UTF-16. With markup every tag may break a line (at most one per `<`), and scripts
 * and styles may hide everything, so the lower bound is one page. core TODO.md tabulates the worst-case ratios.
 */
export function textPagesBounds(evidence: HostTextEvidence, options: { encoding: FileEncoding | null; markup: boolean }): { min: number; max: number } {
  const wide = hostEncodingClass(evidence, options.encoding) === "utf-16";
  const span = evidence.firstContent < 0 ? 0 : evidence.lastContent - evidence.firstContent + 1;
  const maxChars = wide ? Math.max(evidence.bytes / 2, evidence.bytes * 1.5 - evidence.nul) : span;
  const feeds = wide ? Math.min(evidence.newlines, evidence.nul) : evidence.newlines;
  const maxLines = feeds + 1 + (options.markup ? evidence.lt : 0);
  const max = Math.max(1, Math.ceil(maxLines / TEXT_PAGE_LINES), Math.ceil(maxChars / TEXT_PAGE_CHARS));
  if (options.markup) return { min: 1, max };
  const minChars = wide ? evidence.printableAscii / 2 : evidence.printableAscii;
  const minLines = wide ? 1 : evidence.newlines + 1;
  const min = Math.max(1, Math.ceil(minLines / TEXT_PAGE_LINES), Math.ceil(minChars / TEXT_PAGE_CHARS));
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
    // One fixed token an alert keys on: a worker running against a parser image without the text answer.
    console.error(`[parser-sandbox] status=refused reason=capability-missing capability=${INSPECTION_TEXT_PAGES_CAPABILITY} stage=text-pages`);
    throw new TextPageCountUnavailableError(`text page count unavailable: the parser image's inspection has no text answer (capability ${INSPECTION_TEXT_PAGES_CAPABILITY}); no host decoder runs`);
  }
  if (text === null) return null;
  return format === "html" ? text.markupPages ?? null : text.pages;
}

/**
 * Record a measured text page count as the document's `counted` count. From quarantine the count is only persisted: the
 * spend decision is format-detect's, which authorizes every document on every attempt, so an unfunded run pauses where a
 * retry is nearly free instead of repeating quarantine's download, VM inspection and malware scan for every text file.
 * From format-detect the page basis authorizes it at once (and format-detect again after).
 */
export async function recordTextPages(state: WorkflowState, document: Document, pages: number, bytes: number, via: "quarantine" | "format-detect"): Promise<{ pages: number; estimate: number }> {
  const estimate = Math.max(1, Math.trunc(document.pageCount) || 1);
  console.log(`[text-pages] document=${document.id} measured=${pages} estimate=${estimate} bytes=${bytes} via=${via}`);
  await state.pageBasis.record(document, { kind: "page-count", pages }, { deferAuthorization: via === "quarantine" });
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
