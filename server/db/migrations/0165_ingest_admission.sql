-- A durable, fail-closed deploy fence. No expiry: only the owning deploy may reopen.
CREATE SCHEMA IF NOT EXISTS docslurp_deploy;
REVOKE ALL ON SCHEMA docslurp_deploy FROM PUBLIC;
CREATE TABLE IF NOT EXISTS docslurp_deploy.ingest_admission (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), holder text);
INSERT INTO docslurp_deploy.ingest_admission VALUES (true, NULL) ON CONFLICT (singleton) DO NOTHING;
REVOKE ALL ON docslurp_deploy.ingest_admission FROM PUBLIC;
CREATE OR REPLACE FUNCTION docslurp_deploy.check_ingest_admission() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE owner text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status NOT IN ('completed','failed','cancelled') OR NEW.status IN ('completed','failed','cancelled') THEN RETURN NEW; END IF;
  END IF;
  -- Held until commit: closing the gate waits for every admitted transaction.
  SELECT holder INTO STRICT owner FROM docslurp_deploy.ingest_admission WHERE singleton FOR SHARE;
  IF owner IS NOT NULL THEN RAISE EXCEPTION 'Ingestion temporarily paused' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION docslurp_deploy.check_ingest_admission() FROM PUBLIC;
DROP TRIGGER IF EXISTS ingest_run_fence ON public.project_runs;
CREATE TRIGGER ingest_run_fence BEFORE INSERT OR UPDATE OF status ON public.project_runs FOR EACH ROW EXECUTE FUNCTION docslurp_deploy.check_ingest_admission();
DROP TRIGGER IF EXISTS ingest_document_fence ON public.documents;
CREATE TRIGGER ingest_document_fence BEFORE INSERT ON public.documents FOR EACH ROW EXECUTE FUNCTION docslurp_deploy.check_ingest_admission();
DROP TRIGGER IF EXISTS ingest_upload_fence ON public.upload_sessions;
CREATE TRIGGER ingest_upload_fence BEFORE INSERT ON public.upload_sessions FOR EACH ROW EXECUTE FUNCTION docslurp_deploy.check_ingest_admission();
