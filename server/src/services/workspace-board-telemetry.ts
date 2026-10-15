import {
  workspaceBoardSummarySchema,
  type WorkspaceBoardSummary,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { attributedUsage } from "./usage-attribution.js";

export type WorkspaceBoardSummaryRow = {
  workspace_id: string;
  activity?: { date: string; tokens: number }[];
  activity_max_tokens?: number | string;
  search_result_count?: number | string;
  zero_result_searches?: number | string;
  average_search_ms?: number | string | null;
  compute_cost_cents?: number | string;
  base_fee_cost_cents?: number | string;
  total_documents: number;
  total_pages: number;
  source_bytes?: number | string;
  processed_pages: number;
  completed_runs: number;
  indexed_bytes: number | string;
  avg_completed_run_ms: number;
  completed_run_pages?: number | string;
  completed_run_ms?: number | string;
  search_sessions: number;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
  total_embedding_tokens: number | string;
  total_llm_cost_cents: number | string;
  ingest_input_tokens?: number | string;
  ingest_output_tokens?: number | string;
  ingest_embedding_tokens?: number | string;
  ingest_cost_cents?: number | string;
  search_input_tokens?: number | string;
  search_output_tokens?: number | string;
  search_embedding_tokens?: number | string;
  search_cost_cents?: number | string;
};

export function parseTelemetryAggregateInt(value: number | string | null | undefined): number {
  const normalized = typeof value === "number" ? value : Number(value ?? 0);

  if (!Number.isFinite(normalized)) {
    throw new Error(`Expected numeric aggregate, received ${JSON.stringify(value)}`);
  }

  return normalized;
}

export function mapWorkspaceBoardSummary(row?: WorkspaceBoardSummaryRow | null): WorkspaceBoardSummary {
  // Spend comes only from usage_attribution. The run row's cost columns are the
  // worker's run-cap accumulator (no stage compute), so they are no fallback.
  const ingestCostCents = parseTelemetryAggregateInt(row?.ingest_cost_cents);
  const recordedCostCents = ingestCostCents + parseTelemetryAggregateInt(row?.search_cost_cents);
  const computeCostCents = parseTelemetryAggregateInt(row?.compute_cost_cents);
  const processedPages = parseTelemetryAggregateInt(row?.processed_pages);
  const completedRunPages = parseTelemetryAggregateInt(row?.completed_run_pages);
  const completedRunMs = parseTelemetryAggregateInt(row?.completed_run_ms);
  // Ingest spend: recorded ingest charges plus the unbilled worker-compute estimate.
  const ingestTotalCostCents = ingestCostCents + computeCostCents;
  return workspaceBoardSummarySchema.parse({
    ...(row?.activity ? { activity: row.activity, activityMaxTokens: parseTelemetryAggregateInt(row.activity_max_tokens) } : {}),
    searchResultCount: parseTelemetryAggregateInt(row?.search_result_count),
    zeroResultSearches: parseTelemetryAggregateInt(row?.zero_result_searches),
    averageSearchMs: row?.average_search_ms == null ? null : parseTelemetryAggregateInt(row.average_search_ms),
    totalCostCents: recordedCostCents + computeCostCents,
    recordedCostCents,
    computeCostCents,
    baseFeeCostCents: parseTelemetryAggregateInt(row?.base_fee_cost_cents),
    totalDocuments: parseTelemetryAggregateInt(row?.total_documents),
    totalPages: parseTelemetryAggregateInt(row?.total_pages),
    sourceBytes: parseTelemetryAggregateInt(row?.source_bytes),
    processedPages,
    completedRuns: parseTelemetryAggregateInt(row?.completed_runs),
    indexedBytes: parseTelemetryAggregateInt(row?.indexed_bytes),
    avgCompletedRunMs: parseTelemetryAggregateInt(row?.avg_completed_run_ms),
    completedRunPages,
    completedRunMs,
    ingestTotalCostCents,
    pagesPerMinute: completedRunPages > 0 && completedRunMs > 0 ? completedRunPages / (completedRunMs / 60_000) : null,
    pagesPerDollar: processedPages > 0 && ingestTotalCostCents > 0 ? (processedPages * 100) / ingestTotalCostCents : null,
    computeEstimated: computeCostCents > 0,
    searchSessions: parseTelemetryAggregateInt(row?.search_sessions),
    totalInputTokens: parseTelemetryAggregateInt(row?.total_input_tokens),
    totalOutputTokens: parseTelemetryAggregateInt(row?.total_output_tokens),
    totalEmbeddingTokens: parseTelemetryAggregateInt(row?.total_embedding_tokens),
    totalLlmCostCents: parseTelemetryAggregateInt(row?.total_llm_cost_cents),
    ingestInputTokens: parseTelemetryAggregateInt(row?.ingest_input_tokens),
    ingestOutputTokens: parseTelemetryAggregateInt(row?.ingest_output_tokens),
    ingestEmbeddingTokens: parseTelemetryAggregateInt(row?.ingest_embedding_tokens),
    ingestCostCents,
    searchInputTokens: parseTelemetryAggregateInt(row?.search_input_tokens),
    searchOutputTokens: parseTelemetryAggregateInt(row?.search_output_tokens),
    searchEmbeddingTokens: parseTelemetryAggregateInt(row?.search_embedding_tokens),
    searchCostCents: parseTelemetryAggregateInt(row?.search_cost_cents),
  });
}

export async function listWorkspaceBoardSummaries(
  workspaceIds: string[],
): Promise<Map<string, WorkspaceBoardSummary>> {
  if (workspaceIds.length === 0) {
    return new Map();
  }

  const rows = await sql<WorkspaceBoardSummaryRow[]>`
    with requested_workspaces as (
      select jsonb_array_elements_text(${sql.json(workspaceIds)}::jsonb) as id
    ), normalized_search_sessions as (
      select id, result_count, case when jsonb_typeof(metadata) = 'string'
        then (metadata #>> '{}')::jsonb else metadata end as metadata
      from search_sessions
    ), document_summary as (
      -- Current corpus (completed, not superseded) from trigger-maintained counters.
      select
        cs.workspace_id,
        cs.document_count::int as total_documents,
        cs.page_count::int as total_pages,
        cs.source_bytes::double precision as source_bytes
      from workspace_corpus_stats cs
      where cs.workspace_id in (select id from requested_workspaces)
    ),
    run_summary as (
      select
        r.workspace_id,
        count(*) filter (where r.status = 'completed')::int as completed_runs,
        coalesce(sum(r.pages_processed), 0)::int as processed_pages,
        -- Completed runs only: a failed run's wall time says nothing about throughput.
        coalesce(
          avg(extract(epoch from (r.updated_at - r.created_at)) * 1000)
          filter (where r.status = 'completed'),
          0
        )::int as avg_completed_run_ms,
        coalesce(sum(r.pages_processed) filter (where r.status = 'completed'), 0)::int as completed_run_pages,
        coalesce(
          sum(extract(epoch from (r.updated_at - r.created_at)) * 1000)
          filter (where r.status = 'completed'),
          0
        )::double precision as completed_run_ms
      from workspace_runs r
      where r.workspace_id in (select id from requested_workspaces)
      group by r.workspace_id
    ),
    chunk_bytes as (
      select
        docs.workspace_id,
        coalesce(sum(octet_length(c.text)), 0)::bigint as chunk_bytes
      from documents docs
      join document_chunks c on c.document_id = docs.id
      where docs.workspace_id in (select id from requested_workspaces)
        and docs.status = 'completed'
        and docs.superseded_at is null
      group by docs.workspace_id
    ),
    page_bytes as (
      select
        docs.workspace_id,
        coalesce(sum(octet_length(p.text)), 0)::bigint as page_bytes
      from documents docs
      join document_pages p on p.document_id = docs.id
      where docs.workspace_id in (select id from requested_workspaces)
        and docs.status = 'completed'
        and docs.superseded_at is null
      group by docs.workspace_id
    ),
    search_summary as (
      select
        s.metadata ->> 'workspaceId' as workspace_id,
        count(*)::int as search_sessions,
        coalesce(sum(s.result_count), 0)::int as search_result_count,
        count(*) filter (where s.result_count = 0)::int as zero_result_searches,
        avg((s.metadata ->> 'durationMs')::double precision) as average_search_ms
      from normalized_search_sessions s
      where s.metadata ->> 'workspaceId' in (select id from requested_workspaces)
      group by s.metadata ->> 'workspaceId'
    ),
    usage_workspace_scope as (
      select
        au.workspace_id,
        au.source_kind,
        au.created_at,
        au.metric,
        au.provider,
        au.metadata,
        au.input_tokens,
        au.output_tokens,
        au.cost_cents
      from ${attributedUsage(null)} au
      where au.workspace_id in (select id from requested_workspaces)
    ),
    activity_days as (
      select generate_series((now() at time zone 'UTC')::date - 29,
        (now() at time zone 'UTC')::date, interval '1 day')::date as day
    ), activity_daily as (
      select workspace_id, (created_at at time zone 'UTC')::date as day,
        sum(input_tokens::bigint + output_tokens::bigint)::double precision as tokens
      from usage_workspace_scope
      where created_at >= (((now() at time zone 'UTC')::date - 29) at time zone 'UTC')
      group by workspace_id, (created_at at time zone 'UTC')::date
    ), activity_summary as (
      select w.id as workspace_id,
        jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'),
          'tokens', coalesce(a.tokens, 0)) order by d.day) as activity
      from requested_workspaces w cross join activity_days d
      left join activity_daily a on a.workspace_id = w.id and a.day = d.day
      group by w.id
    ), token_summary as (
      select
        usage_workspace_scope.workspace_id,
        -- Unbilled worker compute is stored at 0 cents with its rate-card
        -- estimate in effectiveCostCents. Billed compute is already in cost_cents.
        coalesce(sum((metadata ->> 'effectiveCostCents')::numeric) filter (
          where provider = 'local-compute' and metadata ->> 'costRollup' = 'authoritative'
            and coalesce(metadata ->> 'billable', 'false') <> 'true'
        ), 0)::double precision as compute_cost_cents,
        coalesce(sum(cost_cents) filter (where metric = 'page-base-fee'), 0)::double precision as base_fee_cost_cents,
        coalesce(sum(input_tokens) filter (where not (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as input_tokens,
        coalesce(sum(output_tokens) filter (where not (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as output_tokens,
        coalesce(sum(input_tokens) filter (where metric like '%embedding%' or metric like 'embed-%'), 0)::bigint as embedding_tokens,
        coalesce(sum(cost_cents) filter (where provider not in ('local-compute', 'docslurp') and not (metric like '%embedding%' or metric like 'embed-%')), 0)::double precision as llm_cost_cents,
        coalesce(sum(input_tokens) filter (where source_kind = 'ingest' and not (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as ingest_input_tokens,
        coalesce(sum(output_tokens) filter (where source_kind = 'ingest' and not (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as ingest_output_tokens,
        coalesce(sum(input_tokens) filter (where source_kind = 'ingest' and (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as ingest_embedding_tokens,
        coalesce(sum(cost_cents) filter (where source_kind = 'ingest'), 0)::double precision as ingest_cost_cents,
        coalesce(sum(input_tokens) filter (where source_kind = 'search' and not (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as search_input_tokens,
        coalesce(sum(output_tokens) filter (where source_kind = 'search' and not (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as search_output_tokens,
        coalesce(sum(input_tokens) filter (where source_kind = 'search' and (metric like '%embedding%' or metric like 'embed-%')), 0)::bigint as search_embedding_tokens,
        coalesce(sum(cost_cents) filter (where source_kind = 'search'), 0)::double precision as search_cost_cents
      from usage_workspace_scope
      group by usage_workspace_scope.workspace_id
    )
    select
      w.id as workspace_id,
      acts.activity,
      (select coalesce(max(tokens), 0) from activity_daily) as activity_max_tokens,
      coalesce(ds.total_documents, 0)::int as total_documents,
      coalesce(ds.total_pages, 0)::int as total_pages,
      coalesce(ds.source_bytes, 0)::double precision as source_bytes,
      coalesce(rs.processed_pages, 0)::int as processed_pages,
      coalesce(rs.completed_runs, 0)::int as completed_runs,
      (coalesce(cb.chunk_bytes, 0) + coalesce(pb.page_bytes, 0))::bigint as indexed_bytes,
      coalesce(rs.avg_completed_run_ms, 0)::int as avg_completed_run_ms,
      coalesce(rs.completed_run_pages, 0)::int as completed_run_pages,
      coalesce(rs.completed_run_ms, 0)::double precision as completed_run_ms,
      coalesce(ss.search_sessions, 0)::int as search_sessions,
      coalesce(ss.search_result_count, 0)::int as search_result_count,
      coalesce(ss.zero_result_searches, 0)::int as zero_result_searches,
      ss.average_search_ms,
      coalesce(ts.compute_cost_cents, 0)::double precision as compute_cost_cents,
      coalesce(ts.base_fee_cost_cents, 0)::double precision as base_fee_cost_cents,
      coalesce(ts.input_tokens, 0)::bigint as total_input_tokens,
      coalesce(ts.output_tokens, 0)::bigint as total_output_tokens,
      coalesce(ts.embedding_tokens, 0)::bigint as total_embedding_tokens,
      coalesce(ts.llm_cost_cents, 0)::double precision as total_llm_cost_cents,
      coalesce(ts.ingest_input_tokens, 0)::bigint as ingest_input_tokens,
      coalesce(ts.ingest_output_tokens, 0)::bigint as ingest_output_tokens,
      coalesce(ts.ingest_embedding_tokens, 0)::bigint as ingest_embedding_tokens,
      coalesce(ts.ingest_cost_cents, 0)::double precision as ingest_cost_cents,
      coalesce(ts.search_input_tokens, 0)::bigint as search_input_tokens,
      coalesce(ts.search_output_tokens, 0)::bigint as search_output_tokens,
      coalesce(ts.search_embedding_tokens, 0)::bigint as search_embedding_tokens,
      coalesce(ts.search_cost_cents, 0)::double precision as search_cost_cents
    from workspaces w
    left join activity_summary acts on acts.workspace_id = w.id
    left join document_summary ds on ds.workspace_id = w.id
    left join run_summary rs on rs.workspace_id = w.id
    left join chunk_bytes cb on cb.workspace_id = w.id
    left join page_bytes pb on pb.workspace_id = w.id
    left join search_summary ss on ss.workspace_id = w.id
    left join token_summary ts on ts.workspace_id = w.id
    where w.id in (select id from requested_workspaces)
  `;

  return new Map(rows.map((row) => [row.workspace_id, mapWorkspaceBoardSummary(row)]));
}

export const emptyWorkspaceBoardSummary = mapWorkspaceBoardSummary(null);
