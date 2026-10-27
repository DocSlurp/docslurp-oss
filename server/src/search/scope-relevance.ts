import { DEFAULT_SCOPE_DECLINE_THRESHOLD } from "@docslurp/shared";

import { contentTerms, termCoverage } from "./relevance.js";

/**
 * Scope relevance: does the retrieved evidence look like it is about the
 * question at all? Drives the chat scope decline.
 *
 * Search's own `relevance` cannot answer this in production: a vector hit
 * from an embedding pipeline without a measured noise baseline counts as a
 * full match (1), so the best hit is 1 for nearly every query (see
 * search/relevance.ts). Lexical coverage is pipeline-independent: the share of
 * the question's distinct content terms (stemmed prefix match) found in a
 * passage's text, heading path or filename. The best passage decides.
 *
 * Calibrated by scripts/retrieval-quality/scope-decline-calibrate.mts; see
 * docs/evals/retrieval-quality/scope-decline-calibration.md.
 */

/** Questions with fewer content terms than this are never declined (greetings, "thanks", short follow-ups). */
export const SCOPE_MIN_CONTENT_TERMS = 2;

export interface ScopeEvidence {
  text: string;
  headingPath?: readonly string[] | null;
  filename?: string | null;
}

export interface ScopeRelevance {
  /** Best coverage across passages, 0..1; null when the question is too short to judge. */
  score: number | null;
  contentTerms: number;
  passages: number;
}

/**
 * Request verbs and generic qualifiers that say how to answer, not what about
 * ("write", "explain", "best", "today"). They appear in almost any corpus, so
 * counting them makes an unrelated question look half-covered.
 */
const SCOPE_GENERIC_TERMS = new Set(
  "write draft explain describe summarize summarise tell give show suggest recommend help find need want know make let please best good better great nice simple simply quick quickly easy easily today tonight tomorrow yesterday now currently thing things way ways something anything everything someone anyone".split(" "),
);

/** The question's subject terms: content terms without generic request words. */
export function scopeSubjectTerms(query: string): string[] {
  return contentTerms(query).filter(term => !SCOPE_GENERIC_TERMS.has(term));
}

function scopeQuery(query: string): string {
  return scopeSubjectTerms(query).join(" ");
}

export function scopeRelevance(query: string, evidence: readonly ScopeEvidence[]): ScopeRelevance {
  const subject = scopeQuery(query);
  const terms = contentTerms(subject).length;
  if (terms < SCOPE_MIN_CONTENT_TERMS) return { score: null, contentTerms: terms, passages: evidence.length };
  let best = 0;
  for (const passage of evidence) {
    const haystack = [passage.text, (passage.headingPath ?? []).join(" "), passage.filename ?? ""].join("\n");
    best = Math.max(best, termCoverage(subject, haystack));
    if (best >= 1) break;
  }
  return { score: best, contentTerms: terms, passages: evidence.length };
}

/** The workspace threshold, else the measured default; always within 0..1 (0 turns the decline off). */
export function resolveScopeDeclineThreshold(workspaceThreshold: number | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof workspaceThreshold === "number" && Number.isFinite(workspaceThreshold)) return Math.max(0, Math.min(1, workspaceThreshold));
  const raw = env.CHAT_SCOPE_DECLINE_THRESHOLD?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return DEFAULT_SCOPE_DECLINE_THRESHOLD;
}

/**
 * Questions about the workspace itself (its files, uploads, processing, search
 * or settings) are always in scope, even though the documents rarely contain
 * those words.
 */
const WORKSPACE_META_TERMS = /^(?:workspaces?|uploads?|uploaded|uploading|files?|documents?|docs?|settings?|search(?:es|ed|ing)?|index(?:ed|ing|es)?|ingest(?:ed|ing|ion)?|process(?:ed|ing)?|pars(?:e|ed|ing|er)|extract(?:ed|ing|ion)?|ocr|pages?|pdfs?|videos?|audio|chat|citations?|cite[sd]?|corpus|folders?|sources?|attachments?)$/;

function isWorkspaceMetaQuestion(query: string): boolean {
  return contentTerms(query).some(term => WORKSPACE_META_TERMS.test(term));
}

export interface ScopeDeclineDecision {
  decline: boolean;
  relevance: ScopeRelevance;
  threshold: number;
  /** Why the check did not apply, when it did not. */
  skipped?: "disabled" | "short-question" | "follow-up" | "no-evidence" | "workspace-meta";
}

/**
 * Whether this turn should be declined as out of scope. Never declines a
 * question too short to judge, or a short follow-up in a conversation (its
 * subject is in the history, not the question). Workspace instructions do not
 * take part: an "answer anything" instruction cannot turn the decline off.
 * Only the workspace threshold setting (0) can.
 */
export function decideScopeDecline(args: {
  query: string;
  evidence: readonly ScopeEvidence[];
  threshold: number;
  historyTurns: number;
}): ScopeDeclineDecision {
  const relevance = scopeRelevance(args.query, args.evidence);
  const base = { relevance, threshold: args.threshold };
  if (args.threshold <= 0) return { ...base, decline: false, skipped: "disabled" };
  if (relevance.score === null) return { ...base, decline: false, skipped: "short-question" };
  if (args.historyTurns > 0 && relevance.contentTerms <= 3) return { ...base, decline: false, skipped: "follow-up" };
  if (isWorkspaceMetaQuestion(args.query)) return { ...base, decline: false, skipped: "workspace-meta" };
  if (args.evidence.length === 0) return { ...base, decline: false, skipped: "no-evidence" };
  return { ...base, decline: relevance.score < args.threshold };
}
