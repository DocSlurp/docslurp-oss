// Tolerant reader for `POST /v1/chat` responses. Every field the agent
// contract adds is optional here: a missing field becomes null, never a crash.
// Values are recorded as reported; derived fallbacks live in score.mjs.
import { STOP_REASONS } from "./lib.mjs";

const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const array = (value) => (Array.isArray(value) ? value : []);
const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const string = (value) => (typeof value === "string" ? value : null);
const positiveInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

export function normalizeCitation(raw, index) {
  const item = object(raw);
  const citation = Object.keys(object(item.citation)).length ? object(item.citation) : item;
  const pages = [...new Set([positiveInt(citation.pageNumber ?? citation.page), ...array(citation.pageNumbers).map(positiveInt)].filter((page) => page !== null))];
  return {
    index: index + 1,
    documentId: string(citation.documentId),
    filename: string(citation.filename),
    pageNumber: positiveInt(citation.pageNumber ?? citation.page),
    pages,
    snippet: string(item.text ?? item.snippet ?? citation.snippet),
  };
}

/** Search queries from tool arguments: `q`, `query` or `queries[]` (strings or {q}). */
export function extractQueries(rawArgs) {
  let args = rawArgs;
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return [args]; } }
  const value = object(args);
  const queries = [];
  for (const key of ["q", "query"]) if (typeof value[key] === "string") queries.push(value[key]);
  for (const entry of array(value.queries)) {
    if (typeof entry === "string") queries.push(entry);
    else if (typeof object(entry).q === "string") queries.push(entry.q);
    else if (typeof object(entry).query === "string") queries.push(entry.query);
  }
  return queries;
}

export function normalizeToolCall(raw) {
  const call = object(raw);
  // Server contract (PR #65): evidencePages [{documentId, pageNumber}] and queries [string] per call.
  if (Array.isArray(call.evidencePages)) return normalizeToolCall({ ...call, evidencePages: undefined, evidence: call.evidencePages.map((page) => ({ citation: object(page) })) });
  const evidenceSource = ["evidence", "results", "citations", "hits"].find((key) => Array.isArray(call[key]) || Array.isArray(object(call.result)[key]) || Array.isArray(object(call.output)[key]));
  const evidenceItems = evidenceSource ? array(call[evidenceSource] ?? object(call.result)[evidenceSource] ?? object(call.output)[evidenceSource]) : null;
  const error = call.error ?? null;
  return {
    id: string(call.id),
    name: string(call.name ?? call.toolName),
    status: string(call.status),
    runtimeMs: number(call.runtimeMs),
    step: number(call.step ?? call.stepNumber),
    queries: Array.isArray(call.queries) ? call.queries.filter((query) => typeof query === "string") : extractQueries(call.args ?? call.input ?? call.arguments),
    zeroHit: typeof call.zeroHit === "boolean" ? call.zeroHit : null,
    costCents: number(call.costCents),
    resultCount: number(call.resultCount ?? call.hitCount ?? call.hits) ?? (evidenceItems ? evidenceItems.length : null),
    evidence: evidenceItems ? evidenceItems.map(normalizeCitation) : null,
    error: error === null ? null : typeof error === "string" ? error : string(object(error).message) ?? JSON.stringify(error),
    errorCode: string(call.errorCode ?? object(error).code ?? call.errorType),
  };
}

function stepUsage(debug) {
  const steps = Array.isArray(debug.steps) ? debug.steps : Array.isArray(debug.stepUsage) ? debug.stepUsage : null;
  if (!steps) return null;
  return steps.map((step) => {
    const usage = Object.keys(object(object(step).usage)).length ? object(step.usage) : object(step);
    return { inputTokens: number(usage.inputTokens ?? usage.input_tokens), outputTokens: number(usage.outputTokens ?? usage.output_tokens), costCents: number(usage.costCents) };
  });
}

export function extractChatResponse(body) {
  const response = object(body);
  const debug = object(response.debug);
  const usage = object(response.usage);
  const stopReason = string(debug.stopReason);
  return {
    id: string(response.id),
    sessionId: string(response.sessionId),
    answer: string(response.answer ?? response.text ?? object(object(array(response.choices)[0]).message).content),
    finishReason: string(response.finishReason),
    citations: array(response.citations).map(normalizeCitation),
    model: string(debug.model),
    requestedModel: string(debug.requestedModel),
    resolvedModel: string(debug.resolvedModel),
    steps: Array.isArray(debug.steps) ? debug.steps.length : number(debug.steps),
    stepUsage: stepUsage(debug),
    toolCallCount: number(debug.toolCallCount),
    searchCallCount: number(debug.searchCallCount),
    searchQueryCount: number(debug.searchQueryCount),
    zeroHitSearchCount: number(debug.zeroHitSearchCount),
    stopReason,
    stopReasonKnown: stopReason === null ? null : STOP_REASONS.includes(stopReason),
    limits: Object.keys(object(debug.limits)).length ? debug.limits : null,
    toolCalls: Array.isArray(debug.toolCalls) ? debug.toolCalls.map(normalizeToolCall) : null,
    usage: {
      inputTokens: number(usage.inputTokens), outputTokens: number(usage.outputTokens), totalTokens: number(usage.totalTokens),
      costCents: number(usage.costCents), costSource: string(usage.costSource), toolCostCents: number(usage.toolCostCents),
    },
    runtimeMs: number(object(response.runtime).totalMs),
  };
}

/** 1-based citation indexes referenced in the answer: [1], [2, 3], [4][5]. */
export function citedIndexes(answer) {
  const indexes = [];
  for (const match of String(answer ?? "").matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) for (const part of match[1].split(",")) indexes.push(Number(part.trim()));
  return [...new Set(indexes)];
}

/** Model check: did the server run the model we asked for? */
export function modelCheck(sent, extracted) {
  const requestedMatches = extracted.requestedModel === null ? null : extracted.requestedModel === sent;
  const resolvedMatches = extracted.resolvedModel === null ? null : extracted.resolvedModel === sent || extracted.resolvedModel.startsWith(`${sent}-`) || extracted.resolvedModel.startsWith(`${sent}:`);
  const debugMatches = extracted.model === null ? null : extracted.model === sent;
  return {
    sent, requestedModel: extracted.requestedModel, resolvedModel: extracted.resolvedModel, debugModel: extracted.model,
    requestedMatches, resolvedMatches, debugMatches,
    mismatch: requestedMatches === false || (requestedMatches === null && debugMatches === false),
    resolvedDiffers: resolvedMatches === false,
  };
}
