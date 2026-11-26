-- Content-deduplicated copies carry their own billing facts and are spend-checked like originals.
--
-- 1. documents.copy_ocr_pages / copy_rich_pages / copy_media_pages: written by the API when it creates a copy (an upload whose
--    bytes match a completed document of the same organization, documents.deduped_from_document_id), in the transaction that
--    sets the pointer. With the copy's billing_pages, billing_pages_method and page_count_source, they are the classes its
--    pages finally billed on the document it copies: of billing_pages, the pages a Rich read charged (copy_rich_pages), the
--    pages only an OCR read charged (copy_ocr_pages), the rest Fast; for an audio or video file, the Rich pages its media
--    charge billed (copy_media_pages). Recorded data only: nothing is read again. The worker's completion charge bills a copy
--    from these columns (worker db/page-base-fee.ts), so deleting the original (ON DELETE SET NULL on the pointer) no longer
--    changes what a copy bills. Null on originals and on copies made before this migration; the worker reads those copies
--    through the pointer as before. Nullable, no default: a catalog change (no rewrite, no scan). The CHECKs are NOT VALID:
--    they bind every write from now on and every existing row satisfies them (all null).
--
-- 2. run_measured_pages counts copies. Until now it left them out (a copy bills nothing), so a run of copies was never
--    spend-checked. A copy's billing_pages above its intake count is now owed like an original's, split by its recorded
--    classes, dearest first: its Rich pages (new column rich_pages), then its OCR pages (new column ocr_pages), the rest Fast.
--    `p_include_copies` false restores the earlier sum (the copy billing flag off, shared dedupCopiesBill); the default is
--    true, so a caller from an earlier release (three arguments, three columns read by name) gets the stricter sum.
--    The function's result type changes, so it is dropped and created again in this one transaction; callers wait at most
--    the lock timeout. Idempotent: running the file twice leaves the same function.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS copy_ocr_pages integer,
  ADD COLUMN IF NOT EXISTS copy_rich_pages integer,
  ADD COLUMN IF NOT EXISTS copy_media_pages integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.documents'::regclass AND conname = 'documents_copy_billing_check') THEN
    ALTER TABLE public.documents ADD CONSTRAINT documents_copy_billing_check CHECK (
      (copy_ocr_pages IS NULL OR copy_ocr_pages >= 0)
      AND (copy_rich_pages IS NULL OR copy_rich_pages >= 0)
      AND (copy_media_pages IS NULL OR copy_media_pages >= 0)
    ) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.run_measured_pages(text, text[], text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.run_measured_pages(text, text[], text, boolean);
--> statement-breakpoint
-- As migration 0190, plus copies. A copy is a document with a pointer or with recorded copy classes (its original may be
-- gone). Its pages above intake are split dearest first; an original's are Fast as before.
CREATE OR REPLACE FUNCTION public.run_measured_pages(p_run_id text, p_read_metrics text[], p_exclude_document_id text DEFAULT NULL, p_include_copies boolean DEFAULT true)
RETURNS TABLE (fast_pages bigint, ocr_frames bigint, document_charged_pages integer, ocr_pages bigint, rich_pages bigint)
LANGUAGE sql STABLE AS $$
  WITH docs AS MATERIALIZED (
    SELECT d.id, lower(split_part(coalesce(d.mime_type, ''), ';', 1)) AS mime_type, d.page_count, d.billing_pages, d.intake_page_count,
      (d.deduped_from_document_id IS NOT NULL OR d.copy_ocr_pages IS NOT NULL OR d.copy_rich_pages IS NOT NULL) AS copy,
      greatest(0, coalesce(d.copy_rich_pages, 0)) AS copy_rich, greatest(0, coalesce(d.copy_ocr_pages, 0)) AS copy_ocr
    FROM public.documents d
    WHERE d.run_id = p_run_id AND d.status <> 'failed'
      AND (p_include_copies OR (d.deduped_from_document_id IS NULL AND d.copy_ocr_pages IS NULL AND d.copy_rich_pages IS NULL))
  ), paged AS (
    -- Pages above intake of the paged, non-media documents (and of copied images, which read nothing), and of those, a
    -- copy's Rich and OCR share (dearest first).
    SELECT docs.id, docs.copy,
      greatest(0, coalesce(docs.billing_pages, docs.page_count) - coalesce(docs.intake_page_count, docs.page_count)) AS above,
      docs.copy_rich, docs.copy_ocr
    FROM docs
    WHERE docs.id IS DISTINCT FROM p_exclude_document_id
      AND (docs.mime_type NOT LIKE 'image/%' OR docs.copy) AND docs.mime_type NOT LIKE 'audio/%' AND docs.mime_type NOT LIKE 'video/%'
  ), split AS (
    SELECT paged.above,
      CASE WHEN paged.copy THEN least(paged.above, paged.copy_rich) ELSE 0 END AS rich,
      CASE WHEN paged.copy THEN least(paged.above - least(paged.above, paged.copy_rich), paged.copy_ocr) ELSE 0 END AS ocr
    FROM paged
  ), images AS MATERIALIZED (
    SELECT id, page_count FROM docs WHERE mime_type LIKE 'image/%' AND page_count > 1 AND NOT copy
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
  ), image_owed AS (
    SELECT
      -- An image's frames past the larger of what admission priced (intake, at least 1) and the pages a read charged.
      coalesce(sum(greatest(0, docs.page_count - greatest(1, coalesce(docs.intake_page_count, docs.page_count), coalesce(c.pages, 0))))
        FILTER (WHERE docs.id IS DISTINCT FROM p_exclude_document_id AND docs.mime_type LIKE 'image/%' AND docs.page_count > 1 AND NOT docs.copy), 0)::bigint AS frames,
      coalesce(max(c.pages) FILTER (WHERE docs.id = p_exclude_document_id), 0)::int AS charged
    FROM docs LEFT JOIN charged c ON c.document_id = docs.id
  )
  SELECT
    coalesce((SELECT sum(split.above - split.rich - split.ocr) FROM split), 0)::bigint,
    image_owed.frames,
    image_owed.charged,
    coalesce((SELECT sum(split.ocr) FROM split), 0)::bigint,
    coalesce((SELECT sum(split.rich) FROM split), 0)::bigint
  FROM image_owed
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_app') THEN
    GRANT EXECUTE ON FUNCTION public.run_measured_pages(text, text[], text, boolean) TO docslurp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT EXECUTE ON FUNCTION public.run_measured_pages(text, text[], text, boolean) TO docslurp_worker;
  END IF;
END $$;
