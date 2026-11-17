-- Page read charges settle in the database (OCR page class). A page of a run is charged once in its dearest class:
-- an OCR read (`ocr:<run>:<document>:<page>`, metric ingest-page-ocr) and a vision read (`rich:<run>:<document>:<page>`,
-- the page's first Rich unit, metric ingest-page-rich) may be recorded by different activities, workers or releases,
-- whose in-memory usage ledgers never see each other's charges. This BEFORE INSERT trigger is the one place both meet:
--
-- - An OCR charge for a page the run already charged Rich is not inserted (the Rich charge covers the read).
-- - A first Rich unit for a page the run already charged OCR is inserted at its price minus that OCR charge
--   (`upgradeOf` names it), so the page pays Rich once in all.
-- - Backstop for a rollout or rollback mistake: a Fast charge written without `pageRules` >= 2 (a worker from before the
--   OCR class) for a run that has OCR charges is refused. Workers only write OCR charges once every live worker advertises
--   `billing.ocr-page-class` (worker capability handshake), so this fires only when an older worker reappears; see
--   docs/extraction/ocr.md (rollout and rollback) for disabling it before a worker rollback.
--
-- Serialization: before reading, the trigger locks the charge's run row (FOR NO KEY UPDATE: it serializes settlers but,
-- unlike FOR UPDATE, does not conflict with the FOR KEY SHARE every child-row foreign-key insert takes, the 40P01 that
-- worker/src/__tests__/checkpoint-lock-order.test.ts guards). The usage_events_run_spent_cents
-- statement trigger (0056) updates that same row at statement end, so every writer takes the run row first and in one
-- order (no deadlock), and a row lock lives on the tuple, not in the shared lock table, so a transaction inserting tens
-- of thousands of page charges takes no lock-table slot per page. The function is VOLATILE: under READ COMMITTED each
-- query after the lock wait sees what the other writer committed. Ids stay deterministic: a retried insert conflicts on
-- its id and changes nothing. Lookups are by primary key.
--
-- Reading usage_events here is an intentional, write-side exception to the rule that spend is read only through
-- usage_attribution (server/src/services/usage-attribution.ts): settlement must see the raw rows of this run, in this
-- transaction, before the insert.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION settle_page_read_charge() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_page text;
  v_other numeric;
  v_rules text;
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
    IF (v_rules IS NULL OR v_rules !~ '^[0-9]{1,4}$' OR v_rules::int < 2)
       AND EXISTS (SELECT 1 FROM public.usage_events e WHERE e.run_id = NEW.run_id AND e.metric = 'ingest-page-ocr') THEN
      RAISE EXCEPTION 'docslurp page billing rules mismatch: run % has OCR page charges and this worker predates the OCR page class', NEW.run_id
        USING ERRCODE = 'DS001',
          HINT = 'An older worker is settling a run started under the OCR page class. Roll workers forward; before a worker rollback, set docslurp.page_rules_guard = off (docs/extraction/ocr.md, rollout and rollback).';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER usage_events_settle_page_read_charge
BEFORE INSERT ON usage_events
FOR EACH ROW EXECUTE FUNCTION settle_page_read_charge();
