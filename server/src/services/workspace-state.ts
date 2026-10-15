import type { WorkspaceState } from "@docslurp/shared";
import { sql, type SqlClient } from "../db.js";
import { attributedUsage } from "./usage-attribution.js";

export type WorkspaceStateRow = Record<string, unknown>;

function number(value: unknown): number {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}
function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function distribution(row: WorkspaceStateRow, prefix: string) {
  return { sampleCount: number(row[`${prefix}_samples`]), p50: nullableNumber(row[`${prefix}_p50`]), p95: nullableNumber(row[`${prefix}_p95`]), max: nullableNumber(row[`${prefix}_max`]) };
}
export function mapWorkspaceState(row: WorkspaceStateRow, args: { workspaceId: string; orgId: string; recentWindowHours: number }): WorkspaceState {
  const observedAt = new Date(String(row.observed_at)).toISOString();
  const total = number(row.total_pages);
  const indexed = Math.min(total, number(row.indexed_pages));
  const sourceBytes = number(row.source_bytes);
  const textBytes = number(row.text_bytes);
  const completedPages = number(row.completed_pages);
  const runtimeMs = number(row.run_duration_total_ms);
  const pagesPerMinute = runtimeMs > 0 && completedPages > 0 ? completedPages * 60_000 / runtimeMs : null;
  return {
    workspaceId: args.workspaceId, orgId: args.orgId, observedAt,
    recentWindow: { from: new Date(Date.parse(observedAt) - args.recentWindowHours * 3_600_000).toISOString(), to: observedAt, hours: args.recentWindowHours },
    documents: { total: number(row.total_documents), queued: number(row.queued_documents), processing: number(row.processing_documents), completed: number(row.completed_documents), failed: number(row.failed_documents), unknownPageCount: number(row.unknown_page_count_documents) },
    pages: { total, indexed, notIndexed: total - indexed, basis: "text-searchable-unique-pages" },
    storage: { sourceBytes, sourceMb: sourceBytes / 1_000_000, textBytes, textMb: textBytes / 1_000_000, documentsWithUnknownSize: number(row.unknown_size_documents), vectorBytes: null, artifactBytes: null, mbDivisor: 1_000_000 },
    runs: { total: number(row.total_runs), queued: number(row.queued_runs), processing: number(row.processing_runs), completed: number(row.completed_runs), failed: number(row.failed_runs) },
    searches: { total: number(row.total_searches), recentCount: number(row.recent_searches), recentZeroResultCount: number(row.recent_zero_result_searches), latencyMs: distribution(row, "search") },
    performance: { completedRuns: number(row.recent_completed_runs), failedRuns: number(row.recent_failed_runs), completedPages, durationMs: distribution(row, "run"), pagesPerMinute, minutesPer100Pages: pagesPerMinute === null ? null : 100 / pagesPerMinute, basis: "run-wall-time-including-queue" },
    usage: { inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens), costCents: number(row.cost_cents) },
  };
}

/** Caller must establish current workspace access before querying aggregate state. */
export async function getWorkspaceState(args: { workspaceId: string; orgId: string; recentWindowHours: number }, client: SqlClient = sql): Promise<WorkspaceState> {
  const [row] = await client<WorkspaceStateRow[]>`
    with clock as (select statement_timestamp() as observed_at),
    -- Current corpus: completed documents not superseded by a newer version.
    docs as (select * from documents where workspace_id = ${args.workspaceId} and status = 'completed' and superseded_at is null),
    page_evidence as (
      select p.document_id, p.page_number from document_pages p join docs d on d.id = p.document_id and d.run_id = p.run_id
        where length(trim(p.text)) > 0
      union
      select c.document_id, coalesce(c.page_number, p.page_number) from document_chunks c
        join docs d on d.id = c.document_id and d.run_id = c.run_id
        left join document_pages p on p.id = c.parent_page_id and p.document_id = c.document_id and p.run_id = c.run_id
        where length(trim(c.text)) > 0
    ),
    valid_pages as (
      select distinct e.document_id, e.page_number from page_evidence e join docs d on d.id = e.document_id
      where e.page_number > 0 and e.page_number <= d.page_count
    ),
    -- In-flight ingest reads only the documents_workspace_in_flight_idx partial index;
    -- any non-terminal status (queued or a stage name) is queued/processing.
    in_flight as (
      select status from documents
      where workspace_id = ${args.workspaceId} and status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
    ),
    document_summary as (
      select coalesce(cs.document_count, 0) as total_documents,
        coalesce(cs.document_count, 0) as completed_documents,
        coalesce(cs.page_count, 0) as total_pages,
        coalesce(cs.source_bytes, 0) as source_bytes,
        (select count(*) from in_flight where status = 'queued') as queued_documents,
        (select count(*) from in_flight where status <> 'queued') as processing_documents,
        (select count(*) from documents f where f.workspace_id = ${args.workspaceId} and f.status = 'failed' and f.superseded_at is null) as failed_documents,
        (select count(*) from docs where page_count <= 0) as unknown_page_count_documents,
        (select count(*) from docs where file_size = 0 and coalesce(metadata ->> 'sourceSizeMeasured', 'false') <> 'true') as unknown_size_documents
      from (select 1) one
      left join workspace_corpus_stats cs on cs.workspace_id = ${args.workspaceId}
    ),
    text_summary as (
      select coalesce((select sum(octet_length(p.text)) from document_pages p join docs d on d.id = p.document_id and d.run_id = p.run_id), 0)
        + coalesce((select sum(octet_length(c.text)) from document_chunks c join docs d on d.id = c.document_id and d.run_id = c.run_id), 0) as text_bytes
    ),
    runs as (
      select r.*, extract(epoch from (r.updated_at - r.created_at)) * 1000 as duration_ms,
        r.updated_at >= clock.observed_at - (${args.recentWindowHours} * interval '1 hour') as recent
      from workspace_runs r cross join clock where r.workspace_id = ${args.workspaceId}
    ),
    run_summary as (
      select count(*) as total_runs,
        count(*) filter (where status = 'queued') as queued_runs,
        count(*) filter (where status = 'processing') as processing_runs,
        count(*) filter (where status = 'completed') as completed_runs,
        count(*) filter (where status = 'failed') as failed_runs,
        count(*) filter (where recent and status = 'completed') as recent_completed_runs,
        count(*) filter (where recent and status = 'failed') as recent_failed_runs,
        coalesce(sum(greatest(pages_processed, 0)) filter (where recent and status = 'completed' and duration_ms > 0), 0) as completed_pages,
        coalesce(sum(duration_ms) filter (where recent and status = 'completed' and duration_ms > 0), 0) as run_duration_total_ms,
        count(*) filter (where recent and status = 'completed' and duration_ms > 0) as run_samples,
        percentile_cont(0.5) within group (order by duration_ms) filter (where recent and status = 'completed' and duration_ms > 0) as run_p50,
        percentile_cont(0.95) within group (order by duration_ms) filter (where recent and status = 'completed' and duration_ms > 0) as run_p95,
        max(duration_ms) filter (where recent and status = 'completed' and duration_ms > 0) as run_max
      from runs
    ),
    search_metadata as (
      select s.*, case when jsonb_typeof(metadata) = 'string' and pg_input_is_valid(metadata #>> '{}', 'jsonb') then (metadata #>> '{}')::jsonb else metadata end as normalized_metadata
      from search_sessions s
    ),
    searches as (
      select s.*, s.created_at >= clock.observed_at - (${args.recentWindowHours} * interval '1 hour') as recent,
        case when jsonb_typeof(s.normalized_metadata -> 'durationMs') = 'number' then
          case when (s.normalized_metadata ->> 'durationMs')::numeric >= 0
            then (s.normalized_metadata ->> 'durationMs')::numeric end end as duration_ms
      from search_metadata s cross join clock
      where s.normalized_metadata ->> 'workspaceId' = ${args.workspaceId}
        or (s.normalized_metadata -> 'workspaceIds') @> ${client.json([args.workspaceId])}::jsonb
    ),
    search_summary as (
      select count(*) as total_searches, count(*) filter (where recent) as recent_searches,
        count(*) filter (where recent and result_count = 0) as recent_zero_result_searches,
        count(duration_ms) filter (where recent) as search_samples,
        percentile_cont(0.5) within group (order by duration_ms) filter (where recent) as search_p50,
        percentile_cont(0.95) within group (order by duration_ms) filter (where recent) as search_p95,
        max(duration_ms) filter (where recent) as search_max from searches
    ),
    usage_summary as (
      select coalesce(sum(input_tokens), 0) as input_tokens, coalesce(sum(output_tokens), 0) as output_tokens,
        coalesce(sum(cost_cents), 0) as cost_cents from ${attributedUsage(null, client)} au where au.workspace_id = ${args.workspaceId}
    )
    select clock.observed_at::text, ds.*, ts.*, rs.*, ss.*, us.*,
      (select count(*) from valid_pages) as indexed_pages
    from clock cross join document_summary ds cross join text_summary ts cross join run_summary rs cross join search_summary ss cross join usage_summary us
  `;
  return mapWorkspaceState(row!, args);
}
