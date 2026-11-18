-- Hot-path query audit: indexes for queries that ran on every run creation, document delete, metrics scrape or
-- per-run billing read and fell back to scanning a large table, plus removal of exact duplicate indexes that only cost
-- writes. Each addition is explained below; server/src/__tests__/hot-query-plans.db.test.ts asserts the plans.
--
-- Locking: every build holds SHARE on its table for one pass (as 0187, 0194 and 0195; CONCURRENTLY cannot run in a
-- transaction), blocking that table's writes until the migration commits. Each statement waits at most 5 s for its lock
-- and fails the release instead of queueing writers behind a long-open transaction; a retried deploy finishes the work.
-- Every statement is idempotent.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

-- Exact duplicates from the initial schema (0000 created each of these twice; 0008 already dropped the vector ones).
-- Every insert paid for both copies, including two GIN builds per chunk and proposition.
DROP INDEX IF EXISTS document_chunks_ts_content_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_chunks_user_id_run_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_pages_document_id_page_number_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_pages_run_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_summaries_user_id_run_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_propositions_document_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_propositions_user_id_run_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS document_propositions_ts_content_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_sessions_user_id_created_at_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_session_results_session_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_session_results_chunk_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_eval_fixtures_user_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_index_staleness_user_id_detected_at_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_index_staleness_run_id_idx1;
--> statement-breakpoint
DROP INDEX IF EXISTS search_experiments_user_id_active_idx1;
--> statement-breakpoint

-- usage_attribution.source_run_id is coalesce(run_id, metadata->>'runId') (the run key that survives run deletion).
-- No index served it, so pending_monthly_capacity (one subquery per active run), the monthly_run_capacity trigger on
-- every run insert, run readmission, materialization capacity and the run cost panels each scanned usage_events. The
-- planner matches this expression through the view.
CREATE INDEX IF NOT EXISTS usage_events_source_run_idx ON usage_events ((coalesce(run_id, metadata ->> 'runId')));
--> statement-breakpoint

-- Time windows across every organization (provider cost loss, the monthly budget sweep, the /metrics cost window, the
-- monthly_run_capacity trigger's split-event branch) read usage_events by created_at alone. Rows arrive in created_at
-- order, so a BRIN range index serves those windows at a fraction of a btree's size and insert cost.
CREATE INDEX IF NOT EXISTS usage_events_created_brin ON usage_events USING brin (created_at) WITH (autosummarize = on);
--> statement-breakpoint

-- Foreign keys to documents without an index on the child column: every document delete (run-creation expiry every few
-- seconds, retention, extract deletion, offboarding) ran one sequential scan of each of these tables per document.
-- usage_events and project_run_events hold many rows without a document, so their indexes are partial; a foreign key
-- check (document_id = $1) implies the predicate.
CREATE INDEX IF NOT EXISTS usage_events_document_id_idx ON usage_events (document_id) WHERE document_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_run_events_document_id_idx ON project_run_events (document_id) WHERE document_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_work_tasks_document_id_idx ON page_work_tasks (document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_stage_states_document_id_idx ON page_stage_states (document_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_run_stage_states_document_id_idx ON document_run_stage_states (document_id);
--> statement-breakpoint
-- Also the chat turn's retrieved-document summaries and media evidence (latest summary per document).
CREATE INDEX IF NOT EXISTS document_summaries_document_created_idx ON document_summaries (document_id, created_at DESC);
--> statement-breakpoint

-- Retention deletes (performance_log by created_at, api_key_usage by minute_bucket) and the /metrics stage-duration
-- window. Both tables are append-mostly in time order.
CREATE INDEX IF NOT EXISTS performance_log_created_brin ON performance_log USING brin (created_at) WITH (autosummarize = on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_key_usage_minute_brin ON api_key_usage USING brin (minute_bucket) WITH (autosummarize = on);
--> statement-breakpoint

-- monthly_run_capacity runs on every run insert and every move into an active status. It summed the organization's
-- month of usage (through the derived org_id, which no index serves), every active run's remaining reservation and the
-- run's own usage before looking at the caps, so an organization without any monthly budget paid three scans of
-- usage_events per run. It now returns once it knows neither scope has a cap (after the same privilege check on the
-- capacity view, which keeps refusing worker reactivation), and the month sum filters on the stamped
-- columns first (the exact superset orgAttributedUsage uses, migration 0187). Errors and their order are unchanged.
CREATE OR REPLACE FUNCTION reserve_monthly_run_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org_cap numeric; project_cap numeric; org_used numeric; project_used numeric; demand numeric;
BEGIN
 IF NEW.status NOT IN ('queued','processing') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status IN ('queued','processing') AND OLD.monthly_reservation_cents=NEW.monthly_reservation_cents THEN RETURN NEW; END IF;
 IF NEW.monthly_reservation_cents IS NULL OR NEW.monthly_reservation_cents < 1 THEN RAISE EXCEPTION 'Invalid monthly capacity'; END IF;
 PERFORM pg_advisory_xact_lock(spend_admission_lock_key(NEW.org_id));
 SELECT monthly_budget_cents INTO org_cap FROM organizations WHERE id=NEW.org_id;
 SELECT monthly_budget_cents INTO project_cap FROM projects WHERE id=NEW.project_id AND org_id=NEW.org_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Run billing scope mismatch'; END IF;
 -- Admission into an active status reads API-only capacity state, so a role without access to it (the worker) is still
 -- refused here with or without a cap (db-roles.test.ts). WHERE false keeps the privilege check and reads nothing.
 PERFORM 1 FROM pending_monthly_capacity WHERE false;
 IF org_cap IS NULL AND project_cap IS NULL THEN RETURN NEW; END IF;
 SELECT coalesce(sum(cost_cents),0), coalesce(sum(cost_cents) FILTER (WHERE project_id=NEW.project_id),0)
 INTO org_used, project_used FROM usage_attribution
 WHERE created_at>=date_trunc('month',now())
   AND (stamped_org_id=NEW.org_id OR stamped_org_id IS NULL OR (stamped_project_id IS NULL AND metadata ? 'projectIds'))
   AND org_id=NEW.org_id;
 SELECT org_used+coalesce(sum(cents),0),project_used+coalesce(sum(cents) FILTER (WHERE project_id=NEW.project_id),0)
 INTO org_used,project_used FROM pending_monthly_capacity WHERE org_id=NEW.org_id AND run_id<>NEW.id;
 SELECT greatest(0,NEW.monthly_reservation_cents-coalesce(sum(cost_cents),0)) INTO demand
 FROM usage_attribution WHERE source_run_id=NEW.id;
 IF org_cap IS NOT NULL AND org_used+demand>org_cap THEN
   RAISE EXCEPTION 'Monthly organization capacity exhausted' USING ERRCODE='P4021';
 END IF;
 IF project_cap IS NOT NULL AND project_used+demand>project_cap THEN
   RAISE EXCEPTION 'Monthly project capacity exhausted' USING ERRCODE='P4022';
 END IF;
 RETURN NEW;
END $$;
