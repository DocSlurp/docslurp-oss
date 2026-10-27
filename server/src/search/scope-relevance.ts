import { DEFAULT_SCOPE_DECLINE_THRESHOLD } from "@docslurp/shared";

import { contentTerms, cosineFromVectorScore, embeddingNoiseBaseline, vectorRelevance } from "./relevance.js";
import type { EvidenceRetrievalResult } from "./retrieval-adapters.js";

/**
 * Server-side scope decline: a conservative UX shortcut, not a safety control.
 *
 * When a first-turn question is clearly unrelated to the workspace, chat can
 * answer with a templated polite decline and related questions instead of a
 * model turn. It fires only when every condition holds (decideScopeDecline):
 * a calibrated vector signal below the threshold, no conversation history, no
 * settings change from the message, no web tools, no request filters, a script
 * the scorer can segment, and a question that is not about the workspace
 * itself, and no returned passage was found by a keyword, phrase, graph or
 * page-locator branch. In every other case the turn proceeds and the model applies the fixed
 * core rule (decline unrelated requests politely and suggest related ones).
 * Anyone can phrase a question to avoid the shortcut; that is fine, because it
 * only saves a model call.
 *
 * The signal is the best vector-branch cosine for the turn, rescaled above the
 * embedding pipeline's measured noise baseline (search/relevance.ts), the same
 * 0..1 relevance the relevance floor uses. Pipelines without a measured baseline
 * produce no calibrated signal, so the shortcut never fires for them. Rerank
 * scores are not used: the local reranker is BM25 relative to its candidate
 * pool, and hosted rerank scores are not exposed or calibrated.
 *
 * Calibration: docs/evals/retrieval-quality/scope-decline-calibration.md.
 */

/** A calibrated relevance signal for one search turn. */
export interface ScopeSignal {
  name: "vector";
  /** Embedding pipeline id (search/relevance.ts embeddingPipelineId), or null when unknown. */
  pipeline: string | null;
  /** Best cosine among the vector branch's candidates. */
  topCosine: number;
  /** The best cosine rescaled above the pipeline's noise baseline (0..1); null without a measured baseline. */
  relevance: number | null;
  /**
   * Whether any returned result was also found by a lexical, phrase, graph or
   * page-locator branch at or above the relevance floor. Such evidence is
   * stronger than the vector score, so the shortcut never overrides it.
   */
  nonVectorEvidence?: boolean;
}

/** Key that ties a chunk to its returned result. */
export function scopeEvidenceKey(item: { documentId: string; chunkIndex?: number | null }): string {
  return `${item.documentId}:${item.chunkIndex ?? "?"}`;
}

/** The turn's vector signal from the retrieval branches before fusion, or null when no vector branch ran. */
export function vectorScopeSignal(results: readonly EvidenceRetrievalResult[], pipeline: string | null): ScopeSignal | null {
  const vector = results.filter(result => result.adapter === "vector").flatMap(result => result.chunks);
  if (vector.length === 0) return null;
  const best = Math.max(...vector.map(chunk => chunk.score));
  const baseline = embeddingNoiseBaseline(pipeline);
  return { name: "vector", pipeline, topCosine: cosineFromVectorScore(best), relevance: baseline === null ? null : vectorRelevance(best, baseline) };
}

/**
 * Questions with fewer content terms than this are never declined: greetings,
 * "thanks", and short questions whose embeddings are too unreliable to judge
 * (a short location question can score below the embedding noise baseline).
 */
export const SCOPE_MIN_CONTENT_TERMS = 3;

/**
 * Only scripts with calibration probes are judged: Latin. Any letter from
 * another script (CJK, Thai, Arabic, Hebrew, Cyrillic, Greek, Hangul,
 * Devanagari and the rest) skips the shortcut until probes exist for it; the
 * term counting also mis-splits scripts with combining marks.
 */
const UNCALIBRATED_SCRIPT = /(?=\p{L})[^\p{Script=Latin}]/u;

/**
 * Questions about the workspace itself (its files, uploads, processing, search
 * or settings) are in scope even though the documents rarely discuss them.
 */
const WORKSPACE_META_TERMS = /^(?:workspaces?|uploads?|uploaded|uploading|files?|documents?|docs?|settings?|search(?:es|ed|ing)?|index(?:ed|ing|es)?|ingest(?:ed|ing|ion)?|process(?:ed|ing)?|pars(?:e|ed|ing|er)|extract(?:ed|ing|ion)?|ocr|pages?|pdfs?|videos?|audio|chat|citations?|cite[sd]?|corpus|folders?|sources?|attachments?)$/;

function isWorkspaceMetaQuestion(query: string): boolean {
  return contentTerms(query).some(term => WORKSPACE_META_TERMS.test(term));
}

/** The workspace threshold, else CHAT_SCOPE_DECLINE_THRESHOLD, else the measured default; always within 0..1 (0 turns the shortcut off). */
export function resolveScopeDeclineThreshold(workspaceThreshold: number | null | undefined, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof workspaceThreshold === "number" && Number.isFinite(workspaceThreshold)) return Math.max(0, Math.min(1, workspaceThreshold));
  const raw = env.CHAT_SCOPE_DECLINE_THRESHOLD?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return DEFAULT_SCOPE_DECLINE_THRESHOLD;
}

export type ScopeDeclineSkip =
  | "disabled" | "history" | "search-configuration" | "web-tools" | "filters"
  | "uncalibrated-script" | "short-question" | "workspace-meta" | "no-evidence" | "keyword-or-graph-evidence" | "uncalibrated";

export interface ScopeDeclineDecision {
  decline: boolean;
  threshold: number;
  /** The calibrated relevance compared with the threshold, when there was one. */
  relevance: number | null;
  signal: ScopeSignal | null;
  /** Why the shortcut did not apply, when it did not. */
  skipped?: ScopeDeclineSkip;
}

export interface ScopeDeclineInput {
  query: string;
  signal: ScopeSignal | null;
  /** Passages the turn retrieved; none means the existing no-match answer applies. */
  evidenceCount: number;
  threshold: number;
  historyTurns: number;
  /** A settings change from this message ran (configureSearchFromChat). */
  searchConfigured: boolean;
  webTools: boolean;
  /** The request narrowed the search (documents, types, tags or dates). */
  filtered: boolean;
}

/**
 * Whether this turn takes the templated decline. Workspace instructions take no
 * part: an "answer anything" instruction cannot turn it off; only the threshold
 * setting (0) can.
 */
export function decideScopeDecline(input: ScopeDeclineInput): ScopeDeclineDecision {
  const base = { threshold: input.threshold, signal: input.signal, relevance: input.signal?.relevance ?? null };
  const skip = (skipped: ScopeDeclineSkip): ScopeDeclineDecision => ({ ...base, decline: false, skipped });
  if (input.threshold <= 0) return skip("disabled");
  if (input.historyTurns > 0) return skip("history");
  if (input.searchConfigured) return skip("search-configuration");
  if (input.webTools) return skip("web-tools");
  if (input.filtered) return skip("filters");
  if (UNCALIBRATED_SCRIPT.test(input.query)) return skip("uncalibrated-script");
  if (contentTerms(input.query).length < SCOPE_MIN_CONTENT_TERMS) return skip("short-question");
  if (isWorkspaceMetaQuestion(input.query)) return skip("workspace-meta");
  if (input.evidenceCount === 0) return skip("no-evidence");
  if (input.signal?.nonVectorEvidence) return skip("keyword-or-graph-evidence");
  if (input.signal?.relevance === null || input.signal?.relevance === undefined) return skip("uncalibrated");
  return { ...base, decline: input.signal.relevance < input.threshold };
}
