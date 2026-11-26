import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { TEXT_PAGE_LINES, type FileEncoding, type NormalizedFormat } from "@docslurp/shared";

import type { Document } from "../models.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { GUEST_NODE_FLAGS } from "../sandbox/guest-node-flags.js";
import { sha256Bytes, verifyStagedSource } from "../sandbox/source-integrity.js";
import { parserImageCapability } from "../sandbox/startup.js";
import type { CommandRunner } from "../tools/runner.js";
import { resolveScriptsDir } from "../tools/scripts-dir.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";
import { measureTextPagesBytes, TEXT_MEASURE_MAX_BYTES, TEXT_PAGE_ENCODINGS, type TextPagesOptions } from "./text-pages-guest.js";
import { vmOnlyParsing } from "./vm-only-parsing.js";

export { TEXT_MEASURE_MAX_BYTES } from "./text-pages-guest.js";

/** Text formats whose pages are the text rule's (shared measuredTextPages); Office, RTF and EPUB are measured from their extractor. */
const TEXT_RULE_FORMATS: ReadonlySet<NormalizedFormat> = new Set<NormalizedFormat>(["plain-text", "markdown", "html", "structured-csv", "structured-json", "latex"]);

/** The parser image capability that ships `scripts/text-pages.mjs` (parser-vm-contract.mjs). */
export const TEXT_PAGES_CAPABILITY = "text-pages";

/** The guest's answer is two small integers. */
const MAX_RESULT_BYTES = 1024;

/** A text page count could not be taken in the boundary. The document fails (never billed on an estimate). */
export class TextPageCountRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TextPageCountRefusedError";
  }
}

/**
 * The most pages `bytes` bytes of text can measure: a line needs at least one byte (its newline), and pages by characters are
 * far fewer (at most 1.5 weighted characters per byte, UTF-16 East Asian text, against 3,500 per page). A guest answer above it
 * is not a count of this file.
 */
export function maxTextPagesForBytes(bytes: number): number {
  return Math.max(1, Math.ceil((bytes + 1) / TEXT_PAGE_LINES));
}

/** The guest's `{ pages, bytes }` for a staged file of `stagedBytes`, or a refusal. */
export function validateTextPagesResult(raw: unknown, stagedBytes: number): { pages: number; bytes: number } {
  const value = raw as { pages?: unknown; bytes?: unknown } | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "pages" && key !== "bytes")) {
    throw new TextPageCountRefusedError("invalid text page count result");
  }
  if (value.bytes !== stagedBytes) throw new TextPageCountRefusedError("text page count result does not describe the staged source");
  const pages = value.pages;
  if (typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 1 || pages > maxTextPagesForBytes(stagedBytes)) {
    throw new TextPageCountRefusedError("text page count result out of range");
  }
  return { pages, bytes: stagedBytes };
}

function guestOptions(document: Document, format: NormalizedFormat): TextPagesOptions {
  const encoding = document.fileFacts?.encoding ?? null;
  return { encoding: encoding && TEXT_PAGE_ENCODINGS.has(encoding as FileEncoding) ? (encoding as FileEncoding) : null, markup: format === "html" };
}

/** The text rule over the staged source in the parser VM (`scripts/text-pages.mjs`). The host reads only the guest's JSON. */
async function measureInVm(args: {
  document: Document;
  format: NormalizedFormat;
  runner: Pick<CommandRunner, "run">;
  sourcePath: string;
  signal?: AbortSignal;
}): Promise<{ pages: number; bytes: number }> {
  const capability = parserImageCapability(TEXT_PAGES_CAPABILITY);
  if (capability !== "present") {
    throw new TextPageCountRefusedError(`text page count requires the parser VM's ${TEXT_PAGES_CAPABILITY} guest (${capability}); no host decoder runs`);
  }
  const { size } = await stat(args.sourcePath);
  if (size > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-text-pages-"));
  try {
    const config = path.join(dir, "options.json"), output = path.join(dir, "result.json");
    await writeFile(config, JSON.stringify(guestOptions(args.document, args.format)), { mode: 0o600 });
    await args.runner.run({
      binary: "node",
      args: [...GUEST_NODE_FLAGS, path.join(resolveScriptsDir(), "text-pages.mjs"), args.sourcePath, config, output],
      available: true,
      readOnlyInputs: true,
      timeoutMs: 120_000,
    }, args.signal);
    if ((await stat(output)).size > MAX_RESULT_BYTES) throw new TextPageCountRefusedError("text page count result exceeds limit");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(output, "utf8"));
    } catch {
      throw new TextPageCountRefusedError("invalid text page count result");
    }
    return validateTextPagesResult(parsed, size);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A text file whose intake count is not `counted` (intake estimates every text file from its size and never decodes it):
 * count its pages with the text rule over the whole decoded text, and record that as the document's `counted` page count
 * before any stage uses it or anything bills. The page basis authorizes pages above intake's (pipeline/page-basis.ts).
 * Billing reads only this count: a document still `assumed` with no measured pages never bills (db/page-base-fee.ts).
 *
 * Where the bytes are decoded: under the VM-only floor (every non-development environment) only in the parser VM, on the
 * hash-verified staged source (`stageSource`); a missing runner, staged source or guest capability is a logged refusal that
 * fails the document, never a host decode. In development the shared decoder runs in-process (`readSource`).
 */
export async function recordMeasuredTextPageCount(args: {
  state: WorkflowState;
  document: Document;
  format: NormalizedFormat;
  readSource: (maxBytes: number) => Promise<Uint8Array>;
  /** The hash-verified staged source on disk (sandbox/source-integrity.ts stageSourceFile); the caller removes it. */
  stageSource?: () => Promise<string>;
  runner?: Pick<CommandRunner, "run">;
  signal?: AbortSignal;
  vmOnly?: boolean;
}): Promise<{ pages: number; estimate: number } | null> {
  const { state, document, format } = args;
  if (!TEXT_RULE_FORMATS.has(format) || document.pageCountSource !== "assumed") return null;
  const estimate = Math.max(1, Math.trunc(document.pageCount) || 1);
  let measured: { pages: number; bytes: number };
  if (args.vmOnly ?? vmOnlyParsing()) {
    if (!args.runner || !args.stageSource) {
      console.error(`[text-pages] refused document=${document.id}: no parser VM runner; a text source is never decoded on this host`);
      throw new TextPageCountRefusedError("text page count unavailable: the parser VM is not configured, so no host decoder runs");
    }
    try {
      measured = await measureInVm({ document, format, runner: args.runner, sourcePath: await args.stageSource(), signal: args.signal });
    } catch (error) {
      if (error instanceof StorageObjectTooLargeError) {
        console.error(`[text-pages] refused document=${document.id}: over ${TEXT_MEASURE_MAX_BYTES} bytes, too large to measure; not billed on an estimate`);
        throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
      }
      if (error instanceof TextPageCountRefusedError) console.error(`[text-pages] refused document=${document.id}: ${error.message}`);
      throw error;
    }
  } else {
    let bytes: Uint8Array;
    try {
      bytes = await args.readSource(TEXT_MEASURE_MAX_BYTES);
    } catch (error) {
      if (error instanceof StorageObjectTooLargeError) {
        console.error(`[text-pages] refused document=${document.id}: over ${TEXT_MEASURE_MAX_BYTES} bytes, too large to measure; not billed on an estimate`);
        throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
      }
      throw error;
    }
    if (bytes.length > TEXT_MEASURE_MAX_BYTES) throw new Error(`text file too large to measure (over ${TEXT_MEASURE_MAX_BYTES} bytes)`);
    verifyStagedSource(document, sha256Bytes(bytes));
    measured = measureTextPagesBytes(bytes, guestOptions(document, format));
  }
  const { pages } = measured;
  console.log(`[text-pages] document=${document.id} measured=${pages} estimate=${estimate} bytes=${measured.bytes}`);
  // The page basis records the count (and authorizes a raise); format-detect authorizes it again on every attempt.
  await state.pageBasis.record(document, { kind: "page-count", pages });
  return { pages, estimate };
}
