import {
  imageAnchorsToAltText,
  runReadLoop,
  stratifiedRounds,
  type ReadBudget,
  type ReadPorts,
  type ReadSource,
  type ReadStoppedBy,
  type ReadTask,
  type Slice,
  type SliceRef,
} from "@docslurp/shared";

import { estimateTokens } from "../lib/unicode-text.js";
import { pageByteRange, pageOffsetsKey, PAGE_OFFSETS_MAX_BYTES, parsePageOffsets, type PageOffsetIndex } from "../lib/page-offsets.js";
import { stripSummaryControlCharacters } from "../summary-tree/summary.js";
import { buildTrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";

// The deployment flag (`DOCSLURP_SUMMARY_SCAN`) and its parser live beside the summary tree switches in
// `@docslurp/shared` (`summaryScanAvailable`); the stage reads it from the process environment.

export const DOC_TYPES = [
  "contract", "financial-report", "invoice", "manual", "research-paper", "legal-filing",
  "correspondence", "presentation", "form", "book", "dataset", "mixed", "other",
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface ScanState { docType: DocType; topics: string[]; summary: string }

export const SCAN_MAX_TOPICS = 6;
export const SCAN_TOPIC_MAX_CHARS = 40;
export const SCAN_SUMMARY_MAX_CHARS = 2_000;
export const SCAN_FILENAME_MAX_CHARS = 200;
export const SCAN_MAX_MODEL_CALLS = 6;
export const SCAN_PAGES_PER_STEP = 10;
export const SCAN_STABLE_OVERLAP = 0.8;
export const SCAN_LARGE_DOCUMENT_PAGES = 200;
/** Output budget of the first attempt of a step (labels, summary paragraph and proposals); a cut-off reply is retried at double. */
export const SCAN_OUTPUT_TOKENS = 640;
const WALL_RESERVE_MS = 15_000;
const MAX_PAGE_READ_BYTES = 8_000;
const MAX_RUN_READ_BYTES = 96_000;
const ALLOWED_ACTIONS = ["read-exact", "read-relative", "stop"] as const;

// --- The stability rule ------------------------------------------------------------------------------------------

function foldTopic(topic: string): string {
  return topic.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

/** Overlap of two topic lists as sets of case-folded, whitespace-normalised strings. Two empty sets are equal. */
export function topicOverlap(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a.map(foldTopic).filter(Boolean));
  const right = new Set(b.map(foldTopic).filter(Boolean));
  if (left.size === 0 && right.size === 0) return 1;
  let shared = 0;
  for (const topic of left) if (right.has(topic)) shared++;
  return shared / (left.size + right.size - shared);
}

/** The loop condition: same document type and topic overlap of at least 0.8 across two consecutive states. */
export function labelsStable(previous: ScanState, next: ScanState): boolean {
  return previous.docType === next.docType && topicOverlap(previous.topics, next.topics) >= SCAN_STABLE_OVERLAP;
}

// --- The reply ----------------------------------------------------------------------------------------------------

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("").trim() : text;
}

/** Strict parse of one model reply. Invalid JSON, a non-object, an out-of-enum type or an empty summary throws. */
export function parseScanReply(text: string): { state: ScanState; next: unknown } {
  const body = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/u, "$1").trim();
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("summary scan reply is not an object");
  const reply = value as Record<string, unknown>;
  const docType = reply.docType;
  if (typeof docType !== "string" || !(DOC_TYPES as readonly string[]).includes(docType)) throw new Error("summary scan reply has an unknown docType");
  if (!Array.isArray(reply.topics)) throw new Error("summary scan reply has no topics list");
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const raw of reply.topics) {
    if (typeof raw !== "string") continue;
    const topic = clipChars(stripSummaryControlCharacters(raw).replace(/\s+/gu, " ").trim(), SCAN_TOPIC_MAX_CHARS);
    const key = foldTopic(topic);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length >= SCAN_MAX_TOPICS) break;
  }
  if (typeof reply.summary !== "string") throw new Error("summary scan reply has no summary");
  const summary = clipChars(stripSummaryControlCharacters(reply.summary).trim(), SCAN_SUMMARY_MAX_CHARS);
  if (!summary) throw new Error("summary scan reply has an empty summary");
  return { state: { docType: docType as DocType, topics, summary }, next: reply.next };
}

// --- The prompt ---------------------------------------------------------------------------------------------------

const INSTRUCTION = "Label this document and summarize it for a search index. You are reading it in rounds: each round shows a few more pages, and you return the whole updated result.";

function outputContract(): string {
  return [
    "Return only one JSON object, with no markdown fence and no commentary:",
    `{"docType": one of ${DOC_TYPES.map((type) => `"${type}"`).join(", ")}, "topics": at most ${SCAN_MAX_TOPICS} short strings (each at most ${SCAN_TOPIC_MAX_CHARS} characters), "summary": a one-paragraph summary that is concise and captures the main topics, entities and purpose, "next": optional list of what to read next}.`,
    "The input contains representative excerpts, not the full document. Do not claim exhaustive coverage or infer details from omitted sections. Revise docType, topics and summary from everything seen so far, and keep them unchanged when the new pages add nothing.",
    `"next" holds at most a few of these actions, and nothing else is allowed: {"do":"read","unit":"page","at":N} or {"do":"read","unit":"page","at":N,"to":M} to read page N (or N to M); {"do":"read","unit":"page","relative":"next"|"prev"|"around","span":N} to read N pages after, before or around the pages shown now; {"do":"stop","reason":"answered"} when more pages would not change the labels. Reading is limited and a proposal may be refused.`,
  ].join("\n");
}

export interface ScanPromptInput {
  fileName: string;
  /** The carried state, or null in round 1. */
  state: ScanState | null;
  /** Round 1: the evidence text as it is today. Later rounds: one entry per page. */
  evidenceText?: string;
  pages?: Array<{ page: number; text: string }>;
  pagesRead: number;
  pagesTotal: number;
}

/**
 * Trusted: instruction, output contract, progress. Untrusted: the file name hint, the carried state (written by a model
 * that read document text) and every page's text. The block is delimited by a per-call tag.
 */
export function buildScanPrompt(input: ScanPromptInput) {
  const name = clipChars(stripSummaryControlCharacters(input.fileName).replace(/\s+/gu, " ").trim(), SCAN_FILENAME_MAX_CHARS);
  const parts = [
    `File name hint: ${name || "(none)"}`,
    `Labels and summary from the previous round: ${input.state ? JSON.stringify(input.state) : "none yet (this is the first round)"}`,
    input.evidenceText ?? (input.pages ?? []).map((page) => `[Page ${page.page}]\n${page.text}`).join("\n\n"),
  ];
  return buildTrustedDocumentTaskPrompt({
    delimiter: "per-call",
    instruction: INSTRUCTION,
    outputContract: outputContract(),
    trustedContext: [{ label: "Progress", value: `Pages read so far: ${input.pagesRead} of ${input.pagesTotal}` }],
    untrustedContent: parts.join("\n\n"),
    untrustedContentLabel: "document text",
  });
}

// --- The slice port -----------------------------------------------------------------------------------------------

type ScanStorage = Pick<ArtifactStore, "bucket" | "objectSize" | "getByteRange">;

export interface ScanSource {
  index: PageOffsetIndex;
  pagesTotal: number;
  read(refs: SliceRef[], signal: AbortSignal): Promise<Slice[]>;
}

function decodeRange(bytes: Buffer): string {
  // A capped range can end inside a UTF-8 code point: drop only the damaged edge.
  return bytes.toString("utf8").replace(/^�+|�+$/g, "");
}

/**
 * Opens the page reader for one document, or returns null when the scan must not be used: no index, an index that does
 * not describe the current Markdown (different URI or byte length), an oversized index, or any read failure.
 */
export async function openScanSource(args: {
  storage: ScanStorage;
  documentId: string;
  evidenceUri: string;
  markdownUri: string;
  pagesTotal: number;
  signal?: AbortSignal;
}): Promise<ScanSource | null> {
  try {
    const { storage, signal } = args;
    const evidenceKey = keyFromStorageUri(args.evidenceUri, storage.bucket);
    const markdownKey = args.markdownUri.endsWith(".json") ? null : keyFromStorageUri(args.markdownUri, storage.bucket);
    if (!evidenceKey || !markdownKey) return null;
    const indexKey = pageOffsetsKey(evidenceKey);
    const indexSize = await storage.objectSize(indexKey, signal);
    if (!indexSize || indexSize > PAGE_OFFSETS_MAX_BYTES) return null;
    const markdownSize = await storage.objectSize(markdownKey, signal);
    if (!markdownSize) return null;
    const bytes = await storage.getByteRange(indexKey, 0, indexSize - 1, signal);
    const index = parsePageOffsets(bytes, { documentId: args.documentId, sourceUri: args.markdownUri, sourceBytes: markdownSize });
    if (!index || index.pageCount !== args.pagesTotal) return null;
    const readRange = async (start: number, end: number, sig: AbortSignal): Promise<string[] | null> => {
      try {
        const buffer = await storage.getByteRange(markdownKey, start, end, sig);
        return decodeRange(buffer).split("\f");
      } catch {
        return null;
      }
    };
    return {
      index,
      pagesTotal: index.pageCount,
      async read(refs, sig) {
        const slices: Slice[] = [];
        for (const ref of refs) {
          const { start, end } = ref;
          const missing = (): void => { slices.push({ ref, status: "missing" }); };
          try {
            sig.throwIfAborted();
            const range = pageByteRange(index, start, end);
            if (!range || start < 1 || end > index.pageCount) { missing(); continue; }
            const whole = range.end - range.start + 1 <= MAX_RUN_READ_BYTES;
            if (whole) {
              const pages = await readRange(range.start, range.end, sig);
              if (!pages || pages.length !== end - start + 1) { missing(); continue; }
              pages.forEach((text, offset) => pushPage(slices, start + offset, text));
              continue;
            }
            // A run too large for one read: each page is read on its own and clipped.
            for (let page = start; page <= end; page++) {
              const first = index.starts[page - 1]!;
              const length = Math.min(index.lengths[page - 1]!, MAX_PAGE_READ_BYTES);
              if (length <= 0) { slices.push({ ref: { unit: "page", start: page, end: page }, status: "missing" }); continue; }
              const text = await readRange(first, first + length - 1, sig);
              if (!text) slices.push({ ref: { unit: "page", start: page, end: page }, status: "missing" });
              else pushPage(slices, page, text[0] ?? "");
            }
          } catch {
            missing();
          }
        }
        return slices;
      },
    };
  } catch {
    return null;
  }
}

function pushPage(slices: Slice[], page: number, raw: string): void {
  const ref: SliceRef = { unit: "page", start: page, end: page };
  const text = imageAnchorsToAltText(raw).trim();
  slices.push(text ? { ref, status: "ok", text } : { ref, status: "missing" });
}

// --- The task and the run -----------------------------------------------------------------------------------------

/** One model attempt. The stage owns the model, key, privacy mode, reasoning floor and usage recording. */
export interface ScanModelResult { text: string; finishReason: string; inputTokens: number; outputTokens: number; costCents?: number; metadata?: Record<string, unknown> }
export type ScanModelCall = (args: { system: string; prompt: string; maxOutputTokens: number; signal: AbortSignal }) => Promise<ScanModelResult>;

export interface ScanOutcome {
  state: ScanState;
  steps: number;
  stoppedBy: ReadStoppedBy;
  pagesRead: number;
  pagesTotal: number;
  /** Pages read by later steps, beyond the evidence pages, in page order. */
  extraPages: number[];
  /** Provider cost, tokens of every attempt, for the caller's totals. */
  costCents: number;
  inputTokens: number;
  outputTokens: number;
}

/** One step: one call plus at most one retry at double the output tokens when the reply was cut off. */
async function callStep(args: { call: ScanModelCall; prompt: { system: string; prompt: string }; signal: AbortSignal;
  onAttempt: (result: ScanModelResult, attempt: number) => void }): Promise<{ reply: { state: ScanState; next: unknown }; costCents: number; inputTokens: number }> {
  let budget = SCAN_OUTPUT_TOKENS;
  let costCents = 0;
  let inputTokens = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await args.call({ ...args.prompt, maxOutputTokens: budget, signal: args.signal });
    args.onAttempt(result, attempt);
    costCents += result.costCents ?? 0;
    inputTokens += result.inputTokens;
    if (result.finishReason === "length") {
      if (attempt === 2) throw new Error("summary scan reply was cut off");
      budget *= 2;
      continue;
    }
    return { reply: parseScanReply(result.text), costCents, inputTokens };
  }
  throw new Error("unreachable");
}

export function scanBudget(args: { wallMs: number }): ReadBudget {
  return {
    maxSteps: SCAN_MAX_MODEL_CALLS,
    maxUnitsPerStep: SCAN_PAGES_PER_STEP,
    maxSliceTokens: 1_200,
    maxStepTokens: 3_000,
    maxInputTokens: 18_000,
    maxActions: 12,
    maxSearches: 0,
    maxModelDirectedShare: 0.5,
    maxWallMs: args.wallMs,
    maxCostCents: MAX_COST_CENTS,
    concurrency: 4,
  };
}

const MAX_COST_CENTS = 2;

/** The task's starting state: never a real result (its summary is empty), so the first step can never look stable. */
const EMPTY_STATE: ScanState = { docType: "other", topics: [], summary: "" };

/**
 * Run the scan as one loop. The first step is seeded with the evidence text the single-call summary reads today (as one
 * slice and every evidence page marked seen, so the plan never repeats them); later steps read ten further pages each.
 * Replies from the first step are honoured like any other. Returns null when the first step fails (the caller uses the
 * single call); a later failure keeps the latest good state.
 */
export async function runSummaryScan(args: {
  call: ScanModelCall;
  onAttempt: (result: ScanModelResult, info: { step: number; attempt: number }) => void;
  source: ScanSource;
  fileName: string;
  evidenceText: string;
  evidencePages: readonly number[];
  signal: AbortSignal;
  shouldStop?: () => boolean;
  /** Milliseconds left of the stage's summary deadline; a reserve for the embedding after it is kept back. */
  wallMs: number;
  now?: () => number;
}): Promise<ScanOutcome | null> {
  const total = args.source.pagesTotal;
  const evidence = new Set(args.evidencePages);
  const firstPage = Math.min(...args.evidencePages);
  const wallMs = args.wallMs - WALL_RESERVE_MS;
  if (!Number.isFinite(firstPage) || evidence.size === 0 || wallMs <= 0) return null;

  let cost = 0;
  let inTokens = 0;
  let outTokens = 0;
  // Pages shown so far, for the prompt's progress line: the evidence plus every page a later step started with.
  let shown = evidence.size;
  let firstStepOk = false;
  let firstStepFailed = false;
  const attempt = (step: number) => (result: ScanModelResult, n: number) => {
    cost += result.costCents ?? 0;
    inTokens += result.inputTokens;
    outTokens += result.outputTokens;
    args.onAttempt(result, { step, attempt: n });
  };

  const task: ReadTask<ScanState> = {
    id: "document-labels@1",
    init: EMPTY_STATE,
    coverage: "representative",
    allowedActions: ALLOWED_ACTIONS,
    minSteps: total > SCAN_LARGE_DOCUMENT_PAGES ? 2 : 1,
    // Stable needs two real states: the empty starting state is never one of them.
    done: (previous, next) => previous.summary !== "" && labelsStable(previous, next),
    async step({ state, slices, step, signal }) {
      let prompt: ReturnType<typeof buildScanPrompt>;
      if (step === 1) {
        // The seeded batch: the evidence text exactly as the single-call summary reads it, with no carried state.
        prompt = buildScanPrompt({ fileName: args.fileName, state: null, evidenceText: args.evidenceText, pagesRead: shown, pagesTotal: total });
      } else {
        shown += slices.length;
        const pages = slices.map((slice) => ({ page: slice.ref.start, text: slice.text }));
        prompt = buildScanPrompt({ fileName: args.fileName, state, pages, pagesRead: shown, pagesTotal: total });
      }
      try {
        const result = await callStep({ call: args.call, prompt, signal, onAttempt: attempt(step) });
        if (step === 1) firstStepOk = true;
        return { reply: result.reply, costCents: result.costCents, inputTokens: result.inputTokens };
      } catch (error) {
        if (step === 1) firstStepFailed = true;
        throw error;
      }
    },
  };
  const source: ReadSource = { unit: "page", first: 1, last: total };
  const ports: ReadPorts = {
    estimateTokens,
    read: (refs, signal) => args.source.read(refs, signal),
    // A failed first step ends the scan at once: the caller falls back to the single call instead of paying for more.
    shouldStop: () => firstStepFailed || (args.shouldStop?.() ?? false),
    signal: args.signal,
    ...(args.now ? { now: args.now } : {}),
  };
  try {
    const result = await runReadLoop({
      task,
      source,
      strategy: stratifiedRounds(SCAN_PAGES_PER_STEP),
      budget: scanBudget({ wallMs }),
      ports,
      seed: {
        seen: [...evidence],
        // One slice holds the whole evidence text. Its ref is the first evidence page so relative proposals anchor there.
        batch: [{ ref: { unit: "page", start: firstPage, end: firstPage }, status: "ok", text: args.evidenceText }],
      },
    });
    if (!firstStepOk) return null;
    // The engine counts the seeded batch as one page read. It is an evidence page, so drop that one unit and add the
    // evidence pages themselves; what remains is the pages later steps read.
    const extraPages: number[] = [];
    for (const [from, to] of result.coverage.ranges) for (let page = from; page <= to; page++) if (!evidence.has(page)) extraPages.push(page);
    return {
      state: result.state, steps: result.usage.steps, stoppedBy: result.stoppedBy,
      pagesRead: evidence.size + extraPages.length, pagesTotal: total, extraPages,
      costCents: cost, inputTokens: inTokens, outputTokens: outTokens,
    };
  } catch {
    return null;
  }
}

/** The optional artifact fields for a finished scan. */
export function scanArtifactFields(outcome: ScanOutcome) {
  return {
    labels: { docType: outcome.state.docType, topics: outcome.state.topics },
    scan: { steps: outcome.steps, stoppedBy: outcome.stoppedBy, pagesRead: outcome.pagesRead, pagesTotal: outcome.pagesTotal },
  };
}

/** Whether a document's existing evidence is a verified page sample that a scan can extend. */
export function scanEligible(coverage: { totalPages: number | null; pages: Array<{ pageNumber: number }>; pageReferences: "verified" | "unavailable" } | undefined, sampled: boolean): coverage is NonNullable<typeof coverage> & { totalPages: number } {
  return !!coverage && sampled && coverage.pageReferences === "verified" && coverage.totalPages !== null
    && coverage.pages.length > 0 && coverage.pages.length < coverage.totalPages;
}
