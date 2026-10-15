/**
 * Free (no-model) output checks that trigger the plan's single escalation, plus the typed seam
 * for the optional decision-model verifier. Pure: checks read only the extractor output.
 */

import type { VerifierTrigger } from "@docslurp/shared";

export interface CascadeCheckInput {
  text: string;
  /** Provider finish reason (`stop`, `length`, ...); undefined when the runtime did not report one. */
  finishReason?: string | null;
}

/** Finish reasons that mean the model ended on its own. */
const STOP_REASONS = new Set(["stop", "end_turn", "end", "eos", "stop_sequence", "completed"]);

function unescapedBraceBalance(span: string): number {
  let depth = 0;
  for (let i = 0; i < span.length; i++) {
    const ch = span[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return depth;
    }
  }
  return depth;
}

/** Light structural check of one TeX span: balanced braces, \left/\right and \begin/\end. */
export function isStructurallyValidTex(span: string): boolean {
  if (unescapedBraceBalance(span) !== 0) return false;
  const left = (span.match(/\\left(?![a-zA-Z])/g) ?? []).length;
  const right = (span.match(/\\right(?![a-zA-Z])/g) ?? []).length;
  if (left !== right) return false;
  const stack: string[] = [];
  for (const match of span.matchAll(/\\(begin|end)\{([^}]*)\}/g)) {
    if (match[1] === "begin") stack.push(match[2]!);
    else if (stack.pop() !== match[2]) return false;
  }
  return stack.length === 0;
}

/** True when the markdown contains a math span that fails the structural check. */
export function hasInvalidLatex(markdown: string): boolean {
  const stripped = markdown.replace(/```[\s\S]*?```/g, "");
  let rest = stripped;
  const spans: string[] = [];
  const take = (pattern: RegExp) => {
    rest = rest.replace(pattern, (_m, body: string) => {
      spans.push(body);
      return " ";
    });
  };
  take(/\$\$([\s\S]*?)\$\$/g);
  take(/\\\[([\s\S]*?)\\\]/g);
  take(/\\\(([\s\S]*?)\\\)/g);
  // An odd count of display delimiters left behind means an unterminated block.
  if ((rest.match(/\$\$/g) ?? []).length > 0) return true;
  if (/\\\[|\\\]/.test(rest)) return true;
  // Single-dollar spans only count when they carry TeX commands (so "$5 and $10" is not math).
  for (const match of rest.matchAll(/\$([^$\n]+)\$/g)) {
    if (match[1]!.includes("\\")) spans.push(match[1]!);
  }
  return spans.some((span) => !isStructurallyValidTex(span));
}

function splitCells(row: string): number {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).length;
}

/** True when a pipe table has rows with inconsistent column counts. */
export function hasRaggedTable(markdown: string): boolean {
  const lines = markdown.split(/\r?\n/);
  let block: string[] = [];
  const flush = (): boolean => {
    const rows = block;
    block = [];
    if (rows.length < 2) return false;
    return new Set(rows.map(splitCells)).size > 1;
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) block.push(line);
    else if (flush()) return true;
  }
  return flush();
}

/** Output visibly cut off: unclosed code fence or HTML table. */
export function looksTruncated(markdown: string): boolean {
  if ((markdown.match(/^\s*```/gm) ?? []).length % 2 === 1) return true;
  const opened = (markdown.match(/<table[\s>]/gi) ?? []).length;
  const closed = (markdown.match(/<\/table>/gi) ?? []).length;
  return opened > closed;
}

/**
 * First free check that fires for an extraction output, or null. Order is cheapest and most
 * decisive first; at most one escalation happens per assignment regardless of which fires.
 */
export function freeCascadeTrigger(input: CascadeCheckInput): VerifierTrigger | null {
  if (!input.text || input.text.trim() === "") return "empty-output";
  const finish = input.finishReason?.trim().toLowerCase();
  if (finish === "length" || finish === "max_tokens") return "truncated-output";
  if (finish && !STOP_REASONS.has(finish)) return "non-stop-finish";
  if (looksTruncated(input.text)) return "truncated-output";
  if (hasInvalidLatex(input.text)) return "invalid-latex";
  if (hasRaggedTable(input.text)) return "ragged-table";
  return null;
}

// ---- Decision-model verifier seam ----------------------------------------

export interface VerifierRequest {
  pageNumber: number;
  targetId: string;
  /** The cheap target's output the verifier judges against the page image. */
  text: string;
  /** Rendered page raster, when the caller has one. */
  imagePath?: string;
}

export interface VerifierVerdict {
  /** Probability the extraction failed (higher = more likely bad). */
  pFail: number;
  /** Escalate when pFail >= threshold chosen by the implementation. */
  escalate: boolean;
  /** Billed cost of the verifier call, added to the chunk actual. */
  costUsd: number;
}

/**
 * Optional escalation trigger backed by a decision model (typed questions over page image plus
 * cheap output). Only consulted when every free check passed. The production implementation
 * waits for the H4 verifier results; the stage runs without one.
 */
export interface CascadeVerifier {
  verify(request: VerifierRequest): Promise<VerifierVerdict | null>;
}

// ---- Deterministic content-filter refusals -------------------------------

/** Finish reasons a provider reports when it refuses the content itself (the same page refuses every time). */
const REFUSAL_FINISH_REASONS = new Set(["content_filter", "refusal", "safety", "blocked", "prohibited_content", "recitation"]);

/**
 * True when the provider refused the page rather than failing to transcribe it. Retrying the same
 * vendor is pointless (Anthropic refuses the same pages deterministically), so the cascade moves to
 * the next-best target from a different vendor.
 */
export function isContentRefusal(input: { finishReason?: string | null }): boolean {
  const finish = input.finishReason?.trim().toLowerCase();
  return !!finish && REFUSAL_FINISH_REASONS.has(finish);
}
