-- The pages a run measured above what admission priced and that no charge covers yet, over every document of the run
-- (worker pipeline/page-basis.ts): Fast pages of paged, non-media documents (page count or billing pages above the durable
-- intake count, migration 0130) and frames of multi-frame images past the larger of their intake count and the pages a
-- page-read charge covers. One sum for every page-basis spend check, so the order documents are measured in never decides
-- whether the run overdraws, and for the spend-paused resume sweep.
-- `p_read_metrics` are the page-read charge metrics (shared PAGE_READ_METRICS); `p_exclude_document_id` leaves one document
-- out of both sums (the caller adds that document from its own state) and reports its charged pages.
-- Charged pages count only page numbers inside the document (`^[0-9]{1,9}$`, 1..page_count), as the completion fee does
-- (worker db/page-base-fee.ts), and are read only for the run's multi-frame images: a run without any reads no usage rows.
-- SECURITY INVOKER: it reads only what the caller may read, for the one run named.
CREATE OR REPLACE FUNCTION public.run_measured_pages(p_run_id text, p_read_metrics text[], p_exclude_document_id text DEFAULT NULL)
RETURNS TABLE (fast_pages bigint, ocr_frames bigint, document_charged_pages integer)
LANGUAGE sql STABLE AS $$
  WITH docs AS MATERIALIZED (
    SELECT d.id, lower(split_part(coalesce(d.mime_type, ''), ';', 1)) AS mime_type, d.page_count, d.billing_pages, d.intake_page_count
    FROM public.documents d
    WHERE d.run_id = p_run_id AND d.deduped_from_document_id IS NULL AND d.status <> 'failed'
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
--> statement-breakpoint
-- The credits the worker's charge check last refused for a spend-paused run (worker db/spend-check.ts
-- enforceRunSpendForCharge): its run-wide measured pages, feature extras and buffered charges, priced exactly as the worker
-- prices them. The resume sweep holds at least this much, so it never resumes a run the worker would refuse again at once.
-- Cleared on resume.
ALTER TABLE public.project_runs ADD COLUMN IF NOT EXISTS spend_pause_credits numeric;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_app') THEN
    GRANT EXECUTE ON FUNCTION public.run_measured_pages(text, text[], text) TO docslurp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT EXECUTE ON FUNCTION public.run_measured_pages(text, text[], text) TO docslurp_worker;
  END IF;
END $$;
