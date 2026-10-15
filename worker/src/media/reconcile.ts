import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { emitTelemetryLog } from "./telemetry.js";
export interface ReconciliationEvidence { providerRequestId: string; costNanoUsd: number; reference: string; actor: string; }
/** Exact request evidence only. Aggregate monthly totals must never enter this path.
 * Adjusting a customer debit requires a billing correction workflow; this tool
 * releases exposure only when the verified cost equals the recorded estimate.
 */
export async function reconcileMediaReceipt(sql: Sql<Record<string, unknown>>, id: string, evidence: ReconciliationEvidence, apply=false) {
  if (!id || !evidence.providerRequestId || !Number.isSafeInteger(evidence.costNanoUsd) || evidence.costNanoUsd < 0 ||
    !evidence.reference?.trim() || evidence.reference.length>500 || !evidence.actor?.trim() || evidence.actor.length>200) throw new Error("Complete request-level reconciliation evidence required");
  return await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended('docslurp:remote-media-admission',0))`;
    const [row]=await tx`select * from remote_media_jobs where id=${id} for update`;
    if (!row || row.status !== "completed" || !row.usage_settled || row.accounting?.providerRequestId !== evidence.providerRequestId) throw new Error("Receipt is not a settled matching request; keep exposure reserved");
    if (Math.round(Number(row.cost_cents)*1e7) !== evidence.costNanoUsd) throw new Error("Verified charge differs: billing correction required; exposure retained");
    const hash=createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
    const [old]=await tx`select evidence_sha256 from media_reconciliation_actions where receipt_id=${id}`;
    if (old && old.evidence_sha256!==hash) throw new Error("Conflicting reconciliation evidence");
    if (apply && !old) {
      await tx`insert into media_reconciliation_actions(receipt_id,evidence_sha256,evidence_reference,actor,verified_cost_nano_usd)
        values (${id},${hash},${evidence.reference},${evidence.actor},${evidence.costNanoUsd})`;
      await tx`update remote_media_jobs set cost_state='reconciled', exposure_released=true, pricing_uncertain=false,
        accounting=jsonb_set(accounting,'{state}','"reconciled"'::jsonb),updated_at=now() where id=${id}`;
      emitTelemetryLog({severityText:"info",body:"media.receipt.reconciled",attributes:{mediaJobId:id,providerRequestId:evidence.providerRequestId,costState:"reconciled"}});
    }
    return {receiptId:id,apply,alreadyReconciled:Boolean(old),costNanoUsd:evidence.costNanoUsd};
  });
}
