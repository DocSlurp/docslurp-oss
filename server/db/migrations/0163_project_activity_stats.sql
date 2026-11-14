-- Per-project search and chat counters, maintained at write time.
--
-- The project list (listProjects, GET /v1/projects/:id) counted a project's search sessions and chat turns on every
-- call, and the project board read every search session of the caller's projects to average its duration. Both grew
-- with history: at 1,000,000 sessions and 60,000 chat turns the list took about half a second and the board longer.
-- They now read project_activity_stats, as document totals already come from project_corpus_stats.
--
-- Exact, not approximate: every counter equals the aggregate it replaces at every commit.
--   search_sessions        count(*)                          of sessions with this project_id
--   search_result_count    sum(result_count)
--   zero_result_searches   count(*) where result_count = 0
--   search_duration_count  count of sessions whose metadata carries a durationMs
--   search_duration_ms     their sum (numeric, so adding and removing a value is exact)
--   chat_turns             count(*) of chat_turns whose session is in this project
-- Sessions without a project_id (0152: older rows the backfill sweep has not reached, and rows whose project is gone)
-- are in no counter, exactly as they were in no project read; the sweep's UPDATE adds them when it sets the column.
--
-- Contention: a single counter row per project would make every concurrent search in one project wait for the
-- previous one's commit. Each project has up to 8 rows instead; a backend writes the row numbered by its process id,
-- so two connections wait for each other only when they share a row, and a read sums at most 8 rows per project.
--
-- Statement-level triggers with transition tables: one counter write per statement and project, however many rows
-- the statement touches. A project delete that cascades to 500,000 sessions, a retention batch and the 0152 sweep's
-- batches each cost one aggregate, where a row-level trigger would update the same counter row once per session.
--
-- Release N-1 keeps working: it writes the same tables and the triggers count its rows; it never reads this table.
--
-- destructive-migration: nothing is removed. The only matches are the AFTER TRUNCATE trigger events below, which zero the counters when someone truncates a table.
-- idempotent-migration: the backfill deletes every counter row and re-inserts the aggregates while writers are locked out, so a second run stores the same totals.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_activity_stats" (
  "project_id" text NOT NULL,
  "slot" smallint NOT NULL,
  "search_sessions" bigint NOT NULL DEFAULT 0,
  "search_result_count" bigint NOT NULL DEFAULT 0,
  "zero_result_searches" bigint NOT NULL DEFAULT 0,
  "search_duration_count" bigint NOT NULL DEFAULT 0,
  "search_duration_ms" numeric NOT NULL DEFAULT 0,
  "chat_turns" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "project_activity_stats_pkey" PRIMARY KEY ("project_id", "slot"),
  CONSTRAINT "project_activity_stats_slot_check" CHECK ("slot" >= 0 AND "slot" < 8),
  CONSTRAINT "project_activity_stats_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
) WITH (fillfactor = 50);
--> statement-breakpoint
-- The duration the project board averages: metadata.durationMs as the search wrote it (a JSON number). Two older
-- shapes are read as the board read them: a numeric string, and metadata stored as a JSON string holding an object.
-- Anything else, NaN and infinities are no duration. Neither function raises, so no metadata value can fail a
-- search insert or delete.
CREATE OR REPLACE FUNCTION search_session_legacy_duration_ms(metadata jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  m jsonb := metadata;
  v jsonb;
  n numeric;
BEGIN
  IF jsonb_typeof(m) = 'string' THEN
    BEGIN
      m := (m #>> '{}')::jsonb;
    EXCEPTION WHEN others THEN
      RETURN NULL;
    END;
  END IF;
  IF m IS NULL OR jsonb_typeof(m) <> 'object' THEN RETURN NULL; END IF;
  v := m -> 'durationMs';
  IF v IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) = 'number' THEN RETURN (v #>> '{}')::numeric; END IF;
  IF jsonb_typeof(v) <> 'string' THEN RETURN NULL; END IF;
  BEGIN
    n := (v #>> '{}')::numeric;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF n = 'NaN'::numeric OR n = 'Infinity'::numeric OR n = '-Infinity'::numeric THEN RETURN NULL; END IF;
  RETURN n;
END $$;
--> statement-breakpoint
-- A plain SQL function with no SET clause, so the planner inlines it: the usual shape costs two jsonb lookups per
-- row and no function call (the backfill below reads every session: 0.9 s per million rows inlined, 2.8 s as a
-- PL/pgSQL call). It names only pg_catalog built-ins and the schema-qualified function above.
CREATE OR REPLACE FUNCTION search_session_duration_ms(metadata jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(metadata) = 'object' AND pg_catalog.jsonb_typeof(metadata -> 'durationMs') = 'number'
      THEN (metadata ->> 'durationMs')::numeric
    WHEN pg_catalog.jsonb_typeof(metadata) = 'string' OR pg_catalog.jsonb_typeof(metadata -> 'durationMs') = 'string'
      THEN public.search_session_legacy_duration_ms(metadata)
  END
$$;
--> statement-breakpoint
-- One function for the three search_sessions triggers. PL/pgSQL plans a statement when it first runs, so each
-- trigger only ever plans the branch whose transition tables it has.
-- Rows are written in project_id order, so two statements that each touch several projects take their counter
-- rows in the same order. A project that no longer exists (its delete cascades here) is skipped: its counters go
-- with it, and inserting them again would violate the foreign key.
CREATE OR REPLACE FUNCTION apply_search_session_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.project_activity_stats AS s
      (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
    SELECT d.project_id, pg_backend_pid() % 8, count(*), sum(d.result_count::bigint),
      count(*) FILTER (WHERE d.result_count = 0), count(d.duration_ms), coalesce(sum(d.duration_ms), 0)
    FROM (
      SELECT n.project_id, n.result_count, public.search_session_duration_ms(n.metadata) AS duration_ms
      FROM new_rows n WHERE n.project_id IS NOT NULL
    ) d
    GROUP BY d.project_id
    ORDER BY d.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET
      search_sessions = s.search_sessions + EXCLUDED.search_sessions,
      search_result_count = s.search_result_count + EXCLUDED.search_result_count,
      zero_result_searches = s.zero_result_searches + EXCLUDED.zero_result_searches,
      search_duration_count = s.search_duration_count + EXCLUDED.search_duration_count,
      search_duration_ms = s.search_duration_ms + EXCLUDED.search_duration_ms;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.project_activity_stats AS s
      (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
    SELECT d.project_id, pg_backend_pid() % 8, -count(*), -sum(d.result_count::bigint),
      -(count(*) FILTER (WHERE d.result_count = 0)), -count(d.duration_ms), -coalesce(sum(d.duration_ms), 0)
    FROM (
      SELECT o.project_id, o.result_count, public.search_session_duration_ms(o.metadata) AS duration_ms
      FROM old_rows o WHERE o.project_id IS NOT NULL
    ) d
    WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
    GROUP BY d.project_id
    ORDER BY d.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET
      search_sessions = s.search_sessions + EXCLUDED.search_sessions,
      search_result_count = s.search_result_count + EXCLUDED.search_result_count,
      zero_result_searches = s.zero_result_searches + EXCLUDED.zero_result_searches,
      search_duration_count = s.search_duration_count + EXCLUDED.search_duration_count,
      search_duration_ms = s.search_duration_ms + EXCLUDED.search_duration_ms;
  ELSIF TG_OP = 'UPDATE' THEN
    -- New values minus old values per project; a project whose totals did not change gets no write. This covers
    -- a changed result_count or metadata, a project_id set by the 0152 sweep, and a session moved between projects.
    INSERT INTO public.project_activity_stats AS s
      (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
    SELECT d.project_id, pg_backend_pid() % 8, sum(d.sign), sum(d.sign * d.result_count::bigint),
      coalesce(sum(d.sign) FILTER (WHERE d.result_count = 0), 0),
      coalesce(sum(d.sign) FILTER (WHERE d.duration_ms IS NOT NULL), 0),
      coalesce(sum(d.sign * d.duration_ms), 0)
    FROM (
      SELECT n.project_id, 1 AS sign, n.result_count, public.search_session_duration_ms(n.metadata) AS duration_ms
      FROM new_rows n WHERE n.project_id IS NOT NULL
      UNION ALL
      SELECT o.project_id, -1 AS sign, o.result_count, public.search_session_duration_ms(o.metadata) AS duration_ms
      FROM old_rows o WHERE o.project_id IS NOT NULL
    ) d
    WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
    GROUP BY d.project_id
    HAVING sum(d.sign) <> 0
      OR sum(d.sign * d.result_count::bigint) <> 0
      OR coalesce(sum(d.sign) FILTER (WHERE d.result_count = 0), 0) <> 0
      OR coalesce(sum(d.sign) FILTER (WHERE d.duration_ms IS NOT NULL), 0) <> 0
      OR coalesce(sum(d.sign * d.duration_ms), 0) <> 0
    ORDER BY d.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET
      search_sessions = s.search_sessions + EXCLUDED.search_sessions,
      search_result_count = s.search_result_count + EXCLUDED.search_result_count,
      zero_result_searches = s.zero_result_searches + EXCLUDED.zero_result_searches,
      search_duration_count = s.search_duration_count + EXCLUDED.search_duration_count,
      search_duration_ms = s.search_duration_ms + EXCLUDED.search_duration_ms;
  ELSIF TG_OP = 'TRUNCATE' THEN
    UPDATE public.project_activity_stats
    SET search_sessions = 0, search_result_count = 0, zero_result_searches = 0,
        search_duration_count = 0, search_duration_ms = 0
    WHERE search_sessions <> 0 OR search_result_count <> 0 OR zero_result_searches <> 0
       OR search_duration_count <> 0 OR search_duration_ms <> 0;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Chat turns carry no project: it is their session's. A turn whose session is no longer visible is being removed
-- by that session's delete, which apply_chat_session_activity_stats() below has already counted.
--
-- Every branch first takes a key-share lock on the sessions involved (the lock a turn insert's foreign-key check
-- takes anyway). A session being deleted or moved to another project holds FOR UPDATE on its row, so this waits
-- for that transaction and then reads the session's project as committed; without it a turn deleted while its
-- session moved would be subtracted from the old project after the move had already carried it to the new one.
-- Deleting single turns of a session that is being deleted at the same moment can deadlock on that lock; Postgres
-- aborts one of the two and no count is lost (no code deletes single turns).
CREATE OR REPLACE FUNCTION apply_chat_turn_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.chat_sessions cs
    WHERE cs.id IN (SELECT t.session_id FROM new_rows t) ORDER BY cs.id FOR KEY SHARE;
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT cs.project_id, pg_backend_pid() % 8, count(*)
    FROM new_rows t JOIN public.chat_sessions cs ON cs.id = t.session_id
    GROUP BY cs.project_id
    ORDER BY cs.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public.chat_sessions cs
    WHERE cs.id IN (SELECT t.session_id FROM old_rows t) ORDER BY cs.id FOR KEY SHARE;
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT cs.project_id, pg_backend_pid() % 8, -count(*)
    FROM old_rows t JOIN public.chat_sessions cs ON cs.id = t.session_id
    WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = cs.project_id)
    GROUP BY cs.project_id
    ORDER BY cs.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A turn moved to another session (no code does this): one row, so a row-level trigger.
    PERFORM 1 FROM public.chat_sessions cs
    WHERE cs.id IN (OLD.session_id, NEW.session_id) ORDER BY cs.id FOR KEY SHARE;
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT d.project_id, pg_backend_pid() % 8, sum(d.sign)
    FROM (
      SELECT cs.project_id, 1 AS sign FROM public.chat_sessions cs WHERE cs.id = NEW.session_id
      UNION ALL
      SELECT cs.project_id, -1 AS sign FROM public.chat_sessions cs WHERE cs.id = OLD.session_id
    ) d
    WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
    GROUP BY d.project_id
    HAVING sum(d.sign) <> 0
    ORDER BY d.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  ELSIF TG_OP = 'TRUNCATE' THEN
    UPDATE public.project_activity_stats SET chat_turns = 0 WHERE chat_turns <> 0;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- A chat session leaving its project (deleted, or moved to another project) takes its turns' count with it.
-- BEFORE the row changes, because the cascade removes the turns before any AFTER trigger could count them.
-- FOR UPDATE on the session makes the count final: turn inserts and deletes hold a key-share lock on their session
-- until they commit (above), so this waits for the ones in flight and counts their result, and later ones wait for
-- this transaction and then see the session gone or in its new project. When the project itself is gone (its
-- delete cascades here) nothing is written: its counters go with it.
CREATE OR REPLACE FUNCTION apply_chat_session_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  turn_count bigint;
  target_project_id text := CASE WHEN TG_OP = 'UPDATE' THEN NEW.project_id END;
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  PERFORM 1 FROM public.chat_sessions cs WHERE cs.id = OLD.id FOR UPDATE;
  SELECT count(*) INTO turn_count FROM public.chat_turns t WHERE t.session_id = OLD.id;
  IF turn_count > 0 THEN
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT d.project_id, pg_backend_pid() % 8, d.turns
    FROM (VALUES (OLD.project_id, -turn_count), (target_project_id, turn_count)) AS d(project_id, turns)
    WHERE d.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
    ORDER BY d.project_id
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
-- Writers wait from here until the migration transaction commits, so the backfill below and the triggers see the
-- same rows: no session or turn is counted twice or missed. Readers are not blocked. With lock_timeout this fails
-- fast behind a long-open writer instead of queueing every search behind it; a retried deploy finishes the work.
LOCK TABLE "search_sessions", "chat_sessions", "chat_turns" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER search_sessions_activity_stats_insert AFTER INSERT ON "search_sessions"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION apply_search_session_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER search_sessions_activity_stats_update AFTER UPDATE ON "search_sessions"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION apply_search_session_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER search_sessions_activity_stats_delete AFTER DELETE ON "search_sessions"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION apply_search_session_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER search_sessions_activity_stats_truncate AFTER TRUNCATE ON "search_sessions"
FOR EACH STATEMENT EXECUTE FUNCTION apply_search_session_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER chat_turns_activity_stats_insert AFTER INSERT ON "chat_turns"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION apply_chat_turn_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER chat_turns_activity_stats_delete AFTER DELETE ON "chat_turns"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION apply_chat_turn_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER chat_turns_activity_stats_move AFTER UPDATE OF session_id ON "chat_turns"
FOR EACH ROW WHEN (OLD.session_id IS DISTINCT FROM NEW.session_id) EXECUTE FUNCTION apply_chat_turn_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER chat_turns_activity_stats_truncate AFTER TRUNCATE ON "chat_turns"
FOR EACH STATEMENT EXECUTE FUNCTION apply_chat_turn_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER chat_sessions_activity_stats_delete BEFORE DELETE ON "chat_sessions"
FOR EACH ROW EXECUTE FUNCTION apply_chat_session_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER chat_sessions_activity_stats_move BEFORE UPDATE OF project_id ON "chat_sessions"
FOR EACH ROW WHEN (OLD.project_id IS DISTINCT FROM NEW.project_id) EXECUTE FUNCTION apply_chat_session_activity_stats();
--> statement-breakpoint
-- Backfill: one pass over each table (measured: about 1 s per million search sessions), all totals in slot 0.
DELETE FROM "project_activity_stats";
--> statement-breakpoint
INSERT INTO "project_activity_stats" AS s
  (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
SELECT d.project_id, 0, count(*), sum(d.result_count::bigint), count(*) FILTER (WHERE d.result_count = 0),
  count(d.duration_ms), coalesce(sum(d.duration_ms), 0)
FROM (
  SELECT ss.project_id, ss.result_count, search_session_duration_ms(ss.metadata) AS duration_ms
  FROM "search_sessions" ss WHERE ss.project_id IS NOT NULL
) d
GROUP BY d.project_id
ON CONFLICT (project_id, slot) DO UPDATE SET
  search_sessions = EXCLUDED.search_sessions,
  search_result_count = EXCLUDED.search_result_count,
  zero_result_searches = EXCLUDED.zero_result_searches,
  search_duration_count = EXCLUDED.search_duration_count,
  search_duration_ms = EXCLUDED.search_duration_ms;
--> statement-breakpoint
INSERT INTO "project_activity_stats" AS s (project_id, slot, chat_turns)
SELECT cs.project_id, 0, count(*)
FROM "chat_turns" t JOIN "chat_sessions" cs ON cs.id = t.session_id
GROUP BY cs.project_id
ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = EXCLUDED.chat_turns;
