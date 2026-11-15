import type { TransactionSql } from "postgres";
import { countedPagesForForecast } from "@docslurp/shared";
import { buildRunProcessingPreview } from "./run-processing-preview.js";

/** Organization before run: a reactivation must not invert admission's lock order. */
export async function lockRunReadmission(tx: TransactionSql, runId: string): Promise<void> {
  const [scope] = await tx`select org_id, project_id from project_runs where id=${runId}`;
  if (!scope) return;
  await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${scope.org_id}))`;
  const [locked] = await tx`select id from project_runs where id=${runId} and org_id=${scope.org_id} and project_id=${scope.project_id} for update`;
  if (!locked) throw new Error("Run billing scope changed during readmission");
}

/** Reprice unfinished measured work before the status update invokes the strict capacity trigger. */
export async function restoreRunMonthlyCapacity(tx: TransactionSql, runId: string): Promise<void> {
  const [run] = await tx`select * from project_runs where id=${runId}`;
  if (!run || ["queued", "processing"].includes(run.status)) return;
  const docs = await tx`select filename,mime_type,file_size,page_count,billing_pages,page_count_source
    from documents where run_id=${runId} and org_id=${run.org_id} and project_id=${run.project_id}
      and superseded_at is null and status not in ('completed','cancelled')`;
  let forecast: number;
  if (docs.length) {
    const files = docs.map(doc => {
      const pages = countedPagesForForecast({ pageCount: doc.page_count, billingPages: doc.billing_pages, pageCountSource: doc.page_count_source });
      const sizeBytes = Number(doc.file_size);
      if (!(Number.isSafeInteger(pages) && (pages ?? 0)>0) && !(Number.isFinite(sizeBytes) && sizeBytes>0)) {
        throw new Error("Monthly readmission requires measured positive workload evidence");
      }
      return { filename: doc.filename, mimeType: doc.mime_type, sizeBytes: Number.isFinite(sizeBytes) && sizeBytes>0 ? sizeBytes : 0, ...(pages ? {pages} : {}) };
    });
    forecast = buildRunProcessingPreview({ request: { project: run.project_id, pipeline: run.pipeline, urls: [], files } }).current.estimatedCost.maxCents;
  } else {
    // An explicitly declared durable forecast remains evidence for document-free jobs.
    // Missing/zero legacy reservations are never replaced by an invented one-cent workload.
    forecast = Number(run.monthly_reservation_cents);
    if (!Number.isFinite(forecast) || forecast<1) throw new Error("Monthly readmission requires measured positive workload evidence");
  }
  if (!Number.isFinite(forecast) || forecast < 0) throw new Error("Invalid monthly readmission forecast");
  // Capacity includes historical charges because pending_monthly_capacity subtracts them.
  await tx`update project_runs set monthly_reservation_cents=(
    select coalesce(sum(cost_cents),0) from usage_attribution where source_run_id=${runId} and org_id=${run.org_id}
  ) + ${Math.max(1, forecast)} where id=${runId} and org_id=${run.org_id} and project_id=${run.project_id}`;
}
