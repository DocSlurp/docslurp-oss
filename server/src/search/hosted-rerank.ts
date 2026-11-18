import { assertProviderAllowed, authorizePrivateModelCall, privateServiceModelFor, type PrivacyMode } from "@docslurp/shared";
import { z } from "zod";
import { assertCanSpend } from "../services/billing/spend-guard.js";
import { rerankBM25, type RankedChunk } from "./rerank.js";
import type { SearchSessionJournal } from "./session.js";

export const HOSTED_RERANK_MODEL = "Qwen/Qwen3-Reranker-0.6B";
const endpoint = "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B";
/**
 * Most candidates one reranker call (a search, or each of its sub-searches) sends to the hosted reranker. Each is billed by
 * the token, so the cap bounds each call's cost; candidates below it keep their fused rank.
 */
export const HOSTED_RERANK_MAX_CANDIDATES = 50;
/** Usage metric of one hosted reranker call; the search charge finds the reranker's provider cost by it. */
export const HOSTED_RERANK_USAGE_METRIC = "rerank-tokens";
// Verified native DeepInfra default-tier rate, 2026-10-17. No priority tier.
const inputUsdPerMillion = 0.01;

export function hostedRerankLimits(env: NodeJS.ProcessEnv = process.env) {
  const bounded = (value: string | undefined, fallback: number, min: number, max: number) => {
    if (!value?.trim()) return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
  };
  return {
    concurrency: bounded(env.SEARCH_RERANK_CONCURRENCY, 4, 1, 4),
    timeoutMs: bounded(env.SEARCH_RERANK_TIMEOUT_MS, 15_000, 1_000, 30_000),
  };
}

/** Sentinel "key" that marks a search whose model reranker is the operator's private endpoint; never sent anywhere. */
export const PRIVATE_RERANK_KEY = "private-endpoint";

/**
 * The private reranker for a project where hosted models are not allowed (a restricted project, or
 * `DOCSLURP_MODEL_MODE=private`): the operator's `DOCSLURP_PRIVATE_RERANK_MODEL`, or undefined (the hosted reranker,
 * or none: keyword ranking).
 */
export function privateRerankModelFor(privacyMode: PrivacyMode): string | undefined {
  return privateServiceModelFor("rerank", privacyMode);
}

// The `/rerank` response vLLM, TEI-compatible routers, Jina and Cohere serve.
const privateRerankResponseSchema = z.object({
  results: z.array(z.object({ index: z.number().int().nonnegative(), relevance_score: z.number().finite() }).passthrough()),
  usage: z.object({ total_tokens: z.number().int().nonnegative().optional(), prompt_tokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
}).passthrough();

/**
 * Model reranking on the operator's private endpoint (`POST <baseUrl>/rerank`). The route, URL and credentials come
 * only from the operator registry; strict-privacy writes the audit row before content is sent. Falls back to keyword
 * ranking on any failure, never to the hosted reranker.
 */
async function rerankPrivate(args: {
  query: string;
  chunks: RankedChunk[];
  modelUri: string;
  privacyMode: PrivacyMode;
  scope?: { orgId: string; projectId: string };
  session: SearchSessionJournal;
}): Promise<RankedChunk[]> {
  const startedAt = performance.now();
  const limits = hostedRerankLimits();
  let reason = "missing_scope";
  let alias: string | undefined;
  let inputTokens = 0;
  const diagnostic = (status: "success" | "fallback") => args.session.recordDiagnostic("hostedRerank", {
    provider: "private", ...(alias ? { endpointAlias: alias } : {}), status,
    ...(status === "fallback" ? { reason, fallback: "bm25" } : {}),
    candidates: args.chunks.length, requests: 1, inputTokens, durationMs: performance.now() - startedAt,
  });
  try {
    const { scope } = args;
    if (!scope?.orgId || !scope.projectId) throw Error();
    reason = "invalid_input";
    if (!args.query.trim() || args.chunks.length > HOSTED_RERANK_MAX_CANDIDATES || new Set(args.chunks.map(c => c.id)).size !== args.chunks.length
      || args.chunks.some(c => !c.id || !c.text.trim())) throw Error();
    reason = "spend_blocked";
    await assertCanSpend(scope.orgId, scope.projectId, { kind: "interactive" });
    reason = "privacy_blocked";
    const call = await authorizePrivateModelCall({
      privacyMode: args.privacyMode, modelUri: args.modelUri, capability: "rerank", operation: "api.search.rerank",
      auditScope: { projectId: scope.projectId },
    });
    alias = call.route.alias;
    reason = "provider_error";
    const requestStarted = Date.now();
    const response = await call.fetch(`${call.baseUrl}/rerank`, {
      method: "POST", signal: AbortSignal.timeout(limits.timeoutMs),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: call.model, query: args.query, documents: args.chunks.map(c => c.text) }),
    });
    reason = "provider_http";
    if (!response.ok) throw Error();
    reason = "invalid_scores";
    const parsed = privateRerankResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw Error();
    // Filled, not sparse: `some` skips holes, so a missing index must read as undefined.
    const scores = Array.from<number | undefined>({ length: args.chunks.length });
    for (const result of parsed.data.results) {
      if (result.index >= args.chunks.length || scores[result.index] !== undefined) throw Error();
      scores[result.index] = result.relevance_score;
    }
    if (scores.some(score => score === undefined)) throw Error();
    inputTokens = parsed.data.usage?.prompt_tokens ?? parsed.data.usage?.total_tokens ?? 0;
    const cost = call.cost({ inputTokens, outputTokens: 0, durationMs: Date.now() - requestStarted });
    args.session.record({ provider: call.provider, model: call.usageModel,
      metric: HOSTED_RERANK_USAGE_METRIC, inputTokens, logOutputTokens: false, costCents: cost.costCents,
      metadata: { ...cost.metadata, usageSource: parsed.data.usage ? "provider" : "unreported", candidateCount: args.chunks.length } });
    diagnostic("success");
    return args.chunks.map((chunk, index) => ({ ...chunk, crossScore: scores[index]! })).sort((a, b) => b.crossScore! - a.crossScore!);
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) reason = "timeout";
    diagnostic("fallback");
    return rerankBM25(args.query, args.chunks);
  }
}

/**
 * Optional learned ranking; preserves exact candidate identity/body for citations. Where hosted models are not
 * allowed, the operator's private reranker serves it; with none mapped the hosted call is refused (keyword ranking).
 */
export async function rerankHosted(args: {
  query: string;
  chunks: RankedChunk[];
  model?: string;
  apiKey?: string;
  privacyMode: PrivacyMode;
  scope?: { orgId: string; projectId: string };
  session: SearchSessionJournal;
}): Promise<RankedChunk[]> {
  const privateModel = privateRerankModelFor(args.privacyMode);
  if (privateModel) return await rerankPrivate({ query: args.query, chunks: args.chunks, modelUri: privateModel, privacyMode: args.privacyMode, scope: args.scope, session: args.session });
  const startedAt = performance.now();
  const limits = hostedRerankLimits();
  let reason = "provider_error";
  let requests = 0;
  let inputTokens = 0;
  let unreceiptedRequests = 0;
  let meteringFailed = false;
  let meteringError: unknown;
  const diagnostic = (status: "success" | "fallback") => args.session.recordDiagnostic("hostedRerank", {
    provider: "deepinfra", model: HOSTED_RERANK_MODEL, status,
    ...(status === "fallback" ? { reason, fallback: "bm25" } : {}),
    candidates: args.chunks.length, requests, inputTokens,
    possibleUnreceiptedCharge: unreceiptedRequests > 0, unreceiptedRequests,
    concurrency: limits.concurrency, timeoutMs: limits.timeoutMs,
    durationMs: performance.now() - startedAt,
  });
  const checkPrivacy = () => assertProviderAllowed(args.privacyMode, {
    provider: "deepinfra", model: HOSTED_RERANK_MODEL, operation: "api.search.rerank", target: "hosted",
  });
  try {
    reason = "invalid_configuration";
    if (args.model && args.model !== HOSTED_RERANK_MODEL) throw Error();
    reason = "privacy_blocked";
    checkPrivacy();
    reason = "missing_key_or_scope";
    const { apiKey, scope } = args;
    if (!apiKey || !scope?.orgId || !scope.projectId) throw Error();
    reason = "invalid_input";
    if (!args.query.trim() || args.chunks.length > HOSTED_RERANK_MAX_CANDIDATES || new Set(args.chunks.map(c => c.id)).size !== args.chunks.length
      || args.chunks.some(c => !c.id || !c.text.trim() || Buffer.byteLength(args.query) + Buffer.byteLength(c.text) > 30_000)) throw Error();
    const signal = AbortSignal.timeout(limits.timeoutMs);
    const ranked = new Array<RankedChunk>(args.chunks.length);
    let nextOffset = 0;
    let stopped = false;
    let failed = false;
    const worker = async () => {
      while (!stopped && nextOffset < args.chunks.length) {
        const offset = nextOffset;
        nextOffset += 25;
        const batch = args.chunks.slice(offset, offset + 25);
        let batchReason = "spend_blocked";
        try {
          await assertCanSpend(scope.orgId, scope.projectId, { kind: "interactive" });
          // A sibling may have failed while this admission was waiting in SQL.
          if (stopped) return;
          batchReason = "timeout";
          if (signal.aborted) throw Error();
          // Re-enforce privacy directly before every dispatch, including later waves.
          batchReason = "privacy_blocked";
          checkPrivacy();
          batchReason = "provider_error";
          requests++;
          unreceiptedRequests++;
          const response = await fetch(endpoint, {
            method: "POST", redirect: "error", signal,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({ queries: batch.map(() => args.query), documents: batch.map(c => c.text) }),
          });
          const data = await response.json() as { input_tokens?: number; scores?: unknown };
          batchReason = "missing_usage";
          if (!Number.isSafeInteger(data.input_tokens) || !(data.input_tokens! > 0)) throw Error();
          // Always settle and meter dispatched siblings, even after another fails.
          batchReason = "usage_recording_failed";
          try {
            args.session.record({ provider: "deepinfra", model: HOSTED_RERANK_MODEL,
              metric: HOSTED_RERANK_USAGE_METRIC, inputTokens: data.input_tokens!, logOutputTokens: false,
              costCents: data.input_tokens! * inputUsdPerMillion / 1e6 * 100,
              metadata: { usageSource: "provider", candidateCount: batch.length, offset,
                verifiedInputUsdPerMTok: inputUsdPerMillion } });
          } catch (error) { meteringFailed = true; meteringError ??= error; throw error; }
          unreceiptedRequests--;
          inputTokens += data.input_tokens!;
          batchReason = "provider_http";
          if (!response.ok) throw Error();
          batchReason = "invalid_scores";
          if (!Array.isArray(data.scores) || data.scores.length !== batch.length || data.scores.some(score => typeof score !== "number" || !Number.isFinite(score))) throw Error();
          batch.forEach((chunk, index) => { ranked[offset + index] = { ...chunk, crossScore: (data.scores as number[])[index] }; });
        } catch (error) {
          if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) batchReason = "timeout";
          if (!failed) reason = batchReason;
          failed = true;
          stopped = true;
        }
      }
    };
    // Workers catch individual failures. Await all in-flight responses/usage before
    // fallback or throwing, so the session cannot persist before late usage arrives.
    await Promise.all(Array.from({ length: Math.min(limits.concurrency, Math.ceil(args.chunks.length / 25)) }, worker));
    if (failed) throw meteringError ?? Error();
    diagnostic("success");
    // Equal scores retain original candidate order, independent of response timing.
    return ranked.sort((a, b) => b.crossScore! - a.crossScore!);
  } catch (error) {
    diagnostic("fallback");
    if (meteringFailed) throw error;
    return rerankBM25(args.query, args.chunks);
  }
}
