import type { TransactionSql } from "postgres";
import { countedPagesForForecast, type PipelineFeatures } from "@docslurp/shared";
import { buildRunProcessingPreview } from "./run-processing-preview.js";
import { remainingMaterializationForecast } from "./materialization-capacity.js";

type ReadmissionRun = { id: string; kind: string; org_id: string; project_id: string; status: string;
  pipeline: PipelineFeatures; stats: unknown; total_documents: number; pages_total: number };

/** Organization before run: a reactivation must not invert admission's lock order. */
export async function lockRunReadmission(tx: TransactionSql, runId: string): Promise<void> {
  const [scope] = await tx`select org_id, project_id from project_runs where id=${runId}`;
  if (!scope) return;
  await tx`select pg_advisory_xact_lock(spend_admission_lock_key(${scope.org_id}))`;
  const [locked] = await tx`select id from project_runs where id=${runId} and org_id=${scope.org_id} and project_id=${scope.project_id} for update`;
  if (!locked) throw new Error("Run billing scope changed during readmission");
}

/** Reprice unfinished measured work under the org/run locks before clearing a pause or queuing work. */
export async function restoreRunMonthlyCapacity(tx: TransactionSql, runId: string): Promise<void> {
  const [run] = await tx<ReadmissionRun[]>`select * from project_runs where id=${runId}`;
  if (!run) throw new Error("Run missing during monthly readmission");
  const forecast = run.kind === "materialize"
    ? await remainingMaterializationForecast(tx, run)
    : await unfinishedDocumentForecast(tx, runId, run);
  if (!Number.isFinite(forecast) || forecast < 0) throw new Error("Invalid monthly readmission forecast");
  // The view subtracts lifetime charges, including past months. Existing verified
  // remaining coverage is reusable: reserve only a shortfall, never charge it twice.
  await tx`update project_runs set monthly_reservation_cents=greatest(
    case when status in ('queued','processing') then monthly_reservation_cents else 0 end, (
    select coalesce(sum(cost_cents),0) from usage_attribution where source_run_id=${runId} and org_id=${run.org_id}
  ) + ${Math.max(1, forecast)}) where id=${runId} and org_id=${run.org_id} and project_id=${run.project_id}`;
}

async function unfinishedDocumentForecast(tx: TransactionSql, runId: string, run: ReadmissionRun): Promise<number> {
  const docs = await tx`select filename,mime_type,file_size,page_count,billing_pages,page_count_source
    from documents where run_id=${runId} and org_id=${run.org_id} and project_id=${run.project_id}
      and superseded_at is null and status not in ('completed','cancelled')
      and (${run.status} <> 'completed' or status='failed')`;
  if (!docs.length) throw new Error("Monthly readmission requires measured positive workload evidence");
  const files = docs.map(doc => {
    const pages = countedPagesForForecast({
      pageCount: doc.page_count, billingPages: doc.billing_pages, pageCountSource: doc.page_count_source,
    });
    const sizeBytes = Number(doc.file_size);
    if (!(Number.isSafeInteger(pages) && (pages ?? 0) > 0) && !(Number.isFinite(sizeBytes) && sizeBytes > 0)) {
      throw new Error("Monthly readmission requires measured positive workload evidence");
    }
    return {
      filename: doc.filename, mimeType: doc.mime_type,
      sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
      ...(pages ? { pages } : {}),
    };
  });
  return buildRunProcessingPreview({
    request: { project: run.project_id, pipeline: run.pipeline, speedBoost: run.pipeline?.speedBoost === true, urls: [], files },
  }).current.estimatedCost.maxCents;
}
