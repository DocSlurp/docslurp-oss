import type { Sql, JSONValue } from "postgres";
import { resolveOpenRouterUsage } from "@docslurp/shared";

type Attempt = {
  generationId?: string | null;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents?: number;
  costMetadata?: Record<string, unknown>;
};

/** Replaces estimates only when every attempt has a receipt; never changes customer credits. */
export async function reconcileVisionReceiptMetadata(
  metadata: Record<string, unknown>, model: string, apiKey: string,
): Promise<Record<string, unknown> | null> {
  const source = metadata.visionAttempts ?? metadata.attempts;
  if (!Array.isArray(source) || source.length === 0) return null;
  const attempts: Attempt[] = [];
  for (const value of source) {
    if (!value || typeof value !== "object") return null;
    const attempt = value as Attempt;
    if (!Number.isFinite(attempt.inputTokens) || !Number.isFinite(attempt.outputTokens)) return null;
    if (typeof attempt.costCents === "number" && Number.isFinite(attempt.costCents) && attempt.costCents >= 0) {
      attempts.push(attempt);
      continue;
    }
    if (!attempt.generationId) return null;
    const receipt = await resolveOpenRouterUsage({ apiKey, model: attempt.model ?? model,
      generationId: attempt.generationId, usage: { inputTokens: attempt.inputTokens, outputTokens: attempt.outputTokens } });
    if (receipt.metadata?.costSource !== "provider" || receipt.costCents === undefined) return null;
    attempts.push({ ...attempt, costCents: receipt.costCents, costMetadata: receipt.metadata });
  }
  const costCents = attempts.reduce((sum, attempt) => sum + attempt.costCents!, 0);
  return { ...metadata, visionAttempts: attempts,
    ...(Array.isArray(metadata.attempts) ? { attempts } : {}),
    originalProviderCostCents: metadata.originalProviderCostCents ?? metadata.providerCostCents,
    providerCostCents: costCents, providerCostUsd: costCents / 100,
    costSource: "provider", reconciliationRequired: false, accountingStatus: "reconciled" };
}

/** Explicit tenant scope and compare-and-swap prevent cross-tenant or concurrent overwrite. */
export async function reconcileVisionReceipts(args: {
  client: Sql; orgId: string; projectId: string; apiKey: string;
}): Promise<number> {
  if (!args.orgId || !args.projectId) throw new Error("Receipt reconciliation requires tenant scope");
  const rows = await args.client`
    select id, model, metadata from usage_events
    where org_id = ${args.orgId} and project_id = ${args.projectId}
      and provider = 'openrouter'
      and (metadata ? 'visionAttempts' or metadata ? 'attempts')
      and metadata->>'accountingStatus' is distinct from 'reconciled'
    order by created_at asc limit 100`;
  let updated = 0;
  for (const row of rows) {
    const metadata = await reconcileVisionReceiptMetadata(row.metadata, row.model, args.apiKey);
    if (!metadata) continue;
    const result = await args.client`
      update usage_events set metadata = ${args.client.json(metadata as JSONValue)}
      where id = ${row.id} and org_id = ${args.orgId} and project_id = ${args.projectId}
        and metadata = ${args.client.json(row.metadata)} returning id`;
    updated += result.length;
  }
  return updated;
}
