-- Per-document Fast charges (worker db/page-base-fee.ts chargeDocumentsFastStatement). A run pinned to the per-document rule
-- charges each document's Fast pages when the document completes, as its own event `fast:<run>:<document>` (metric
-- ingest-page-fast, metadata perDocument = true, pageRules = 3). Two changes, both no-ops until such an event exists, so the
-- previous release keeps working against this schema (order: this migration, then workers, then the server):
--
-- 1. The 0185 backstop, extended: a Fast charge written with `pageRules` below 3 (a worker of an earlier release, which bills a
--    run's Fast pages in one run-wide charge at completion) for a run that has per-document Fast charges is refused. Workers pin
--    a run to the per-document rule only when every live worker advertises `billing.fast-per-document`, so this fires only when
--    an older worker reappears (a worker rollback); its activity fails and is retried by a current worker. The same switch as
--    0185 turns both checks off: ALTER DATABASE <db> SET docslurp.page_rules_guard = 'off'. The check runs only for such an
--    older charge, never for a current worker's: a current worker writes `pageRules` 3 on every Fast charge.
-- 2. run_measured_pages (0190) leaves out documents that already have their per-document Fast charge: their pages are in the
--    run's spend (spent_cents) from that charge, and counting them as measured-and-uncharged would weigh them twice in a spend
--    check. A run without per-document charges sums exactly as before. One primary-key probe per document.
--
-- Everything else in both functions is 0185's and 0190's definition, unchanged. CREATE OR REPLACE: idempotent.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settle_page_read_charge() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_page text;
  v_other numeric;
  v_rules text;
  v_rules_n int;
BEGIN
  IF coalesce(NEW.metadata ->> 'unitCharge', 'false') <> 'true' OR NEW.run_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.metric = 'ingest-page-ocr' AND NEW.id LIKE 'ocr:%' THEN
    v_page := substr(NEW.id, 5);
    PERFORM 1 FROM public.project_runs r WHERE r.id = NEW.run_id FOR NO KEY UPDATE;
    IF EXISTS (SELECT 1 FROM public.usage_events e WHERE e.id = 'rich:' || v_page AND e.run_id = NEW.run_id) THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.metric = 'ingest-page-rich' AND NEW.id LIKE 'rich:%' AND NEW.id NOT LIKE '%:unit:%' THEN
    v_page := substr(NEW.id, 6);
    PERFORM 1 FROM public.project_runs r WHERE r.id = NEW.run_id FOR NO KEY UPDATE;
    SELECT e.cost_cents INTO v_other FROM public.usage_events e
    WHERE e.id = 'ocr:' || v_page AND e.run_id = NEW.run_id;
    IF FOUND THEN
      NEW.cost_cents := greatest(0, NEW.cost_cents - coalesce(v_other, 0));
      NEW.metadata := NEW.metadata || jsonb_build_object('upgradeOf', 'ocr:' || v_page, 'upgradeFrom', 'ocr');
    END IF;
    RETURN NEW;
  END IF;
  -- The backstop can be turned off for a worker rollback: ALTER DATABASE <db> SET docslurp.page_rules_guard = 'off'.
  IF NEW.metric = 'ingest-page-fast' AND coalesce(current_setting('docslurp.page_rules_guard', true), '') <> 'off' THEN
    v_rules := NEW.metadata ->> 'pageRules';
    v_rules_n := CASE WHEN v_rules ~ '^[0-9]{1,4}$' THEN v_rules::int ELSE 0 END;
    IF v_rules_n < 2
       AND EXISTS (SELECT 1 FROM public.usage_events e WHERE e.run_id = NEW.run_id AND e.metric = 'ingest-page-ocr') THEN
      RAISE EXCEPTION 'docslurp page billing rules mismatch: run % has OCR page charges and this worker predates the OCR page class', NEW.run_id
        USING ERRCODE = 'DS001',
          HINT = 'An older worker is settling a run started under the OCR page class. Roll workers forward; before a worker rollback, set docslurp.page_rules_guard = off (docs/extraction/ocr.md, rollout and rollback).';
    END IF;
    -- perDocument: a run billed Fast per document. An older worker's run-wide Fast charge would bill those pages again. The
    -- run row lock first (as the read branches above take it): a per-document charge still in flight holds it (its usage
    -- statement's spent_cents update, 0056) until it commits, so this check sees it.
    IF v_rules_n < 3 THEN
      PERFORM 1 FROM public.project_runs r WHERE r.id = NEW.run_id FOR NO KEY UPDATE;
    END IF;
    IF v_rules_n < 3
       AND EXISTS (SELECT 1 FROM public.usage_events e WHERE e.run_id = NEW.run_id AND e.metric = 'ingest-page-fast'
         AND e.metadata ->> 'perDocument' = 'true') THEN
      RAISE EXCEPTION 'docslurp page billing rules mismatch: run % bills Fast per document and this worker predates that rule', NEW.run_id
        USING ERRCODE = 'DS001',
          HINT = 'An older worker is completing a run started under the per-document Fast rule. Roll workers forward; before a worker rollback, set DOCSLURP_FAST_PER_DOCUMENT=off on current workers and let per-document runs finish (docs/extraction/ocr.md, rollout and rollback).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.run_measured_pages(p_run_id text, p_read_metrics text[], p_exclude_document_id text DEFAULT NULL)
RETURNS TABLE (fast_pages bigint, ocr_frames bigint, document_charged_pages integer)
LANGUAGE sql STABLE AS $$
  WITH docs AS MATERIALIZED (
    SELECT d.id, lower(split_part(coalesce(d.mime_type, ''), ';', 1)) AS mime_type, d.page_count, d.billing_pages, d.intake_page_count
    FROM public.documents d
    WHERE d.run_id = p_run_id AND d.deduped_from_document_id IS NULL AND d.status <> 'failed'
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
