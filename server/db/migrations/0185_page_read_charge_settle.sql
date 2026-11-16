-- Page read charges settle in the database (OCR page class). A page of a run is charged once in its dearest class:
-- an OCR read (`ocr:<run>:<document>:<page>`, metric ingest-page-ocr) and a vision read (`rich:<run>:<document>:<page>`,
-- the page's first Rich unit, metric ingest-page-rich) may be recorded by different activities, workers or releases,
-- whose in-memory usage ledgers never see each other's charges. This BEFORE INSERT trigger is the one place both meet:
--
-- - An OCR charge for a page the run already charged Rich is not inserted (the Rich charge covers the read).
-- - A first Rich unit for a page the run already charged OCR is inserted at its price minus that OCR charge
--   (`upgradeOf` names it), so the page pays Rich once in all.
-- - A Fast charge written without `pageRules` >= 2 (a worker from before the OCR class) for a run that has OCR charges is
--   refused: that code would bill the run's OCR pages Fast as well. The refused activity fails and is retried, by a worker
--   of this release once the rollout replaced the old ones (deploy order: migrate, then workers).
--
-- The page's charges are serialized on a transaction advisory lock keyed by run, document and page, and the function is
-- VOLATILE (each query takes a fresh snapshot under READ COMMITTED), so two activities settling the same page wait for
-- each other and the second sees the first's committed row. Ids stay deterministic: a retried insert conflicts on its id
-- and changes nothing. Lookups are by primary key.
CREATE OR REPLACE FUNCTION settle_page_read_charge() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_page text;
  v_other numeric;
  v_rules text;
BEGIN
  IF coalesce(NEW.metadata ->> 'unitCharge', 'false') <> 'true' THEN
    RETURN NEW;
  END IF;
  IF NEW.metric = 'ingest-page-ocr' AND NEW.id LIKE 'ocr:%' THEN
    v_page := substr(NEW.id, 5);
    PERFORM pg_advisory_xact_lock(734001, hashtext(v_page));
    IF EXISTS (SELECT 1 FROM usage_events e WHERE e.id = 'rich:' || v_page AND e.run_id IS NOT DISTINCT FROM NEW.run_id) THEN
      RETURN NULL;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.metric = 'ingest-page-rich' AND NEW.id LIKE 'rich:%' AND NEW.id NOT LIKE '%:unit:%' THEN
    v_page := substr(NEW.id, 6);
    PERFORM pg_advisory_xact_lock(734001, hashtext(v_page));
    SELECT e.cost_cents INTO v_other FROM usage_events e
    WHERE e.id = 'ocr:' || v_page AND e.run_id IS NOT DISTINCT FROM NEW.run_id;
    IF FOUND THEN
      NEW.cost_cents := greatest(0, NEW.cost_cents - coalesce(v_other, 0));
      NEW.metadata := NEW.metadata || jsonb_build_object('upgradeOf', 'ocr:' || v_page, 'upgradeFrom', 'ocr');
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.metric = 'ingest-page-fast' AND NEW.run_id IS NOT NULL THEN
    v_rules := NEW.metadata ->> 'pageRules';
    IF (v_rules IS NULL OR v_rules !~ '^[0-9]{1,4}$' OR v_rules::int < 2)
       AND EXISTS (SELECT 1 FROM usage_events e WHERE e.run_id = NEW.run_id AND e.metric = 'ingest-page-ocr') THEN
      RAISE EXCEPTION 'page charges of run % were read under the OCR page class; this worker predates it (retry on a current worker)', NEW.run_id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER usage_events_settle_page_read_charge
BEFORE INSERT ON usage_events
FOR EACH ROW EXECUTE FUNCTION settle_page_read_charge();
