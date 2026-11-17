-- The pages a run measured above what admission priced and that no charge covers yet, over every document of the run
-- (worker pipeline/page-basis.ts): Fast pages of paged, non-media documents (page count or billing pages above the durable
-- intake count, migration 0130) and frames of multi-frame images that no page-read charge covers. One sum for every
-- page-basis spend check, so the order documents are measured in never decides whether the run overdraws, and for the
-- spend-paused resume sweep, which resumes a run only once the balance covers what it already owes.
-- `p_read_metrics` are the page-read charge metrics (shared PAGE_READ_METRICS); `p_exclude_document_id` leaves one document
-- out of both sums (the caller adds that document from its own state) and reports its charged pages.
-- SECURITY INVOKER: it reads only what the caller may read, for the one run named.
CREATE OR REPLACE FUNCTION public.run_measured_pages(p_run_id text, p_read_metrics text[], p_exclude_document_id text DEFAULT NULL)
RETURNS TABLE (fast_pages bigint, ocr_frames bigint, document_charged_pages integer)
LANGUAGE sql STABLE AS $$
  WITH docs AS (
    SELECT d.id, coalesce(d.mime_type, '') AS mime_type, d.page_count, d.billing_pages, d.intake_page_count
    FROM public.documents d
    WHERE d.run_id = p_run_id AND d.deduped_from_document_id IS NULL AND d.status <> 'failed'
  ), charged AS (
    SELECT au.metadata ->> 'documentId' AS document_id, count(DISTINCT au.metadata ->> 'pageNumber')::int AS pages
    FROM public.usage_attribution au
    WHERE au.run_id = p_run_id AND au.metric = ANY(p_read_metrics)
      AND au.metadata ->> 'documentId' IN (SELECT id FROM docs WHERE mime_type LIKE 'image/%')
    GROUP BY 1
  )
  SELECT
    coalesce(sum(greatest(0, coalesce(docs.billing_pages, docs.page_count) - coalesce(docs.intake_page_count, docs.page_count)))
      FILTER (WHERE docs.id IS DISTINCT FROM p_exclude_document_id
        AND docs.mime_type NOT LIKE 'image/%' AND docs.mime_type NOT LIKE 'audio/%' AND docs.mime_type NOT LIKE 'video/%'), 0)::bigint,
    coalesce(sum(greatest(0, docs.page_count - greatest(1, coalesce(c.pages, 0))))
      FILTER (WHERE docs.id IS DISTINCT FROM p_exclude_document_id AND docs.mime_type LIKE 'image/%' AND docs.page_count > 1), 0)::bigint,
    coalesce(max(c.pages) FILTER (WHERE docs.id = p_exclude_document_id), 0)::int
  FROM docs LEFT JOIN charged c ON c.document_id = docs.id
$$;
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
