import { buildTrustedDocumentTaskPrompt, type TrustedDocumentTaskPrompt } from "../lib/trusted-llm-task.js";
import { normalizeHeadingPath } from "./hash.js";
import { DEFAULT_SUMMARY_TREE_LIMITS } from "./limits.js";
import type { StoredSummary } from "./reuse.js";

/** Characters of source one prompt may carry; a full leaf group is well under it. */
export const SUMMARY_TREE_MAX_PROMPT_CONTENT_CHARS = 100_000;
const MAX_TITLE_CHARS = 200;

/**
 * Output tokens for the first attempt. Generous on purpose: the length is a target stated in words, and
 * scripts without spaces spend several tokens per "word". A cut-off answer is retried once at double this.
 */
export function summaryOutputTokenBudget(lengthTargetWords: number = DEFAULT_SUMMARY_TREE_LIMITS.summaryLengthWords): number {
  return Math.ceil(lengthTargetWords * 3) + 96;
}

export interface SummaryPromptPart {
  /** Title of a child summary; absent for raw leaf text. */
  title?: string | null;
  text: string;
}

/**
 * The prompt for one node. The instruction is fixed: there is no tenant-supplied wording, and no language
 * code is passed (the model is told to write in the language of the source). Everything that comes from the
 * document, the heading path and child summaries included, goes inside the untrusted block: headings are
 * document text, and a child summary is model output over document text.
 */
export function buildSummaryTreePrompt(args: {
  parts: readonly SummaryPromptPart[];
  headingPath?: readonly string[] | null;
  lengthTargetWords?: number;
  maxContentChars?: number;
}): TrustedDocumentTaskPrompt {
  const words = args.lengthTargetWords ?? DEFAULT_SUMMARY_TREE_LIMITS.summaryLengthWords;
  const headingPath = normalizeHeadingPath(args.headingPath);
  const content = [
    ...(headingPath.length > 0 ? [`Section: ${headingPath.join(" > ")}`] : []),
    ...args.parts.map((part) => {
      const title = part.title?.trim();
      return title ? `${title}\n${part.text.trim()}` : part.text.trim();
    }).filter((part) => part.length > 0),
  ].join("\n\n");
  return buildTrustedDocumentTaskPrompt({
    instruction: "Summarize this part of a document for a search index. Cover its topics, named entities, figures and conclusions, using only what the text states.",
    outputContract: `Write in the language of the source. Line 1: a short title. Then a summary of about ${words} words. Plain text only, with no markdown, labels or commentary.`,
    untrustedContent: content,
    untrustedContentLabel: "document section",
    maxContentChars: args.maxContentChars ?? SUMMARY_TREE_MAX_PROMPT_CONTENT_CHARS,
  });
}

export type SummaryParseFailure = "empty" | "reasoning-leak" | "missing-title" | "missing-body";
export type ParsedSummary = { ok: true; summary: StoredSummary } | { ok: false; reason: SummaryParseFailure };

/** Line 1 is the title, the rest is the summary. Light markdown on the title line is removed, not rejected. */
export function parseSummaryTreeOutput(output: string): ParsedSummary {
  const text = output.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (/<think>|^\s*thinking process:/im.test(text)) return { ok: false, reason: "reasoning-leak" };
  const lineEnd = text.indexOf("\n");
  if (lineEnd < 0) return { ok: false, reason: "missing-body" };
  const title = text.slice(0, lineEnd)
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*(?:title|line 1)\s*[:：]\s*/i, "")
    .replace(/^[*_"'“”‘’`\s]+|[*_"'“”‘’`\s]+$/gu, "")
    .replace(/\s+/gu, " ");
  const body = text.slice(lineEnd + 1)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph.length > 0)
    .join("\n\n")
    .replace(/^summary\s*[:：]\s*/i, "");
  if (!title) return { ok: false, reason: "missing-title" };
  if (!body) return { ok: false, reason: "missing-body" };
  const cappedTitle = title.length > MAX_TITLE_CHARS ? Array.from(title).slice(0, MAX_TITLE_CHARS).join("").trim() : title;
  return { ok: true, summary: { title: cappedTitle, text: body } };
}

export interface SummaryCallUsage {
  inputTokens: number;
  outputTokens: number;
  costCents?: number;
  metadata?: Record<string, unknown>;
}

export interface SummaryCallResult {
  text: string;
  finishReason: string;
  usage: SummaryCallUsage;
}

/** One model call at the given output budget. `attempt` is 1 or 2. The caller owns the model, key and scope. */
export type SummaryModelCall = (maxOutputTokens: number, attempt: number) => Promise<SummaryCallResult>;

export type SummaryGenerationOutcome =
  /** A complete, well-formed summary: the only outcome that may be stored. */
  | { status: "ok"; summary: StoredSummary }
  /** Still cut off at double the budget. Nothing to store. */
  | { status: "truncated" }
  /** The model finished but broke the output contract. Nothing to store. */
  | { status: "invalid"; reason: SummaryParseFailure }
  /** A call threw. Attempts made before it are still in `attemptUsages` and must be billed. */
  | { status: "error"; error: unknown };

export type SummaryGenerationResult = SummaryGenerationOutcome & {
  /** Usage of every attempt that returned, in order. Each one is recorded and billed, kept or not. */
  attemptUsages: SummaryCallUsage[];
  /** The attempts added together, for callers that record one event per node. */
  usage: SummaryCallUsage;
  attempts: number;
  /** Output budget of the last attempt made. */
  maxOutputTokens: number;
};

export function combineSummaryUsage(usages: readonly SummaryCallUsage[]): SummaryCallUsage {
  const costs = usages.map((usage) => usage.costCents).filter((cost): cost is number => typeof cost === "number");
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    ...(costs.length > 0 ? { costCents: costs.reduce((sum, cost) => sum + cost, 0) } : {}),
    metadata: { ...usages.at(-1)?.metadata, attempts: usages.length },
  };
}

/**
 * The truncation rule. Call once at `maxOutputTokens`; if the answer was cut off (`finishReason === "length"`)
 * call once more at double the budget, never with more reasoning. Both attempts are returned for billing.
 * A summary that is still cut off, or that breaks the output contract, is reported and never returned as text.
 */
export async function generateSummaryWithRetry(args: { call: SummaryModelCall; maxOutputTokens?: number }): Promise<SummaryGenerationResult> {
  const firstBudget = args.maxOutputTokens ?? summaryOutputTokenBudget();
  const attemptUsages: SummaryCallUsage[] = [];
  let budget = firstBudget;
  const finish = (outcome: SummaryGenerationOutcome): SummaryGenerationResult => ({
    ...outcome, attemptUsages, usage: combineSummaryUsage(attemptUsages), attempts: attemptUsages.length, maxOutputTokens: budget,
  });
  let last: SummaryCallResult;
  try {
    last = await args.call(budget, 1);
    attemptUsages.push(last.usage);
    if (last.finishReason === "length") {
      budget = firstBudget * 2;
      last = await args.call(budget, 2);
      attemptUsages.push(last.usage);
    }
  } catch (error) {
    return finish({ status: "error", error });
  }
  if (last.finishReason === "length") return finish({ status: "truncated" });
  const parsed = parseSummaryTreeOutput(last.text);
  return finish(parsed.ok ? { status: "ok", summary: parsed.summary } : { status: "invalid", reason: parsed.reason });
}
