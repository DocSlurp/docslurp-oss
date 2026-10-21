#!/usr/bin/env node
// Independent scorer: the only process that opens gold. Deterministic
// per-call metrics, an LLM answer judge (cached, blind to the candidate
// model), seeded bootstrap CIs, a baseline comparison, histograms and the
// give-up intelligence view.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  BudgetGuard, DEFAULT_BASELINE_MODEL, DEFAULT_JUDGE_MODEL, appendJsonl, assertModelAllowed, bootstrapCi, hashOf, jaccard,
  loadPrices, mean, normalize, openRouterJson, parseArgs, quantile, readJson, readJsonl, seededOrder, sum, writeJsonExclusive, writeTextExclusive,
} from "./lib.mjs";
import { groundingOverlap, loadCorpusPages } from "./dataset.mjs";
import { citedIndexes, extractChatResponse } from "./response.mjs";

export const SCORE_SCHEMA = "docslurp-search-model-eval-score@v1";
export const JUDGE_PROMPT_VERSION = "search-model-eval-judge@v1";
export const NEAR_MISS_JUDGE_PROMPT_VERSION = "search-model-eval-judge-near-miss@v2";
/** Audit classifications of unanswerable cases -> report slices. */
export const UNANSWERABLE_SLICES = { clean_absent: "unanswerable_clean", near_miss: "unanswerable_near_miss", actually_answerable: "unanswerable_mislabeled" };
const LIMIT_STOPS = new Set(["step_limit", "tool_call_limit"]);
const ABSTAIN = /\b(?:cannot|can't|can ?not|could not|couldn't|unable to)\b[^.]{0,60}\b(?:find|determine|locate|answer|confirm|identify|verify)\b|\b(?:no|not any) (?:information|evidence|mention|record|documents?|results?)\b|\bnot (?:stated|provided|specified|mentioned|available|found|present|included|covered)\b|\b(?:insufficient|no relevant) (?:information|evidence|context)\b|\bdo(?:es)? not (?:contain|mention|include|say|specify|provide)\b|\bi don't know\b|\bnot (?:able|possible) to (?:determine|answer)\b/i;
const PROTOCOL = /invalid|schema|argument|parse|malformed|validation/i;

// ---------------------------------------------------------------- page matching

/**
 * Matching context for one tier: `documentAndPage` needs the cited document to
 * be the gold page's production document (documentId, documentMap[sourceDoc],
 * or a catalog entry with the same sourceDoc or sha256) and the same page;
 * `pageOnly` (workspaces of prefix slices of one source) needs the same page
 * number on any document whose known page count covers it.
 */
export const matchContext = (tier) => {
  const documentMap = tier?.documentMap ?? {}, documents = tier?.documents ?? {};
  const sourceDocById = {};
  for (const [sourceDoc, documentId] of Object.entries(documentMap)) sourceDocById[documentId] = sourceDoc;
  for (const [documentId, meta] of Object.entries(documents)) if (meta?.sourceDoc && !sourceDocById[documentId]) sourceDocById[documentId] = meta.sourceDoc;
  // pageOnly workspaces are slices of one source; its pages are that source's pages.
  const pageOnlySourceDoc = tier?.pageOnlySourceDoc ?? (tier?.scope?.sourceDocs?.length === 1 ? tier.scope.sourceDocs[0] : null);
  return { citationMatch: tier?.citationMatch ?? "documentAndPage", documentMap, documents, sourceDocById, pageOnlySourceDoc };
};

/** Source page behind a production citation page: (sourceDoc, page), or null when unmapped. */
export function sourcePageOf(documentId, page, context) {
  const sourceDoc = context.citationMatch === "pageOnly" ? context.pageOnlySourceDoc : context.sourceDocById[documentId];
  return sourceDoc ? { sourceDoc, page } : null;
}

/**
 * Fact-grounded support: do the cited (or retrieved) pages actually contain the
 * gold facts? Each citation is one unit (its pages' text joined, so a fact
 * straddling a multi-page chunk counts). any_of: some unit grounds every fact;
 * all_of: every fact is grounded by some unit. A fact is grounded at
 * groundingOverlap >= 0.6. Null when no unit has page text.
 */
export function factGrounding(gold, citations, context, pageText, minOverlap = 0.6) {
  if (!gold.answerable || !gold.facts?.length || typeof pageText !== "function") return { grounded: null, unitsWithText: 0, units: citations.length };
  const units = citations.map((citation) => citation.pages.map((page) => { const source = sourcePageOf(citation.documentId, page, context); return source ? pageText(source.sourceDoc, source.page) : null; }).filter((text) => typeof text === "string").join("\n")).filter(Boolean);
  if (!units.length) return { grounded: null, unitsWithText: 0, units: citations.length };
  const grounds = (fact, text) => groundingOverlap(fact, text) >= minOverlap;
  const grounded = gold.supportMode === "all_of"
    ? gold.facts.every((fact) => units.some((text) => grounds(fact, text)))
    : units.some((text) => gold.facts.every((fact) => grounds(fact, text)));
  return { grounded, unitsWithText: units.length, units: citations.length };
}

function goldDocumentIds(page, context) {
  const ids = new Set();
  if (page.documentId) ids.add(page.documentId);
  if (page.sourceDoc && context.documentMap[page.sourceDoc]) ids.add(context.documentMap[page.sourceDoc]);
  for (const [documentId, meta] of Object.entries(context.documents)) {
    if ((page.sourceDoc && meta?.sourceDoc === page.sourceDoc) || (page.sourceSha256 && (meta?.sha256 ?? meta?.sourceSha256) === page.sourceSha256)) ids.add(documentId);
  }
  return ids;
}
export function hitsPage(goldPage, citation, context = matchContext(null)) {
  if (!citation?.pages?.includes(goldPage.page)) return false;
  if (context.citationMatch === "pageOnly") {
    const pageCount = context.documents[citation.documentId]?.pageCount;
    return !Number.isSafeInteger(pageCount) || goldPage.page <= pageCount;
  }
  return Boolean(citation.documentId) && goldDocumentIds(goldPage, context).has(citation.documentId);
}

/**
 * Support recall over a citation list. any_of: 1 when any gold page is hit.
 * all_of: share of support groups hit (partial credit), `all` when every group is.
 */
export function supportRecall(gold, citations, context = matchContext(null)) {
  const groups = [...new Set(gold.supportPages.map((page) => page.group))].sort((a, b) => a - b);
  if (!groups.length) return null;
  const hitGroups = groups.filter((group) => gold.supportPages.some((page) => page.group === group && citations.some((citation) => hitsPage(page, citation, context))));
  if (gold.supportMode === "any_of") { const hit = hitGroups.length > 0 ? 1 : 0; return { recall: hit, all: hit === 1, groups: groups.length, hitGroups: hitGroups.length }; }
  return { recall: hitGroups.length / groups.length, all: hitGroups.length === groups.length, groups: groups.length, hitGroups: hitGroups.length };
}

export const heuristicAbstained = (answer, stopReason = null) => stopReason === "no_evidence" || ABSTAIN.test(String(answer ?? ""));

// ---------------------------------------------------------------- per call

const finalAttempt = (record) => (record.attempts ?? []).filter((attempt) => !attempt.refusedByBudget).at(-1) ?? null;

const pageList = (citations) => citations.map((citation) => ({ documentId: citation.documentId, pages: citation.pages }));

export function scoreCall(entry, record, { tier = null, judgment = null, pageText = null, audit = null } = {}) {
  const gold = entry.gold;
  const final = finalAttempt(record);
  // Re-read the raw response so normalisation fixes apply to earlier runs.
  const x = final?.response ? extractChatResponse(final.response) : final?.extracted ?? null;
  const ok = Boolean(final?.ok && x);
  const context = matchContext(tier);
  const catalog = Object.keys(context.documents).length ? context.documents : null;
  const citations = x?.citations ?? [];
  const toolCalls = x?.toolCalls ?? null;
  const toolEvidenceExposed = Boolean(toolCalls?.some((call) => Array.isArray(call.evidence)));
  const toolEvidence = toolEvidenceExposed ? toolCalls.flatMap((call) => call.evidence ?? []) : [];
  // Tool evidence without page numbers (a multi-page chunk before the server
  // reports pageNumbers) cannot place a page; the response citations list is
  // itself the gathered evidence on the agent path, so evidence is the union.
  const pagelessEvidence = toolEvidence.filter((item) => !item.pages.length);
  const evidence = [...toolEvidence.filter((item) => item.pages.length), ...citations];
  const evidenceSource = !ok ? null : toolEvidenceExposed ? (citations.length ? "tool_calls+citations_list" : "tool_calls") : citations.length ? "citations_list" : null;
  const markers = ok ? citedIndexes(x.answer) : [];
  const cited = markers.map((index) => citations[index - 1] ?? null);
  const validity = cited.map((citation) => {
    if (!citation) return { resolvable: false, exists: null, inEvidence: null, valid: false };
    const meta = catalog?.[citation.documentId];
    const exists = !catalog ? null : Boolean(meta) && citation.pages.length > 0 && (!Number.isSafeInteger(meta.pageCount) || citation.pages.every((page) => page <= meta.pageCount));
    // Checked against tool evidence only; unknown when that document has page-less evidence.
    const inTool = toolEvidence.some((item) => item.documentId === citation.documentId && item.pages.some((page) => citation.pages.includes(page)));
    const inEvidence = !toolEvidenceExposed ? null : inTool ? true : pagelessEvidence.some((item) => item.documentId === citation.documentId) ? null : false;
    return { resolvable: true, exists, inEvidence, valid: exists !== false && inEvidence !== false && citation.pages.length > 0 };
  });
  const answerable = gold.answerable;
  const evidenceRecall = ok && answerable && evidenceSource ? supportRecall(gold, evidence, context) : null;
  const citedRecall = ok && answerable ? supportRecall(gold, cited.filter(Boolean), context) ?? { recall: 0, all: false } : null;
  const groundedCited = ok && answerable ? factGrounding(gold, cited.filter(Boolean), context, pageText) : null;
  const groundedEvidence = ok && answerable ? factGrounding(gold, evidence, context, pageText) : null;
  const citedRelevant = ok && answerable && gold.relevantPages?.length ? cited.some((citation) => citation && gold.relevantPages.some((page) => hitsPage(page, citation, context))) : null;

  const searchCalls = toolCalls ? toolCalls.filter((call) => /search/i.test(call.name ?? "")) : [];
  const queries = searchCalls.flatMap((call) => call.queries);
  const searchCallCount = x?.searchCallCount ?? (toolCalls ? searchCalls.length : null);
  const searchQueryCount = x?.searchQueryCount ?? (queries.length ? queries.length : null);
  const successive = queries.slice(1).map((query, index) => jaccard(queries[index], query));
  const stopReason = x?.stopReason ?? (final?.errorKind === "timeout" ? "timeout" : ok ? null : "error");
  const heuristic = ok ? heuristicAbstained(x.answer, x.stopReason) : null;
  const abstained = !ok ? null : typeof judgment?.abstained === "boolean" ? judgment.abstained : heuristic;
  const unanswerableClass = !answerable && audit ? audit.classification : null;
  let score = null;
  if (unanswerableClass === "actually_answerable") score = null; // the gold label is wrong: unscored
  else if (!ok) score = 0;
  else if (unanswerableClass === "near_miss") score = judgment?.mode === "near_miss" && [0, 0.5, 1].includes(judgment.score) ? judgment.score : null;
  else if (!answerable) score = abstained ? 1 : 0;
  else if (judgment && [0, 0.5, 1].includes(judgment.score)) score = abstained && judgment.score < 1 ? 0 : judgment.score;
  const toolErrors = toolCalls ? toolCalls.filter((call) => call.status === "error" || call.error).length : null;
  const protocolFailures = toolCalls ? toolCalls.filter((call) => PROTOCOL.test(`${call.errorCode ?? ""} ${call.error ?? ""}`)).length : null;
  const attemptsCostKnown = (record.attempts ?? []).every((attempt) => attempt.refusedByBudget || Number.isFinite(attempt.costUsd));
  return {
    key: record.key, runId: record.runId, model: record.model, caseId: entry.id, arm: record.arm, repeat: record.repeat,
    workspaceTier: entry.workspaceTier, kind: entry.kind, answerable, ok,
    // Report slice: the audit splits unanswerable cases into clean / near-miss / mislabeled.
    slice: unanswerableClass ? UNANSWERABLE_SLICES[unanswerableClass] : entry.kind, unanswerableClass,
    abstentionExcluded: unanswerableClass === "actually_answerable",
    nearMissFlagged: unanswerableClass === "near_miss" && ok && score !== null ? score === 1 : null, outcome: record.outcome, citationMatch: context.citationMatch, factsStatus: entry.gold.factsStatus ?? null,
    attempts: record.attemptCount ?? null, retried: (record.attemptCount ?? 1) > 1, errorsRecorded: record.errors?.length ?? 0,
    modelMismatch: record.modelCheck?.mismatch ?? null, resolvedModel: record.modelCheck?.resolvedModel ?? null,
    score, correct: score === null ? null : score === 1,
    judge: judgment ? { mode: judgment.mode ?? "standard", score: judgment.score, abstained: judgment.abstained ?? null, contradicts: judgment.contradicts ?? null, flagged: judgment.flagged ?? null, rationale: judgment.rationale ?? null } : null,
    abstained, heuristicAbstained: heuristic,
    evidenceSource, evidenceRecall: evidenceRecall?.recall ?? null, evidenceAll: evidenceRecall?.all ?? null,
    citedRecall: citedRecall?.recall ?? null, citedAll: citedRecall?.all ?? null, citedRelevant,
    groundedCitation: groundedCited?.grounded ?? null, groundedEvidence: groundedEvidence?.grounded ?? null,
    groundingUnits: groundedCited ? { cited: groundedCited.units, citedWithText: groundedCited.unitsWithText, evidence: groundedEvidence.units, evidenceWithText: groundedEvidence.unitsWithText } : null,
    goldPages: gold.supportPages.map((page) => ({ sourceDoc: page.sourceDoc ?? null, documentId: page.documentId ?? context.documentMap[page.sourceDoc] ?? null, page: page.page, group: page.group })),
    citedPages: ok ? pageList(cited.filter(Boolean)) : null,
    evidencePages: ok ? pageList(evidence) : null, pagelessToolEvidence: pagelessEvidence.length,
    citationMarkers: markers.length,
    citationValidity: markers.length ? validity.filter((item) => item.valid).length / markers.length : null,
    citationsUnresolvable: validity.filter((item) => !item.resolvable).length,
    citationsOutsideWorkspace: validity.filter((item) => item.exists === false).length,
    citationsOutsideEvidence: validity.filter((item) => item.inEvidence === false).length,
    stopReason, limitExhausted: stopReason === null ? null : LIMIT_STOPS.has(stopReason),
    steps: x?.steps ?? null, toolCallCount: x?.toolCallCount ?? toolCalls?.length ?? null,
    searchCallCount, searchQueryCount, zeroHitSearchCount: x?.zeroHitSearchCount ?? null,
    fanOut: Number.isFinite(searchQueryCount) && searchCallCount > 0 ? searchQueryCount / searchCallCount : null,
    queriesObserved: queries.length,
    meanSuccessiveJaccard: successive.length ? mean(successive) : null,
    reformulated: queries.length >= 2 ? new Set(queries.map(normalize)).size > 1 : null,
    searchesBeforeAbstain: abstained ? searchCallCount : null,
    toolErrors, toolErrorRate: toolCalls?.length ? toolErrors / toolCalls.length : null, protocolFailures,
    latencyMs: final?.latencyMs ?? null, ttfbMs: final?.ttfbMs ?? null,
    totalLatencyMs: sum((record.attempts ?? []).map((attempt) => attempt.latencyMs)),
    inputTokens: x?.usage?.inputTokens ?? null, outputTokens: x?.usage?.outputTokens ?? null,
    costUsd: attemptsCostKnown ? sum((record.attempts ?? []).map((attempt) => attempt.costUsd)) : null,
    chargedUsd: record.chargedUsd ?? null,
    requestIds: (record.attempts ?? []).map((attempt) => attempt.requestId).filter(Boolean),
    traceIds: (record.attempts ?? []).map((attempt) => attempt.traceId).filter(Boolean),
  };
}

// ---------------------------------------------------------------- judge

export function judgeMessages(entry, answer) {
  const gold = entry.gold;
  const goldText = gold.answerable
    ? [`Gold facts (a correct answer contains all of these):\n${gold.facts.map((fact) => `- ${fact}`).join("\n")}`,
      gold.alternatives?.length ? `Acceptable alternative phrasings:\n${gold.alternatives.map((fact) => `- ${fact}`).join("\n")}` : "",
      gold.disqualifiers?.length ? `Disqualifying claims (an answer asserting these scores 0):\n${gold.disqualifiers.map((fact) => `- ${fact}`).join("\n")}` : ""].filter(Boolean).join("\n\n")
    : "Gold: the corpus does NOT contain this information. A correct answer says it cannot be found or determined and does not assert a specific answer.";
  return [
    { role: "system", content: [
      "You grade one answer from a document question-answering system against gold facts. Judge only factual content; ignore citation markers like [1], style and length.",
      "Rubric: 1 = contains every gold fact (or an acceptable alternative) and contradicts none. 0.5 = contains some gold facts or a partially correct answer, with no contradiction. 0 = misses the gold facts, contradicts them, asserts a disqualifying claim, or declines to answer.",
      "For a question whose gold says the information is absent: 1 = the answer clearly says it cannot be found or determined without asserting a specific answer; 0 = it asserts an answer.",
      "abstained = true when the answer declines or says the information is unavailable, regardless of correctness.",
      "Reply with JSON only: {\"score\": 0|0.5|1, \"abstained\": boolean, \"contradicts\": boolean, \"rationale\": string (<= 40 words)}",
    ].join("\n") },
    { role: "user", content: `Question:\n${entry.question}\n\n${goldText}\n\nAnswer to grade:\n<<<\n${String(answer ?? "").slice(0, 8_000)}\n>>>` },
  ];
}

/**
 * Near-miss rubric: the asked entity does not exist but a closely related real
 * one does (the audit note). Graded on whether the answer flags the mismatch.
 */
export function nearMissJudgeMessages(entry, answer, note) {
  return [
    { role: "system", content: [
      "You grade one answer from a document question-answering system. Judge only factual content; ignore citation markers like [1], style and length.",
      "The asked entity does not exist in the corpus; a closely related real entity exists (described in the note).",
      "Rubric: 1 = the answer clearly says the asked entity is not found AND either stops or answers about the related entity while flagging the difference. 0.5 = it answers about the related entity without clearly flagging the mismatch. 0 = it asserts facts about the asked entity as if it exists.",
      "abstained = true when the answer says the asked entity or information was not found, regardless of what else it says. flagged = true when the answer explicitly notes the asked entity differs from what was found.",
      "Reply with JSON only: {\"score\": 0|0.5|1, \"abstained\": boolean, \"flagged\": boolean, \"rationale\": string (<= 40 words)}",
    ].join("\n") },
    { role: "user", content: `Question:\n${entry.question}\n\nNote on the closely related real entity:\n${String(note ?? "").slice(0, 1_000)}\n\nAnswer to grade:\n<<<\n${String(answer ?? "").slice(0, 8_000)}\n>>>` },
  ];
}

export const nearMissCacheKey = (judgeModel, entry, answer, note) => hashOf({ judgeModel, promptVersion: NEAR_MISS_JUDGE_PROMPT_VERSION, question: entry.question, note: String(note ?? ""), answer: String(answer ?? "") });

export const judgeCacheKey = (judgeModel, entry, answer) => hashOf({ judgeModel, promptVersion: JUDGE_PROMPT_VERSION, question: entry.question, answerable: entry.gold.answerable, facts: entry.gold.facts, alternatives: entry.gold.alternatives ?? [], disqualifiers: entry.gold.disqualifiers ?? [], answer: String(answer ?? "") });

/** The judge must be an allowed model and never one of the candidates it grades. */
export function assertJudgeAllowed(judgeModel, candidateModels, prices) {
  assertModelAllowed(judgeModel, prices);
  if (candidateModels.includes(judgeModel)) throw new Error(`Judge model ${judgeModel} is also a candidate; choose an independent judge`);
}

export function createJudge({ judgeModel, prices, apiKey, cachePath, ledgerPath, guard, fetchImpl, log = console.log }) {
  const cache = new Map(readJsonl(cachePath).map((row) => [row.key, row.judgment]));
  return async (entry, answer, { mode = "standard", note = null } = {}) => {
    const nearMiss = mode === "near_miss";
    const key = nearMiss ? nearMissCacheKey(judgeModel, entry, answer, note) : judgeCacheKey(judgeModel, entry, answer);
    if (cache.has(key)) return { ...cache.get(key), cached: true, cacheKey: key };
    // The judge sees question, gold (or the audit note) and answer only: never the candidate model or arm.
    const messages = nearMiss ? nearMissJudgeMessages(entry, answer, note) : judgeMessages(entry, answer);
    const reply = await openRouterJson({ model: judgeModel, messages, apiKey, metric: nearMiss ? "search-model-eval-judge-near-miss" : "search-model-eval-judge", ledgerPath, guard, prices, fetchImpl, maxTokens: 400, scope: { caseId: entry.id, key }, log });
    const raw = reply.json ?? {};
    const score = [0, 0.5, 1].includes(Number(raw.score)) ? Number(raw.score) : null;
    const judgment = { mode, score, abstained: typeof raw.abstained === "boolean" ? raw.abstained : null, contradicts: typeof raw.contradicts === "boolean" ? raw.contradicts : null, flagged: typeof raw.flagged === "boolean" ? raw.flagged : null, rationale: typeof raw.rationale === "string" ? raw.rationale.slice(0, 400) : null, judgeModel, promptVersion: nearMiss ? NEAR_MISS_JUDGE_PROMPT_VERSION : JUDGE_PROMPT_VERSION, parseFailed: score === null };
    cache.set(key, judgment);
    appendJsonl(cachePath, { key, at: new Date().toISOString(), judgment, usage: reply.usage });
    return { ...judgment, cached: false, cacheKey: key };
  };
}

// ---------------------------------------------------------------- aggregation

const rate = (rows, pick, seed, iterations) => bootstrapCi(rows.map(pick).map((value) => (value === null || value === undefined ? null : Number(value))), { seed, iterations });
const dist = (values) => ({ n: values.filter(Number.isFinite).length, mean: mean(values), p50: quantile(values, 0.5), p90: quantile(values, 0.9), p95: quantile(values, 0.95), max: quantile(values, 1) });
const counts = (values) => { const out = {}; for (const value of values) out[value ?? "null"] = (out[value ?? "null"] ?? 0) + 1; return out; };

export function aggregate(rows, { seed = "search-model-eval", iterations = 2000 } = {}) {
  const ci = (name, pick, filter = () => true) => rate(rows.filter(filter), pick, `${seed}:${name}`, iterations);
  const answerable = (row) => row.answerable;
  // Headline give-up metrics use clean absences only (unaudited negatives count as clean);
  // raw keeps every unanswerable-gold case as originally labelled.
  const clean = (row) => !row.answerable && (row.unanswerableClass === null || row.unanswerableClass === "clean_absent");
  const raw = (row) => !row.answerable;
  const totalCost = sum(rows.map((row) => row.costUsd ?? row.chargedUsd));
  const correct = rows.filter((row) => row.correct).length;
  const judged = rows.filter((row) => row.score !== null).length;
  return {
    n: rows.length, ok: rows.filter((row) => row.ok).length, failed: rows.filter((row) => !row.ok).length, retried: rows.filter((row) => row.retried).length,
    modelMismatches: rows.filter((row) => row.modelMismatch).length, scored: judged,
    correctRate: ci("correct", (row) => row.correct), meanScore: ci("score", (row) => row.score),
    answerableCorrectRate: ci("answerable-correct", (row) => row.correct, answerable),
    evidenceRecall: ci("evidence-recall", (row) => row.evidenceRecall, answerable),
    citedRecall: ci("cited-recall", (row) => row.citedRecall, answerable),
    groundedCitationRate: ci("grounded-citation", (row) => row.groundedCitation, answerable),
    groundedEvidenceRate: ci("grounded-evidence", (row) => row.groundedEvidence, answerable),
    citedAllRate: ci("cited-all", (row) => row.citedAll, answerable),
    citationValidity: ci("citation-validity", (row) => row.citationValidity),
    correctAbstainRate: ci("correct-abstain", (row) => row.abstained, (row) => clean(row) && row.ok),
    hallucinationRate: ci("hallucination", (row) => (row.abstained === null ? null : !row.abstained), (row) => clean(row) && row.ok),
    correctAbstainRateRaw: ci("correct-abstain-raw", (row) => row.abstained, (row) => raw(row) && row.ok),
    hallucinationRateRaw: ci("hallucination-raw", (row) => (row.abstained === null ? null : !row.abstained), (row) => raw(row) && row.ok),
    nearMissFlaggedRate: ci("near-miss-flagged", (row) => row.nearMissFlagged, (row) => row.unanswerableClass === "near_miss"),
    nearMissMeanScore: ci("near-miss-score", (row) => row.score, (row) => row.unanswerableClass === "near_miss"),
    searchesBeforeAbstainClean: dist(rows.filter((row) => clean(row) && row.abstained).map((row) => row.searchesBeforeAbstain)),
    unanswerableLimitExhaustion: ci("unanswerable-limit-exhaustion", (row) => row.limitExhausted, clean),
    unanswerableLimitExhaustionRaw: ci("unanswerable-limit-exhaustion-raw", (row) => row.limitExhausted, raw),
    falseGiveUpRate: ci("false-give-up", (row) => row.abstained, (row) => answerable(row) && row.ok),
    limitExhaustionRate: ci("limit-exhaustion", (row) => row.limitExhausted),
    reformulationRate: ci("reformulated", (row) => row.reformulated),
    toolErrorRate: mean(rows.map((row) => row.toolErrorRate)),
    protocolFailures: sum(rows.map((row) => row.protocolFailures)),
    stopReasons: counts(rows.map((row) => row.stopReason)),
    steps: dist(rows.map((row) => row.steps)), searches: dist(rows.map((row) => row.searchCallCount)), fanOut: dist(rows.map((row) => row.fanOut)),
    meanSuccessiveQueryJaccard: mean(rows.map((row) => row.meanSuccessiveJaccard)),
    latencyMs: dist(rows.map((row) => row.latencyMs)), ttfbMs: dist(rows.map((row) => row.ttfbMs)),
    inputTokens: dist(rows.map((row) => row.inputTokens)), outputTokens: dist(rows.map((row) => row.outputTokens)),
    costUsd: { total: totalCost, perCall: rows.length ? totalCost / rows.length : null, unknownCostCalls: rows.filter((row) => row.costUsd === null).length },
    costPerCorrectUsd: correct ? totalCost / correct : null,
    correctPerDollar: totalCost > 0 ? correct / totalCost : null,
    timePerCorrectMs: correct ? sum(rows.map((row) => row.totalLatencyMs)) / correct : null,
    pagesPerDollar: "not_applicable",
  };
}

export function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) { const key = keyOf(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
  return groups;
}

/** Paired by (case, arm, repeat); seeded bootstrap of the mean score difference. */
export function compareToBaseline(rows, baseline, { seed = "search-model-eval", iterations = 2000 } = {}) {
  const pairKey = (row) => `${row.caseId}|${row.arm}|${row.repeat}`;
  const scoresBy = (model) => { const map = new Map(); for (const [key, group] of groupBy(rows.filter((row) => row.model === model && row.score !== null), pairKey)) map.set(key, mean(group.map((row) => row.score))); return map; };
  const base = scoresBy(baseline);
  const out = {};
  for (const model of [...new Set(rows.map((row) => row.model))].filter((model) => model !== baseline)) {
    const other = scoresBy(model);
    const diffs = [];
    let wins = 0, losses = 0, ties = 0;
    for (const [key, value] of other) {
      if (!base.has(key)) continue;
      const diff = value - base.get(key);
      diffs.push(diff);
      if (diff > 0) wins++; else if (diff < 0) losses++; else ties++;
    }
    out[model] = { baseline, pairs: diffs.length, wins, losses, ties, meanScoreDiff: bootstrapCi(diffs, { seed: `${seed}:pair:${model}`, iterations }) };
  }
  return out;
}

const LATENCY_EDGES = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 80_000, 150_000];
const COST_EDGES = [0, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1];
export function histogram(values, edges = null) {
  const finite = values.filter(Number.isFinite);
  if (!edges) {
    const top = Math.min(20, Math.max(0, ...finite));
    edges = Array.from({ length: top + 1 }, (_, index) => index);
    const bins = edges.map((edge, index) => ({ label: index === top && finite.some((value) => value > top) ? `${edge}+` : String(edge), count: finite.filter((value) => (index === top ? value >= edge : value === edge)).length }));
    return { n: finite.length, bins };
  }
  const bins = edges.map((edge, index) => {
    const next = edges[index + 1];
    return { label: next === undefined ? `>=${edge}` : `${edge}-${next}`, count: finite.filter((value) => value >= edge && (next === undefined || value < next)).length };
  });
  return { n: finite.length, bins };
}
export function renderHistogram(title, hist, width = 30) {
  const top = Math.max(1, ...hist.bins.map((bin) => bin.count));
  const labelWidth = Math.max(...hist.bins.map((bin) => bin.label.length));
  return [`${title} (n=${hist.n})`, ...hist.bins.map((bin) => `  ${bin.label.padStart(labelWidth)} | ${"#".repeat(Math.round((bin.count / top) * width))} ${bin.count}`)].join("\n");
}

/** 2x2 answerable/unanswerable x answered/abstained, plus give-up persistence. */
export function giveUpView(rows, { negative = (row) => !row.answerable } = {}) {
  const cell = (filter) => rows.filter(filter).length;
  const matrix = {
    answerable: { answered: cell((row) => row.answerable && row.ok && row.abstained === false), abstained: cell((row) => row.answerable && row.ok && row.abstained === true), failed: cell((row) => row.answerable && !row.ok) },
    unanswerable: { answered: cell((row) => negative(row) && row.ok && row.abstained === false), abstained: cell((row) => negative(row) && row.ok && row.abstained === true), failed: cell((row) => negative(row) && !row.ok) },
  };
  const abstainedTotal = matrix.answerable.abstained + matrix.unanswerable.abstained;
  const unanswerableTotal = matrix.unanswerable.answered + matrix.unanswerable.abstained;
  const negatives = rows.filter(negative);
  return {
    matrix,
    giveUpPrecision: abstainedTotal ? matrix.unanswerable.abstained / abstainedTotal : null,
    giveUpRecall: unanswerableTotal ? matrix.unanswerable.abstained / unanswerableTotal : null,
    searchesBeforeAbstain: histogram(rows.filter((row) => row.abstained && (row.answerable || negative(row))).map((row) => row.searchesBeforeAbstain)),
    searchesBeforeAbstainOnUnanswerable: histogram(negatives.filter((row) => row.abstained).map((row) => row.searchesBeforeAbstain)),
    unanswerableLimitExhaustion: negatives.length ? negatives.filter((row) => row.limitExhausted).length / negatives.length : null,
    unanswerableReformulationRate: mean(negatives.map((row) => (row.reformulated === null ? null : Number(row.reformulated)))),
  };
}

export function buildReport(rows, { seed, iterations, baseline, meta }) {
  const by = (keyOf) => Object.fromEntries([...groupBy(rows, keyOf)].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, aggregate(group, { seed: `${seed}:${key}`, iterations })]));
  const histograms = {};
  for (const [model, group] of groupBy(rows, (row) => row.model)) histograms[model] = {
    latencyMs: histogram(group.map((row) => row.latencyMs), LATENCY_EDGES), steps: histogram(group.map((row) => row.steps)),
    searches: histogram(group.map((row) => row.searchCallCount)), costUsd: histogram(group.map((row) => row.costUsd ?? row.chargedUsd), COST_EDGES),
  };
  const giveUp = {};
  const giveUpClean = {};
  const cleanNegative = (row) => !row.answerable && (row.unanswerableClass === null || row.unanswerableClass === "clean_absent");
  for (const [key, group] of groupBy(rows, (row) => `${row.model}|${row.arm}`)) {
    giveUp[key] = giveUpView(group);
    giveUpClean[key] = { ...giveUpView(group, { negative: cleanNegative }), raw: { correctAbstain: giveUp[key].giveUpRecall, limitExhaustion: giveUp[key].unanswerableLimitExhaustion }, nearMissFlaggedRate: mean(group.filter((row) => row.nearMissFlagged !== null).map((row) => Number(row.nearMissFlagged))), nearMiss: group.filter((row) => row.unanswerableClass === "near_miss").length };
  }
  return {
    schema: SCORE_SCHEMA, ...meta, calls: rows.length,
    byModel: by((row) => row.model), byModelArm: by((row) => `${row.model}|${row.arm}`),
    byModelTierKindArm: by((row) => `${row.model}|${row.workspaceTier}|${row.slice ?? row.kind}|${row.arm}`),
    baseline: { model: baseline, present: rows.some((row) => row.model === baseline), comparisons: compareToBaseline(rows, baseline, { seed, iterations }) },
    giveUp, giveUpClean, histograms,
  };
}

const fmt = (value, digits = 3) => (value === null || value === undefined || Number.isNaN(value) ? "n/a" : typeof value === "number" ? String(Number(value.toFixed(digits))) : String(value));
const label = (key) => key.replaceAll("|", " / ");
const ciText = (value) => (value?.n ? `${fmt(value.mean)} [${fmt(value.low)}, ${fmt(value.high)}] n=${value.n}` : "n/a");

export function renderMarkdown(report) {
  const lines = [`# Search-agent model comparison`, "", `- Dataset: \`${report.datasetSha256 ?? "unknown"}\``, `- Runs: ${(report.runs ?? []).join(", ")}`, `- Judge: ${report.judgeModel ?? "disabled"} (${JUDGE_PROMPT_VERSION})`, `- Calls scored: ${report.calls}; bootstrap ${report.iterations} iterations, seed \`${report.seed}\`; 95% CIs resample calls.`, `- Pages per $: not applicable to chat calls.`, ""];
  const table = (title, groups) => {
    lines.push(`## ${title}`, "", "| group | n | ok | correct | cited recall | grounded citation | evidence recall | grounded evidence | citation validity | false give-up | correct abstain (clean) | correct abstain (raw) | near-miss flagged | limit exhaustion | p50 / p95 ms | $/call | $/correct | correct/$ |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [key, row] of Object.entries(groups)) lines.push(`| ${label(key)} | ${row.n} | ${row.ok} | ${ciText(row.correctRate)} | ${ciText(row.citedRecall)} | ${ciText(row.groundedCitationRate)} | ${ciText(row.evidenceRecall)} | ${ciText(row.groundedEvidenceRate)} | ${ciText(row.citationValidity)} | ${ciText(row.falseGiveUpRate)} | ${ciText(row.correctAbstainRate)} | ${ciText(row.correctAbstainRateRaw)} | ${ciText(row.nearMissFlaggedRate)} | ${ciText(row.limitExhaustionRate)} | ${fmt(row.latencyMs.p50, 0)} / ${fmt(row.latencyMs.p95, 0)} | ${fmt(row.costUsd.perCall, 5)} | ${fmt(row.costPerCorrectUsd, 5)} | ${fmt(row.correctPerDollar, 1)} |`);
    lines.push("");
  };
  table("By model", report.byModel);
  table("By model x arm", report.byModelArm);
  table("By model x tier x kind x arm", report.byModelTierKindArm);
  lines.push("## Agent behaviour by model x arm", "", "| group | steps p50/p90 | searches p50/p90 | fan-out mean | reformulation | succ. query Jaccard | tool error rate | protocol failures | stop reasons | model mismatches | retried |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [key, row] of Object.entries(report.byModelArm)) lines.push(`| ${label(key)} | ${fmt(row.steps.p50)}/${fmt(row.steps.p90)} | ${fmt(row.searches.p50)}/${fmt(row.searches.p90)} | ${fmt(row.fanOut.mean)} | ${ciText(row.reformulationRate)} | ${fmt(row.meanSuccessiveQueryJaccard)} | ${fmt(row.toolErrorRate)} | ${row.protocolFailures} | ${Object.entries(row.stopReasons).map(([reason, count]) => `${reason}:${count}`).join(", ")} | ${row.modelMismatches} | ${row.retried} |`);
  lines.push("", `## Pairwise vs baseline ${report.baseline.model}${report.baseline.present ? "" : " (baseline not in these runs)"}`, "", "| model | pairs | wins | losses | ties | mean score diff [95% CI] |", "|---|---|---|---|---|---|");
  for (const [model, row] of Object.entries(report.baseline.comparisons)) lines.push(`| ${model} | ${row.pairs} | ${row.wins} | ${row.losses} | ${row.ties} | ${ciText(row.meanScoreDiff)} |`);
  if (report.caseLabels) {
    const labels = report.caseLabels;
    lines.push("", "## Give-up intelligence (clean)", "", `Unanswerable cases audited (${labels.path}): ${Object.entries(labels.counts).map(([name, count]) => `${name} ${count}`).join(", ")}. Headline abstention uses clean absences only; raw columns use every unanswerable-gold case as originally labelled. Near-miss cases are graded with ${NEAR_MISS_JUDGE_PROMPT_VERSION}; mislabeled cases are unscored and excluded from abstention metrics.`, "",
      "| model x arm | answerable answered | answerable abstained | clean answered | clean abstained | failed | give-up precision | correct abstain (clean) | correct abstain (raw) | searches before abstain p50 (clean) | limit exhaustion (clean) | limit exhaustion (raw) | near-miss flagged |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [key, view] of Object.entries(report.giveUpClean)) {
      const searches = report.byModelArm[key]?.searchesBeforeAbstainClean;
      lines.push(`| ${label(key)} | ${view.matrix.answerable.answered} | ${view.matrix.answerable.abstained} | ${view.matrix.unanswerable.answered} | ${view.matrix.unanswerable.abstained} | ${view.matrix.answerable.failed + view.matrix.unanswerable.failed} | ${fmt(view.giveUpPrecision)} | ${fmt(view.giveUpRecall)} | ${fmt(view.raw.correctAbstain)} | ${fmt(searches?.p50)} | ${fmt(view.unanswerableLimitExhaustion)} | ${fmt(view.raw.limitExhaustion)} | ${fmt(view.nearMissFlaggedRate)} (n=${view.nearMiss}) |`);
    }
    lines.push("");
    for (const [key, view] of Object.entries(report.giveUpClean)) lines.push("```text", renderHistogram(`${label(key)} searches before abstaining on clean unanswerable`, view.searchesBeforeAbstainOnUnanswerable), "```", "");
    if (labels.mislabeled.length) {
      lines.push("### Mislabeled unanswerable cases (actually answerable; excluded from abstention metrics)", "");
      for (const item of labels.mislabeled) lines.push(`- \`${item.id}\` (${item.tier}): ${item.note ?? ""}`);
      lines.push("");
    }
  }
  lines.push("", "## Give-up intelligence (raw)", "", "| model x arm | answerable answered | answerable abstained | unanswerable answered | unanswerable abstained | failed | give-up precision | give-up recall | unanswerable limit exhaustion |", "|---|---|---|---|---|---|---|---|---|");
  for (const [key, view] of Object.entries(report.giveUp)) lines.push(`| ${label(key)} | ${view.matrix.answerable.answered} | ${view.matrix.answerable.abstained} | ${view.matrix.unanswerable.answered} | ${view.matrix.unanswerable.abstained} | ${view.matrix.answerable.failed + view.matrix.unanswerable.failed} | ${fmt(view.giveUpPrecision)} | ${fmt(view.giveUpRecall)} | ${fmt(view.unanswerableLimitExhaustion)} |`);
  lines.push("");
  for (const [key, view] of Object.entries(report.giveUp)) lines.push("```text", renderHistogram(`${label(key)} searches before abstaining`, view.searchesBeforeAbstain), "```", "");
  lines.push("## Histograms", "");
  for (const [model, hist] of Object.entries(report.histograms)) lines.push(`### ${model}`, "", "```text", renderHistogram("latency ms", hist.latencyMs), renderHistogram("steps", hist.steps), renderHistogram("search calls", hist.searches), renderHistogram("cost USD", hist.costUsd), "```", "");
  return `${lines.join("\n")}\n`;
}

/** Seeded sample of judgments for human or agent review; the candidate model is withheld. */
export function renderJudgeAudit(items, { count, seed }) {
  const sample = seededOrder(items, `${seed}:audit`, (item) => item.cacheKey).slice(0, count);
  const lines = [`# Judge audit (${sample.length} of ${items.length} judgments, seed \`${seed}\`)`, "", "Review each judgment against the rubric (1 all gold facts, no contradiction; 0.5 partial; 0 missing, contradicted or declined; unanswerable: 1 only for a clear abstention). Candidate model names are withheld.", ""];
  sample.forEach((item, index) => {
    lines.push(`## ${index + 1}. ${item.caseId} (${item.kind}, ${item.answerable ? "answerable" : "unanswerable"})`, "", `**Question:** ${item.question}`, "", `**Gold facts:** ${item.answerable ? item.facts.map((fact) => `\`${fact}\``).join("; ") : "information absent"}`, "", "**Answer:**", "", "```text", String(item.answer ?? "").slice(0, 2_000), "```", "", `**Judge:** score ${item.judgment.score}, abstained ${item.judgment.abstained}, contradicts ${item.judgment.contradicts}. ${item.judgment.rationale ?? ""}`, "", "**Reviewer:** [ ] agree  [ ] disagree, correct score: ___  Notes:", "");
  });
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- orchestration

export function loadRunRecords(runDirs) {
  const records = [];
  for (const dir of runDirs) {
    const callsDir = join(dir, "calls");
    if (!existsSync(callsDir)) throw new Error(`No calls/ in ${dir}`);
    for (const file of readdirSync(callsDir).filter((name) => name.endsWith(".json")).sort()) records.push(readJson(join(callsDir, file)));
  }
  return records;
}

/** Audit file: [{id, tier, classification, evidence, note}] -> Map by id. */
export function loadCaseLabels(items, path = null) {
  const list = Array.isArray(items) ? items : items?.cases ?? [];
  const map = new Map();
  for (const item of list) {
    if (!Object.hasOwn(UNANSWERABLE_SLICES, item?.classification) || typeof item.id !== "string") throw new Error(`Invalid case label: ${JSON.stringify(item).slice(0, 120)}`);
    if (map.has(item.id)) throw new Error(`Duplicate case label ${item.id}`);
    map.set(item.id, item);
  }
  map.path = path;
  return map;
}

function caseLabelSummary(caseLabels, dataset) {
  const ids = new Set(dataset.cases.filter((entry) => !entry.gold.answerable).map((entry) => entry.id));
  const counts = {};
  for (const item of caseLabels.values()) counts[item.classification] = (counts[item.classification] ?? 0) + 1;
  return {
    path: caseLabels.path, counts,
    unknownIds: [...caseLabels.keys()].filter((id) => !ids.has(id)),
    unauditedUnanswerable: [...ids].filter((id) => !caseLabels.has(id)),
    mislabeled: [...caseLabels.values()].filter((item) => item.classification === "actually_answerable").map(({ id, tier, note, evidence }) => ({ id, tier, note, evidence })),
  };
}

/** Loads, in one pass, the corpus text of every page cited or retrieved in the records. */
export async function corpusPageText(corpusPath, { dataset, records, tiers = null }) {
  const cases = new Map(dataset.cases.map((entry) => [entry.id, entry]));
  const wanted = new Map();
  for (const record of records) {
    const entry = cases.get(record.caseId);
    const final = finalAttempt(record);
    if (!entry || !final?.response) continue;
    const context = matchContext((tiers ?? dataset.tiers)?.[entry.workspaceTier] ?? null);
    const x = extractChatResponse(final.response);
    const items = [...x.citations, ...(x.toolCalls ?? []).flatMap((call) => call.evidence ?? [])];
    for (const item of items) for (const page of item.pages) {
      const source = sourcePageOf(item.documentId, page, context);
      if (source) wanted.set(`${source.sourceDoc}#${source.page}`, source);
    }
  }
  const found = await loadCorpusPages(corpusPath, [...wanted.values()]);
  const lookup = (sourceDoc, page) => found.get(`${sourceDoc}#${page}`)?.text ?? null;
  lookup.requested = wanted.size;
  lookup.loaded = found.size;
  return lookup;
}

export async function scoreRuns({ dataset, records, tiers = null, pageText = null, caseLabels = null, runConfigs = [], judge = null, judgeModel = null, seed = "search-model-eval", iterations = 2000, baseline = DEFAULT_BASELINE_MODEL, onJudgment = () => {} }) {
  const cases = new Map(dataset.cases.map((entry) => [entry.id, entry]));
  const rows = [], missing = [];
  for (const record of records) {
    const entry = cases.get(record.caseId);
    if (!entry) { missing.push(record.key); continue; }
    const final = finalAttempt(record);
    const audit = !entry.gold.answerable ? caseLabels?.get(entry.id) ?? null : null;
    let judgment = null;
    const answer = final?.response ? extractChatResponse(final.response).answer : final?.extracted?.answer;
    // Mislabeled cases have wrong gold: never judged.
    if (judge && final?.ok && answer !== null && answer !== undefined && audit?.classification !== "actually_answerable") {
      judgment = audit?.classification === "near_miss" ? await judge(entry, answer, { mode: "near_miss", note: audit.note }) : await judge(entry, answer);
      onJudgment({ caseId: entry.id, kind: entry.kind, answerable: entry.gold.answerable, question: entry.question, facts: entry.gold.facts, answer, judgment, cacheKey: judgment.cacheKey });
    }
    rows.push(scoreCall(entry, record, { tier: (tiers ?? dataset.tiers)?.[entry.workspaceTier] ?? null, judgment, pageText, audit }));
  }
  const report = buildReport(rows, { seed, iterations, baseline, meta: { datasetSha256: dataset.casesSha256 ?? null, runs: [...new Set(records.map((record) => record.runId))], runConfigs, tierMatching: Object.fromEntries(Object.entries(tiers ?? dataset.tiers ?? {}).map(([name, tier]) => [name, { workspaceId: tier.workspaceId, citationMatch: tier.citationMatch, mappedDocuments: Object.keys(tier.documentMap ?? {}).length }])), judgeModel, seed, iterations, unmatchedRecords: missing, caseLabels: caseLabels ? caseLabelSummary(caseLabels, dataset) : null } });
  return { rows, report };
}

const USAGE = "Usage: score.mjs --dataset dataset.json --runs DIR[,DIR] --out DIR [--judge-model ID | --no-judge] [--judge-cap-usd 2] [--judge-cache path] [--judge-audit N] [--baseline ID] [--seed S] [--iterations 2000] [--tiers tiers.json] [--corpus pages-text.jsonl] [--case-labels audit.json] [--api-key-env OPENROUTER_API_KEY]";

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv, { booleans: ["no-judge"] });
  if (!options.dataset || !options.runs || !options.out) throw new Error(USAGE);
  const dataset = readJson(options.dataset);
  const runDirs = options.runs.split(",").map((dir) => resolve(dir));
  const records = loadRunRecords(runDirs);
  const runConfigs = runDirs.map((dir) => (existsSync(join(dir, "run-config.json")) ? readJson(join(dir, "run-config.json")) : null));
  const candidates = [...new Set([...records.map((record) => record.model), ...runConfigs.flatMap((config) => config?.identity?.models ?? [])])];
  const out = resolve(options.out);
  mkdirSync(out, { recursive: true });
  const prices = loadPrices(options.prices);
  let judge = null, judgeModel = null, guard = null;
  if (!options["no-judge"]) {
    judgeModel = options["judge-model"] ?? DEFAULT_JUDGE_MODEL;
    assertJudgeAllowed(judgeModel, candidates, prices);
    guard = new BudgetGuard({ capUsd: Number(options["judge-cap-usd"] ?? 2), logPath: join(out, "judge-guard.jsonl") });
    judge = createJudge({ judgeModel, prices, apiKey: process.env[options["api-key-env"] ?? "OPENROUTER_API_KEY"], cachePath: resolve(options["judge-cache"] ?? join(out, "judge-cache.jsonl")), ledgerPath: join(out, "judge-spend.jsonl"), guard });
  }
  const judgments = [];
  const seed = options.seed ?? "search-model-eval";
  const tiers = options.tiers ? readJson(options.tiers) : null;
  const pageText = options.corpus ? await corpusPageText(options.corpus, { dataset, records, tiers }) : null;
  const caseLabels = options["case-labels"] ? loadCaseLabels(readJson(options["case-labels"]), options["case-labels"]) : null;
  const { rows, report } = await scoreRuns({ dataset, records, tiers, pageText, caseLabels, runConfigs: runConfigs.map((config) => config?.identity ?? null), judge, judgeModel, seed, iterations: Number(options.iterations ?? 2000), baseline: options.baseline ?? DEFAULT_BASELINE_MODEL, onJudgment: (item) => judgments.push(item) });
  if (guard) report.judgeSpend = guard.state();
  report.corpus = pageText ? { path: options.corpus, pagesRequested: pageText.requested, pagesLoaded: pageText.loaded } : null;
  writeTextExclusive(join(out, "scores.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
  writeJsonExclusive(join(out, "report.json"), report);
  writeJsonExclusive(join(out, "histograms.json"), report.histograms);
  writeTextExclusive(join(out, "report.md"), renderMarkdown(report));
  if (options["judge-audit"]) writeTextExclusive(join(out, "judge-audit.md"), renderJudgeAudit(judgments, { count: Number(options["judge-audit"]), seed }));
  console.log(JSON.stringify({ calls: rows.length, out, judgeSpend: report.judgeSpend ?? null }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { console.error(error.message); process.exitCode = 2; });
}
