-- Dry run, read-only: how many documents now `pii_blocked` would become partly available after a rescan or reprocess
-- under page-scoped `block_indexing` (docs/pii-page-withholding.md).
--
-- It changes nothing. Existing blocked documents are never rescanned automatically: their state changes only when they
-- are rescanned or reprocessed.
--
-- Per blocked document, it reads the detections of the run that blocked it (`pii_detections`, one row per match with
-- its page). A document would become partly available when:
--   - the project policy is still `block_indexing` (not `block_document`, not disabled),
--   - every detection has a page (a detection without one fails closed: the document stays blocked), and
--   - those pages are fewer than the document's pages.
-- This is an estimate: a rescan places HTML-only and contract-only hits by fingerprint, and a rescan whose Markdown
-- page breaks do not match the page count still blocks the whole document.
--
-- Run with: psql "$DATABASE_URL" -f scripts/pii-page-scope-dry-run.sql
-- Per-organization breakdown: replace the final select with the variant at the end.

with blocked as (
  select d.id, d.org_id, d.project_id, d.page_count, d.run_id,
    coalesce(d.metadata->'pii'->>'runId', d.run_id) as pii_run_id,
    p.pipeline->'piiPolicy'->>'action' as project_action,
    coalesce((p.pipeline->'piiPolicy'->>'enabled')::boolean, false) as project_enabled
  from documents d
  join projects p on p.id = d.project_id
  where d.status = 'pii_blocked'
    and d.superseded_at is null
    and d.purged_at is null
),
pages as (
  select b.id,
    count(*) as detections,
    count(*) filter (where pd.page_number is null) as unpaged_detections,
    count(distinct pd.page_number) filter (where pd.page_number between 1 and greatest(b.page_count, 1)) as pages_hit
  from blocked b
  join pii_detections pd on pd.document_id = b.id and pd.run_id = b.pii_run_id
  group by b.id
),
verdicts as (
  select b.*, coalesce(pg.detections, 0) as detections, coalesce(pg.unpaged_detections, 0) as unpaged_detections,
    coalesce(pg.pages_hit, 0) as pages_hit,
    case
      when not b.project_enabled then 'policy-disabled-now'
      when b.project_action = 'block_document' then 'stays-blocked:block_document'
      when b.project_action is distinct from 'block_indexing' then 'policy-action-changed'
      when coalesce(pg.detections, 0) = 0 then 'unknown:no-detections-recorded'
      when pg.unpaged_detections > 0 then 'stays-blocked:match-without-page'
      when b.page_count <= 1 then 'partly-available:sections'
      when pg.pages_hit >= b.page_count then 'stays-blocked:every-page'
      else 'partly-available:pages'
    end as verdict
  from blocked b
  left join pages pg on pg.id = b.id
)
select verdict,
  count(*) as documents,
  sum(page_count) as pages_in_documents,
  sum(case when verdict = 'partly-available:pages' then page_count - pages_hit else 0 end) as pages_that_would_be_served,
  sum(case when verdict = 'partly-available:pages' then pages_hit else 0 end) as pages_that_stay_withheld
from verdicts
group by verdict
order by verdict;

-- Per organization (replaces the final select above):
-- select org_id, verdict, count(*) from verdicts group by org_id, verdict order by org_id, verdict;
