import { assertProviderAllowed, type PrivacyMode } from "@docslurp/shared";
import { assertCanSpend } from "../services/billing/spend-guard.js";
import { rerankBM25, type RankedChunk } from "./rerank.js";
import type { SearchSessionJournal } from "./session.js";

export const HOSTED_RERANK_MODEL = "Qwen/Qwen3-Reranker-0.6B";
const endpoint = "https://api.deepinfra.com/v1/inference/Qwen/Qwen3-Reranker-0.6B";
// Verified native DeepInfra default-tier rate, 2026-10-17. No priority tier.
const inputUsdPerMillion = 0.01;
const timeoutMs = 8_000;

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
  let reason = "provider_error";
  let requests = 0;
  let inputTokens = 0;
  let possibleUnreceiptedCharge = false;
  let meteringFailed = false;
  const diagnostic = (status: "success" | "fallback") => args.session.recordDiagnostic("hostedRerank", {
    provider: "deepinfra", model: HOSTED_RERANK_MODEL, status,
    ...(status === "fallback" ? { reason, fallback: "bm25" } : {}),
    candidates: args.chunks.length, requests, inputTokens, possibleUnreceiptedCharge,
    durationMs: performance.now() - startedAt,
  });
  try {
    reason = "invalid_configuration";
    if (args.model && args.model !== HOSTED_RERANK_MODEL) throw Error();
    reason = "privacy_blocked";
    assertProviderAllowed(args.privacyMode, { provider: "deepinfra", model: HOSTED_RERANK_MODEL, operation: "api.search.rerank", target: "hosted" });
    reason = "missing_key_or_scope";
    if (!args.apiKey || !args.scope?.orgId || !args.scope.workspaceId) throw Error();
    reason = "invalid_input";
    if (!args.query.trim() || args.chunks.length > 200 || new Set(args.chunks.map(c => c.id)).size !== args.chunks.length
      || args.chunks.some(c => !c.id || !c.text.trim() || Buffer.byteLength(args.query) + Buffer.byteLength(c.text) > 30_000)) throw Error();
    const signal = AbortSignal.timeout(timeoutMs);
    const ranked: RankedChunk[] = [];
    for (let offset = 0; offset < args.chunks.length; offset += 25) {
      const batch = args.chunks.slice(offset, offset + 25);
      reason = "spend_blocked";
      await assertCanSpend(args.scope.orgId, args.scope.workspaceId, { kind: "interactive" });
      if (signal.aborted) { reason = "timeout"; throw Error(); }
      reason = "provider_error";
      requests++;
      possibleUnreceiptedCharge = true;
      const response = await fetch(endpoint, {
        method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ queries: batch.map(() => args.query), documents: batch.map(c => c.text) }),
      });
      const data = await response.json() as { input_tokens?: number; scores?: unknown };
      reason = "missing_usage";
      if (!Number.isSafeInteger(data.input_tokens) || !(data.input_tokens! > 0)) throw Error();
      // Record actual tokens before checking status or scores: failed calls can bill.
      try {
        args.session.record({ provider: "deepinfra", model: HOSTED_RERANK_MODEL,
          metric: "rerank-tokens", inputTokens: data.input_tokens!, logOutputTokens: false,
          costCents: data.input_tokens! * inputUsdPerMillion / 1e6 * 100,
          metadata: { usageSource: "provider", candidateCount: batch.length, offset,
            verifiedInputUsdPerMTok: inputUsdPerMillion } });
      } catch (error) { meteringFailed = true; throw error; }
      possibleUnreceiptedCharge = false;
      inputTokens += data.input_tokens!;
      reason = "provider_http";
      if (!response.ok) throw Error();
      reason = "invalid_scores";
      if (!Array.isArray(data.scores) || data.scores.length !== batch.length || data.scores.some(score => typeof score !== "number" || !Number.isFinite(score))) throw Error();
      ranked.push(...batch.map((chunk, index) => ({ ...chunk, crossScore: (data.scores as number[])[index] })));
    }
    diagnostic("success");
    return ranked.sort((a, b) => b.crossScore! - a.crossScore!);
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) reason = "timeout";
    diagnostic("fallback");
    // Never hide a broken usage recorder by returning an apparently valid search.
    if (meteringFailed) throw error;
    return rerankBM25(args.query, args.chunks);
  }
}
