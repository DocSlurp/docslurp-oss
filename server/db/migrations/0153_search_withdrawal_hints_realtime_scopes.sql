-- 1. Native search withdrawal hints.
-- Native search caches each project's eligible document set
-- (server/src/search/eligible-documents.ts). Worker run_events hints are now
-- debounced there (at most one reload per project per second during a bulk
-- ingest), so they may no longer be what removes a document from search.
-- Every transition that takes a document out of search sends the immediate
-- `search_eligibility` hint from the database itself, whichever code path made
-- it: delete, supersede, purge, move, a status leaving `completed` or entering a
-- blocked/terminal state, early-lexical withdrawal, a run that stops being live
-- while it still has early-lexical documents, and a completed correction reindex.
-- Payload: {"projectIds":[<project>]}; identical notifications in one
-- transaction are delivered once.
--
-- A run that stops being live withdraws only its early-lexical documents: the
-- ones search served before they completed (search/eligibility.ts). A run that
-- finishes normally has none left, since each became `completed` first, so it
-- sends nothing and the debounced run_events hint covers it. Otherwise a bulk
-- ingest of many small runs dropped the project's cached set, and reloaded it
-- (257 ms at 10,000 documents), after every single run. The probe is one
-- documents_run_id_idx range per run that stops, not per document.
CREATE OR REPLACE FUNCTION search_eligibility_withdrawn() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE project text;
BEGIN
  IF TG_TABLE_NAME = 'project_runs' THEN
    -- The documents' own projects: a moved document is served from where it is now.
    FOR project IN
      SELECT DISTINCT d.project_id FROM public.documents d
      WHERE d.run_id = OLD.id AND d.lexical_searchable_at IS NOT NULL AND d.superseded_at IS NULL
        AND d.status NOT IN ('completed', 'failed', 'cancelled', 'pii_blocked')
    LOOP
      PERFORM pg_notify('search_eligibility', json_build_object('projectIds', json_build_array(project))::text);
    END LOOP;
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'documents' THEN
    project := OLD.project_id;
  ELSIF TG_TABLE_NAME = 'document_corrections' THEN
    SELECT d.project_id INTO project FROM public.documents d WHERE d.id = NEW.document_id;
  END IF;
  IF project IS NOT NULL THEN
    PERFORM pg_notify('search_eligibility', json_build_object('projectIds', json_build_array(project))::text);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER documents_search_withdrawn_delete AFTER DELETE ON documents
FOR EACH ROW EXECUTE FUNCTION search_eligibility_withdrawn();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER documents_search_withdrawn_update
AFTER UPDATE OF project_id, status, superseded_at, purged_at, lexical_searchable_at ON documents
FOR EACH ROW WHEN (
  OLD.project_id IS DISTINCT FROM NEW.project_id
  OR (OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL)
  OR (OLD.purged_at IS NULL AND NEW.purged_at IS NOT NULL)
  OR (OLD.status IS DISTINCT FROM NEW.status
    AND (OLD.status = 'completed' OR NEW.status IN ('failed', 'cancelled', 'pii_blocked')))
  OR (OLD.lexical_searchable_at IS NOT NULL AND NEW.lexical_searchable_at IS NULL)
) EXECUTE FUNCTION search_eligibility_withdrawn();
--> statement-breakpoint
-- Early-lexical documents are served only while their run is live (search/eligibility.ts liveRun); the function
-- sends a hint only when the run still has some.
CREATE OR REPLACE TRIGGER project_runs_search_withdrawn
AFTER UPDATE OF status, control_state ON project_runs
FOR EACH ROW WHEN (
  OLD.status IN ('queued', 'processing')
  AND coalesce(OLD.control_state, '') NOT IN ('cancelled', 'cancel_requested', 'dead-letter')
  AND NOT (NEW.status IN ('queued', 'processing')
    AND coalesce(NEW.control_state, '') NOT IN ('cancelled', 'cancel_requested', 'dead-letter'))
) EXECUTE FUNCTION search_eligibility_withdrawn();
--> statement-breakpoint
-- A completed correction reindex makes the document's LanceDB rows stale (lance_stale).
CREATE OR REPLACE TRIGGER document_corrections_search_withdrawn
AFTER INSERT OR UPDATE OF reindex_completed_at ON document_corrections
FOR EACH ROW WHEN (NEW.reindex_completed_at IS NOT NULL)
EXECUTE FUNCTION search_eligibility_withdrawn();
--> statement-breakpoint

-- 2. Economics from trigger-maintained counters.
-- The realtime `economics` projection ran six correlated aggregates per
-- project. Completed-run totals are now kept in project_corpus_stats by a
-- trigger on project_runs (runs complete rarely, so this adds no contention
-- to ingest). Exact numeric, so a read equals the old aggregate bit for bit.
ALTER TABLE project_corpus_stats ADD COLUMN IF NOT EXISTS completed_run_pages_processed bigint NOT NULL DEFAULT 0;
ALTER TABLE project_corpus_stats ADD COLUMN IF NOT EXISTS completed_run_runtime_ms numeric NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION apply_project_run_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  old_done boolean := TG_OP <> 'INSERT' AND OLD.status = 'completed';
  new_done boolean := TG_OP <> 'DELETE' AND NEW.status = 'completed';
BEGIN
  IF old_done THEN
    UPDATE public.project_corpus_stats
    SET completed_run_pages_processed = completed_run_pages_processed - OLD.pages_processed,
        completed_run_runtime_ms = completed_run_runtime_ms - greatest(0, extract(epoch from (OLD.updated_at - OLD.created_at)) * 1000)
    WHERE project_id = OLD.project_id;
  END IF;
  IF new_done THEN
    INSERT INTO public.project_corpus_stats AS s (project_id, completed_run_pages_processed, completed_run_runtime_ms)
    VALUES (NEW.project_id, NEW.pages_processed, greatest(0, extract(epoch from (NEW.updated_at - NEW.created_at)) * 1000))
    ON CONFLICT (project_id) DO UPDATE
    SET completed_run_pages_processed = s.completed_run_pages_processed + EXCLUDED.completed_run_pages_processed,
        completed_run_runtime_ms = s.completed_run_runtime_ms + EXCLUDED.completed_run_runtime_ms;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER project_runs_corpus_stats_insert_delete AFTER INSERT OR DELETE ON project_runs
FOR EACH ROW EXECUTE FUNCTION apply_project_run_stats();
--> statement-breakpoint
-- Progress updates of running runs (most project_runs writes) skip the function entirely.
CREATE OR REPLACE TRIGGER project_runs_corpus_stats_update
AFTER UPDATE OF status, pages_processed, created_at, updated_at, project_id ON project_runs
FOR EACH ROW WHEN (OLD.status = 'completed' OR NEW.status = 'completed')
EXECUTE FUNCTION apply_project_run_stats();
--> statement-breakpoint
-- idempotent-migration: the backfill assigns the aggregate (never adds to it), so a second run writes the same values.
INSERT INTO project_corpus_stats AS s (project_id, completed_run_pages_processed, completed_run_runtime_ms)
SELECT r.project_id, coalesce(sum(r.pages_processed), 0), coalesce(sum(greatest(0, extract(epoch from (r.updated_at - r.created_at)) * 1000)), 0)
FROM project_runs r JOIN projects p ON p.id = r.project_id
WHERE r.status = 'completed'
GROUP BY r.project_id
ON CONFLICT (project_id) DO UPDATE
SET completed_run_pages_processed = EXCLUDED.completed_run_pages_processed,
    completed_run_runtime_ms = EXCLUDED.completed_run_runtime_ms;
--> statement-breakpoint
-- Current documents that are not completed: in flight (documents_project_in_flight_idx)
-- and terminal. Counted from partial indexes rather than counters, so concurrent
-- uploads into one project never serialize on its stats row.
CREATE INDEX IF NOT EXISTS documents_project_terminal_current_idx ON documents (project_id) INCLUDE (page_count, file_size)
WHERE status IN ('failed', 'cancelled') AND superseded_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_runs_project_active_idx ON project_runs (project_id)
WHERE status IN ('queued', 'processing');
--> statement-breakpoint

-- 3. Per-resource realtime revisions.
-- Counters gain a scope: '' is the organization (every change, as before; the
-- realtime_revisions view reads only it), 'project:<id>' and 'run:<id>' are
-- recorded alongside it by the same triggers. The broker re-projects a project
-- or run subscription only when its own scope moved, and still re-authorizes
-- every subscription when the organization revision moves.
ALTER TABLE realtime_revision_counters ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT '';
--> statement-breakpoint
DO $idem$
DECLARE key_name text;
BEGIN
  SELECT c.conname INTO key_name FROM pg_constraint c
  WHERE c.conrelid = 'public.realtime_revision_counters'::regclass AND c.contype = 'p';
  IF key_name IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.conrelid = 'public.realtime_revision_counters'::regclass AND c.contype = 'p' AND a.attname = 'scope'
  ) THEN
    EXECUTE format('ALTER TABLE public.realtime_revision_counters DROP CONSTRAINT %I', key_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.realtime_revision_counters'::regclass AND contype = 'p') THEN
    ALTER TABLE public.realtime_revision_counters ADD PRIMARY KEY (org_id, scope, transaction_id);
  END IF;
END $idem$;
--> statement-breakpoint
CREATE OR REPLACE VIEW realtime_revisions AS
SELECT org_id, sum(revision)::bigint AS revision, max(transaction_id) AS transaction_id
FROM realtime_revision_counters WHERE scope = '' GROUP BY org_id;
--> statement-breakpoint
CREATE OR REPLACE VIEW realtime_scope_revisions AS
SELECT org_id, scope, sum(revision)::bigint AS revision
FROM realtime_revision_counters WHERE scope <> '' GROUP BY org_id, scope;
--> statement-breakpoint
-- The triggers (owned by the publisher) resolve a change's project and run.
GRANT SELECT (project_id) ON public.project_runs TO docslurp_realtime_publisher;
GRANT SELECT (project_id, run_id) ON public.documents TO docslurp_realtime_publisher;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_fold_committed(organization_id text) RETURNS integer
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE removed_count integer;
BEGIN
  IF NOT pg_try_advisory_xact_lock(319120,hashtext(organization_id)) THEN RETURN 0; END IF;
  INSERT INTO public.realtime_revision_counters(org_id,scope,revision,transaction_id)
  VALUES(organization_id,'',0,0) ON CONFLICT(org_id,scope,transaction_id) DO NOTHING;
  WITH removed AS (
    DELETE FROM public.realtime_revision_counters c WHERE c.org_id=organization_id
      AND (c.scope,c.transaction_id) IN (SELECT p.scope,p.transaction_id FROM public.realtime_revision_counters p
        WHERE p.org_id=organization_id AND p.transaction_id NOT IN (0,txid_current())
        ORDER BY p.transaction_id LIMIT 256 FOR UPDATE SKIP LOCKED)
    RETURNING c.scope, c.revision
  ), folded AS (
    INSERT INTO public.realtime_revision_counters AS t(org_id,scope,revision,transaction_id)
    SELECT organization_id, removed.scope, sum(removed.revision)::bigint, 0 FROM removed GROUP BY removed.scope
    ON CONFLICT(org_id,scope,transaction_id) DO UPDATE SET revision=t.revision+EXCLUDED.revision
    RETURNING 1
  ) SELECT (SELECT count(*) FROM removed)::integer INTO removed_count FROM (SELECT count(*) FROM folded) AS done;
  RETURN removed_count;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_record_change(organization_id text) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE inserted integer;
BEGIN
  INSERT INTO public.realtime_revision_counters(org_id,scope,revision,transaction_id)
  VALUES(organization_id,'',1,txid_current()) ON CONFLICT(org_id,scope,transaction_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted=0 THEN RETURN; END IF;
  PERFORM pg_notify('realtime_changed','');
  PERFORM public.realtime_fold_committed(organization_id);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  source record;
  pass integer;
  organization_id text;
  project_value text;
  run_value text;
  document_value text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(TG_TABLE_NAME))
    OR TG_NAME<>'realtime_changed' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME NOT IN ('organizations','project_runs','documents','projects','org_memberships',
    'usage_events','credit_ledger','credit_debits_pending','credit_leases','interactive_spend_holds',
    'project_members','project_search_settings','query_suggestions',
    'project_run_events','project_run_stage_states','performance_log',
    'document_run_stage_states','document_tags','document_summaries') THEN
    -- page_stage_states, document_pages and document_chunks: realtime_statement_changed() below.
    RAISE EXCEPTION 'Unsupported realtime source';
  END IF;
  -- Old and new rows both: a move between scopes updates both collections.
  FOR pass IN 1..2 LOOP
    CONTINUE WHEN (pass=1 AND TG_OP='INSERT') OR (pass=2 AND TG_OP='DELETE');
    IF pass=1 THEN source := OLD; ELSE source := NEW; END IF;
    organization_id := NULL; project_value := NULL; run_value := NULL; document_value := NULL;
    IF TG_TABLE_NAME='organizations' THEN
      organization_id := source.id;
    ELSIF TG_TABLE_NAME='project_runs' THEN
      organization_id := source.org_id; project_value := source.project_id; run_value := source.id;
    ELSIF TG_TABLE_NAME IN ('documents','usage_events') THEN
      organization_id := source.org_id; project_value := source.project_id; run_value := source.run_id;
    ELSIF TG_TABLE_NAME='projects' THEN
      organization_id := source.org_id; project_value := source.id;
    ELSIF TG_TABLE_NAME IN ('org_memberships','credit_ledger','credit_debits_pending','credit_leases','interactive_spend_holds') THEN
      organization_id := source.org_id;
    ELSIF TG_TABLE_NAME IN ('project_members','project_search_settings','query_suggestions') THEN
      project_value := source.project_id;
      SELECT org_id INTO organization_id FROM public.projects WHERE id=project_value;
    ELSIF TG_TABLE_NAME IN ('project_run_events','project_run_stage_states','performance_log') THEN
      run_value := source.run_id;
      SELECT org_id, project_id INTO organization_id, project_value FROM public.project_runs WHERE id=run_value;
    ELSE
      document_value := source.document_id;
      SELECT org_id, project_id, run_id INTO organization_id, project_value, run_value FROM public.documents WHERE id=document_value;
      -- Stage rows name the run that wrote them (a reindex run, too).
      -- Nested: one expression referencing source.run_id fails on tables without it.
      IF TG_TABLE_NAME='document_run_stage_states' THEN
        IF source.run_id IS NOT NULL THEN run_value := source.run_id; END IF;
      END IF;
    END IF;
    IF organization_id IS NOT NULL THEN
      INSERT INTO public.realtime_revision_counters(org_id,scope,revision,transaction_id)
      SELECT organization_id, scoped, 1, txid_current()
      FROM unnest(ARRAY['project:'||project_value, 'run:'||run_value]) AS scoped WHERE scoped IS NOT NULL
      ON CONFLICT(org_id,scope,transaction_id) DO NOTHING;
      PERFORM public.realtime_record_change(organization_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Page, chunk and page-stage rows arrive thousands per statement. As row triggers
-- they ran the lookup and both counter inserts once per row, although every row
-- after the first of a transaction is a no-op (ON CONFLICT DO NOTHING): a
-- 20,000-row document_chunks insert spent 1.7-1.9 s in the trigger. These three
-- tables use statement triggers with transition tables instead: one pass over the
-- statement's distinct (document, run) pairs, then one counter row per distinct
-- (organization, scope). The rows written are exactly those the row trigger left
-- behind, so subscribers see the same revisions: each affected scope moves by one
-- per transaction, and a statement that changes no row moves nothing.
-- A trigger with a transition table takes one event, hence three per table.
CREATE OR REPLACE FUNCTION realtime_statement_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  document_ids text[];
  run_ids text[];
  organization_ids text[];
  organization_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(TG_TABLE_NAME))
    OR TG_NAME<>'realtime_changed_'||pg_catalog.lower(TG_OP) OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'STATEMENT' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME NOT IN ('page_stage_states','document_pages','document_chunks') THEN
    RAISE EXCEPTION 'Unsupported realtime source';
  END IF;
  -- Old and new rows both: a row moved between documents or runs updates both scopes.
  IF TG_OP='INSERT' THEN
    SELECT array_agg(t.document_id), array_agg(t.run_id) INTO document_ids, run_ids
    FROM (SELECT DISTINCT document_id, run_id FROM new_rows) AS t;
  ELSIF TG_OP='DELETE' THEN
    SELECT array_agg(t.document_id), array_agg(t.run_id) INTO document_ids, run_ids
    FROM (SELECT DISTINCT document_id, run_id FROM old_rows) AS t;
  ELSE
    SELECT array_agg(t.document_id), array_agg(t.run_id) INTO document_ids, run_ids
    FROM (SELECT document_id, run_id FROM old_rows UNION SELECT document_id, run_id FROM new_rows) AS t;
  END IF;
  IF document_ids IS NULL THEN RETURN NULL; END IF;
  -- The row names the run that wrote it (a reindex run, too); else the document's run.
  WITH scopes AS MATERIALIZED (
    SELECT DISTINCT d.org_id, d.project_id, coalesce(t.run_id, d.run_id) AS run_id
    FROM unnest(document_ids, run_ids) AS t(document_id, run_id)
    JOIN public.documents d ON d.id=t.document_id
    WHERE d.org_id IS NOT NULL
  ), recorded AS (
    INSERT INTO public.realtime_revision_counters(org_id,scope,revision,transaction_id)
    SELECT DISTINCT s.org_id, scoped, 1, txid_current()
    FROM scopes s, unnest(ARRAY['project:'||s.project_id, 'run:'||s.run_id]) AS scoped WHERE scoped IS NOT NULL
    ON CONFLICT(org_id,scope,transaction_id) DO NOTHING
  )
  SELECT array_agg(DISTINCT s.org_id) INTO organization_ids FROM scopes s;
  IF organization_ids IS NULL THEN RETURN NULL; END IF;
  FOREACH organization_id IN ARRAY organization_ids LOOP
    PERFORM public.realtime_record_change(organization_id);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_search_session_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  project_id_value text;
  old_project_id text;
  new_project_id text;
  organization_id text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>'public.search_sessions'::pg_catalog.regclass
    OR TG_NAME<>'realtime_changed' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  IF TG_OP<>'INSERT' THEN old_project_id := coalesce(OLD.project_id, OLD.metadata->>'projectId'); END IF;
  IF TG_OP<>'DELETE' THEN new_project_id := coalesce(NEW.project_id, NEW.metadata->>'projectId'); END IF;
  FOR project_id_value IN SELECT DISTINCT value FROM unnest(ARRAY[old_project_id,new_project_id]) AS value WHERE value IS NOT NULL ORDER BY value LOOP
    organization_id := NULL;
    SELECT org_id INTO organization_id FROM public.projects WHERE id=project_id_value;
    IF organization_id IS NOT NULL THEN
      INSERT INTO public.realtime_revision_counters(org_id,scope,revision,transaction_id)
      VALUES(organization_id,'project:'||project_id_value,1,txid_current())
      ON CONFLICT(org_id,scope,transaction_id) DO NOTHING;
      PERFORM public.realtime_record_change(organization_id);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION realtime_materialization_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE organization_id text; project_value text; run_value text;
BEGIN
  IF TG_TABLE_SCHEMA<>'public' OR TG_RELID<>'public.document_page_states'::pg_catalog.regclass
    OR TG_NAME<>'realtime_changed' OR TG_WHEN<>'AFTER' OR TG_LEVEL<>'ROW' OR TG_NARGS<>0 THEN
    RAISE EXCEPTION 'untrusted realtime trigger source' USING ERRCODE='42501';
  END IF;
  SELECT org_id, project_id, run_id INTO organization_id, project_value, run_value
  FROM public.documents WHERE id=coalesce(NEW.document_id,OLD.document_id);
  IF organization_id IS NOT NULL THEN
    INSERT INTO public.realtime_revision_counters(org_id,scope,revision,transaction_id)
    SELECT organization_id, scoped, 1, txid_current()
    FROM unnest(ARRAY['project:'||project_value, 'run:'||run_value]) AS scoped WHERE scoped IS NOT NULL
    ON CONFLICT(org_id,scope,transaction_id) DO NOTHING;
    PERFORM public.realtime_record_change(organization_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- CREATE OR REPLACE keeps each function's owner (docslurp_realtime_publisher) and ACL;
-- restate the revocations, and expose the new view exactly like realtime_revisions.
-- The new statement function gets the same owner the same way 0120 did it: the
-- publisher may create in the schema only for the duration of the ownership change.
GRANT CREATE ON SCHEMA public TO docslurp_realtime_publisher;
ALTER FUNCTION public.realtime_statement_changed() OWNER TO docslurp_realtime_publisher;
REVOKE CREATE ON SCHEMA public FROM docslurp_realtime_publisher;
REVOKE ALL ON FUNCTION public.realtime_changed(),public.realtime_statement_changed(),public.realtime_search_session_changed(),
  public.realtime_materialization_changed(),public.realtime_record_change(text),
  public.realtime_fold_committed(text),public.realtime_compact_revisions(text) FROM PUBLIC;
REVOKE ALL ON public.realtime_revision_counters,public.realtime_revisions,public.realtime_scope_revisions FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['docslurp_app','docslurp_worker'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=runtime_role) THEN CONTINUE; END IF;
    EXECUTE format('REVOKE ALL ON public.realtime_scope_revisions FROM %I',runtime_role);
    EXECUTE format('REVOKE ALL ON FUNCTION public.realtime_statement_changed() FROM %I',runtime_role);
    IF runtime_role='docslurp_app' THEN
      EXECUTE format('GRANT SELECT ON public.realtime_scope_revisions TO %I',runtime_role);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Last, so the SHARE ROW EXCLUSIVE lock each trigger change takes on these ingest
-- tables is held for as little of the migration transaction as possible. Row and
-- statement triggers swap in one transaction: no change goes unrecorded.
DO $$
DECLARE source text;
BEGIN
  FOREACH source IN ARRAY ARRAY['page_stage_states','document_pages','document_chunks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS realtime_changed ON public.%I', source);
    EXECUTE format('CREATE OR REPLACE TRIGGER realtime_changed_insert AFTER INSERT ON public.%I
      REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_statement_changed()', source);
    EXECUTE format('CREATE OR REPLACE TRIGGER realtime_changed_update AFTER UPDATE ON public.%I
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_statement_changed()', source);
    EXECUTE format('CREATE OR REPLACE TRIGGER realtime_changed_delete AFTER DELETE ON public.%I
      REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.realtime_statement_changed()', source);
  END LOOP;
END $$;
