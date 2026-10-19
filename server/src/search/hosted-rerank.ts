import { assertProviderAllowed, type PrivacyMode } from "@docslurp/shared";
import { assertCanSpend } from "../services/billing/spend-guard.js";
import { rerankBM25, type RankedChunk } from "./rerank.js";
import type { SearchSessionJournal } from "./session.js";

export const HOSTED_RERANK_MODEL = "Qwen/Qwen3-Reranker-0.6B";
const endpoint = "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B";
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

/** Optional learned ranking; preserves exact candidate identity/body for citations. */
export async function rerankHosted(args: {
  query: string;
  chunks: RankedChunk[];
  model?: string;
  apiKey?: string;
  privacyMode: PrivacyMode;
  scope?: { orgId: string; workspaceId: string };
  session: SearchSessionJournal;
}): Promise<RankedChunk[]> {
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
    if (!apiKey || !scope?.orgId || !scope.workspaceId) throw Error();
    reason = "invalid_input";
    if (!args.query.trim() || args.chunks.length > 200 || new Set(args.chunks.map(c => c.id)).size !== args.chunks.length
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
          await assertCanSpend(scope.orgId, scope.workspaceId, { kind: "interactive" });
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
              metric: "rerank-tokens", inputTokens: data.input_tokens!, logOutputTokens: false,
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
