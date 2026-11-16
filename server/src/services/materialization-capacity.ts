import type { TransactionSql } from "postgres";
import { z } from "zod";
import { BILLABLE_UNIT_METRICS, pageCredits, speedBoostMultiplier } from "@docslurp/shared";

// Matches the public per-query bounds. The snapshot is API-authored, never a
// substitute for checking that the current source still belongs to this scope.
const pagesSchema = z.array(z.number().int().positive()).min(1).max(2000)
  .refine(pages => new Set(pages).size === pages.length, "Duplicate materialization pages");
const planSchema = z.object({
  version: z.literal(1), orgId: z.string().min(1), projectId: z.string().min(1),
  documentId: z.string().min(1), sourceRunId: z.string().nullable(), sourceKey: z.string().min(1),
  sourceSha256: z.string().nullable(), generation: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(), pages: pagesSchema,
  maxCredits: z.number().finite().positive().max(100000),
}).strict();
export type MaterializationPlan = z.infer<typeof planSchema>;
type Scope = { orgId: string; projectId: string; documentId: string };

/** Read and pin the current source in the same transaction as admission. */
export async function materializationSource(tx: TransactionSql, scope: Scope) {
  const [source] = await tx`select d.run_id,d.source_key,d.source_sha256,d.materialization_generation,d.page_count
    from documents d join projects p on p.id=d.project_id and p.org_id=d.org_id
    where d.id=${scope.documentId} and d.org_id=${scope.orgId} and d.project_id=${scope.projectId}
      and d.superseded_at is null and not d.source_materialization_blocked
      and d.status not in ('failed','cancelled') and p.archived_at is null
      and (d.run_id is null or exists(select 1 from project_runs r
        where r.id=d.run_id and r.org_id=d.org_id and r.project_id=d.project_id))
    for share of d`;
  if (!source || !Number.isSafeInteger(source.page_count) || source.page_count < 1 || !source.source_key) {
    throw new Error("Materialization requires a current scoped source and positive page bounds");
  }
  return source;
}

export async function createMaterializationPlan(tx: TransactionSql, args: Scope & {
  documents: number; pages: number; pageNumbers?: number[]; maxCredits: number;
}): Promise<MaterializationPlan> {
  const pages = pagesSchema.parse(args.pageNumbers);
  if (args.documents !== 1 || args.pages !== pages.length) throw new Error("Invalid bounded materialization workload");
  const source = await materializationSource(tx, args);
  const plan = planSchema.parse({ version: 1, orgId: args.orgId, projectId: args.projectId, documentId: args.documentId,
    sourceRunId: source.run_id, sourceKey: source.source_key, sourceSha256: source.source_sha256,
    generation: source.materialization_generation, pageCount: source.page_count,
    pages: [...pages].sort((a, b) => a - b), maxCredits: args.maxCredits });
  if (plan.pages.some(page => page > plan.pageCount)) throw new Error("Materialization page outside source bounds");
  return plan;
}

export function materializationForecast(pages: number, remainingCredits: number, boost: boolean): number {
  const multiplier = speedBoostMultiplier(boost);
  const pageFloor = pageCredits("rich", pages) * multiplier;
  if (!Number.isFinite(pageFloor) || pageFloor < 0 || !Number.isFinite(remainingCredits) || remainingCredits < 0) {
    throw new Error("Invalid materialization capacity pricing");
  }
  const forecast = Math.max(remainingCredits, pageFloor);
  if (!Number.isFinite(forecast) || forecast < 0) throw new Error("Invalid materialization capacity forecast");
  return Math.max(1, Math.ceil(forecast));
}

/** Reconcile a persisted bounded workflow against its current source and page ledger. */
export async function remainingMaterializationForecast(tx: TransactionSql, run: {
  id: string; org_id: string; project_id: string; stats: unknown; pipeline: { speedBoost?: boolean }; total_documents: number; pages_total: number;
}): Promise<number> {
  const stats = z.object({ materialization: planSchema }).passthrough().parse(run.stats);
  const plan = stats.materialization;
  if (plan.orgId !== run.org_id || plan.projectId !== run.project_id || run.total_documents !== 1 || run.pages_total !== plan.pages.length) {
    throw new Error("Materialization plan billing scope mismatch");
  }
  const source = await materializationSource(tx, plan);
  if (source.run_id !== plan.sourceRunId || source.source_key !== plan.sourceKey || source.source_sha256 !== plan.sourceSha256
    || source.materialization_generation !== plan.generation || source.page_count !== plan.pageCount
    || plan.pages.some(page => page > source.page_count)) throw new Error("Materialization source changed since admission");
  // Indexed query pages without a committed fee may still need billing on
  // replay. Exclude only final pages whose state/attributed decision proves it.
  const [work] = await tx`select count(*)::int as pages from unnest(${tx.array(plan.pages,23)}) target(page)
    left join document_page_states s on s.document_id=${plan.documentId} and s.page_number=target.page
    where s.state is distinct from 'blocked-pii' and not coalesce(s.state='indexed' and (
      s.materialized_by in ('ingest','full-index') or exists(select 1 from usage_attribution u
        where u.org_id=${run.org_id} and u.project_id=${run.project_id}
          and u.source_run_id in (s.fee_billed_run,s.read_billed_run)
          and u.metric in (${BILLABLE_UNIT_METRICS.fastPage},${BILLABLE_UNIT_METRICS.richPage})
          and u.metadata->>'documentId'=${plan.documentId}
          and coalesce(u.metadata->>'pageNumber',u.metadata->>'page')=target.page::text)),false)`;
  if (!work || work.pages < 1) throw new Error("Materialization has no unfinished bounded page work");
  const [usage] = await tx`select coalesce(sum(cost_cents),0) as cents from usage_attribution
    where source_run_id=${run.id} and org_id=${run.org_id}`;
  const consumed = Number(usage!.cents);
  if (!Number.isFinite(consumed) || consumed < 0) throw new Error("Invalid materialization attributed usage");
  return materializationForecast(work.pages, Math.max(0, plan.maxCredits * speedBoostMultiplier(run.pipeline.speedBoost) - consumed), run.pipeline.speedBoost === true);
}
