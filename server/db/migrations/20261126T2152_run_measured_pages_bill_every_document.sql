-- Every migration must be safe to run twice and must keep the previous release working
-- (AGENTS.md, docs/releases.md#schema-changes-expand-and-contract):
--   CREATE TABLE / INDEX / SEQUENCE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP ... IF EXISTS,
--   CREATE OR REPLACE FUNCTION / VIEW, a DO block that checks the catalog before ADD CONSTRAINT,
--   CREATE TYPE, CREATE POLICY or a rename, ON CONFLICT or NOT EXISTS on inserts, guarded backfills.
-- It runs in its own transaction with a bounded lock wait and is retried when the wait times out,
-- so keep it short: one table rewrite or index build per file.
-- Every document of a run bills as processed: no document is exempt as a content copy (run creation no longer makes them).
CREATE OR REPLACE FUNCTION public.run_measured_pages(p_run_id text, p_read_metrics text[], p_exclude_document_id text DEFAULT NULL)
RETURNS TABLE (fast_pages bigint, ocr_frames bigint, document_charged_pages integer)
LANGUAGE sql STABLE AS $$
  WITH docs AS MATERIALIZED (
    SELECT d.id, lower(split_part(coalesce(d.mime_type, ''), ';', 1)) AS mime_type, d.page_count, d.billing_pages, d.intake_page_count
    FROM public.documents d
    WHERE d.run_id = p_run_id AND d.status <> 'failed'
      -- A document with its per-document Fast charge (fast:<run>:<document>) is in the run's spend already.
      AND NOT EXISTS (SELECT 1 FROM public.usage_attribution fa WHERE fa.id = 'fast:' || p_run_id || ':' || d.id)
  ), images AS MATERIALIZED (
    SELECT id, page_count FROM docs WHERE mime_type LIKE 'image/%' AND page_count > 1
  ), reads AS MATERIALIZED (
    -- The run's page-read charges, read once (and only when the run has a multi-frame image).
    SELECT au.metadata ->> 'documentId' AS document_id,
      CASE WHEN (au.metadata ->> 'pageNumber') ~ '^[0-9]{1,9}$' THEN (au.metadata ->> 'pageNumber')::int END AS page_number
    FROM public.usage_attribution au
    WHERE au.run_id = p_run_id AND au.metric = ANY(p_read_metrics) AND EXISTS (SELECT 1 FROM images)
  ), charged AS (
    SELECT i.id AS document_id, count(DISTINCT r.page_number)::int AS pages
    FROM images i JOIN reads r ON r.document_id = i.id
    WHERE r.page_number BETWEEN 1 AND i.page_count
    GROUP BY i.id
  )
  SELECT
    coalesce(sum(greatest(0, coalesce(docs.billing_pages, docs.page_count) - coalesce(docs.intake_page_count, docs.page_count)))
      FILTER (WHERE docs.id IS DISTINCT FROM p_exclude_document_id
        AND docs.mime_type NOT LIKE 'image/%' AND docs.mime_type NOT LIKE 'audio/%' AND docs.mime_type NOT LIKE 'video/%'), 0)::bigint,
    -- An image's frames past the larger of what admission priced (intake, at least 1) and the pages a read charged.
    coalesce(sum(greatest(0, docs.page_count - greatest(1, coalesce(docs.intake_page_count, docs.page_count), coalesce(c.pages, 0))))
      FILTER (WHERE docs.id IS DISTINCT FROM p_exclude_document_id AND docs.mime_type LIKE 'image/%' AND docs.page_count > 1), 0)::bigint,
    coalesce(max(c.pages) FILTER (WHERE docs.id = p_exclude_document_id), 0)::int
  FROM docs LEFT JOIN charged c ON c.document_id = docs.id
$$;
