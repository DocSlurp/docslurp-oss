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
-- A project's counters are the sum of its rows. A counter write never waits for a lock:
--   - it adds to the first of the project's rows that no other transaction has locked (FOR UPDATE SKIP LOCKED), or
--     inserts a new row when every row is taken. Skipping a locked row loses nothing: the amount is always written
--     to some row in the writer's own transaction, so it commits or rolls back with the session or turn it counts.
--   - the table has no foreign key to projects, so a write never waits for a project row either.
-- Two transactions therefore cannot deadlock on counter rows, in whatever order they touch projects, and a search
-- or chat write is never queued behind another one's commit. A project has at most as many rows as it ever had
-- writing transactions open at the same moment (bounded by the connection count); a read sums them, and
-- compact_project_activity_stats() (the maintenance sweep) and rebuild_project_activity_stats() fold them back
-- into one.
--
-- Why no foreign key: with one, a project delete (which holds the project row and waits for the session rows its
-- cascade removes) and a writer holding one of those session rows (whose counter insert then waits for the project
-- row in the foreign-key check) wait for each other, and Postgres aborts one of them as a deadlock. Instead a
-- trigger on projects removes the counter rows. It is named to sort after the foreign-key cascade triggers, so it
-- runs once the delete holds every session and turn of the project: every writer that could still add to those
-- rows has committed or is waiting for the delete, and no row is left behind.
--
-- Statement-level triggers with transition tables: one counter write per statement and project, however many rows
-- the statement touches. A project delete that cascades to 500,000 sessions, a retention batch and the 0152 sweep's
-- batches each cost one aggregate, where a row-level trigger would update the same counter row once per session.
--
-- If the counters ever differ from history (triggers disabled, session_replication_role = replica, a manual fix,
-- a partial restore): project_activity_stats_drift() lists the projects, rebuild_project_activity_stats() repairs
-- them. See docs/self-host/operations.md.
--
-- Release N-1 keeps working: it writes the same tables and the triggers count its rows; it never reads this table.
--
-- Locks this migration takes, all held until the migration transaction commits. Every pending migration commits in
-- that one transaction, so these are also held while later migrations of the same deploy run, and anything an
-- earlier pending migration locked (ACCESS EXCLUSIVE included, which does block readers) stays locked while this one
-- runs.
--   projects                                     SHARE ROW EXCLUSIVE (CREATE TRIGGER): project inserts, updates and
--                                                deletes wait; reads do not.
--   search_sessions, chat_sessions, chat_turns   SHARE ROW EXCLUSIVE (LOCK TABLE and CREATE TRIGGER): searches and
--                                                chat writes wait while the backfill reads every session and turn
--                                                (about 1 s per million search sessions); reads do not.
-- lock_timeout makes each of them fail fast behind a long-open transaction instead of queueing traffic behind it;
-- a retried deploy finishes the work.
--
-- destructive-migration: nothing is removed. The matches are the AFTER DELETE and AFTER TRUNCATE trigger events below (they remove or zero counters when their project or history goes) the rebuild function, which replaces every counter row with the same totals recomputed, and the fold function, which merges a project's counter rows into one with the same totals.
-- idempotent-migration: the backfill calls rebuild_project_activity_stats(), which deletes every counter row and re-inserts the aggregates while writers are locked out, so a second run stores the same totals.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_activity_stats" (
  "project_id" text NOT NULL,
  "slot" bigint GENERATED ALWAYS AS IDENTITY,
  "search_sessions" bigint NOT NULL DEFAULT 0,
  "search_result_count" bigint NOT NULL DEFAULT 0,
  "zero_result_searches" bigint NOT NULL DEFAULT 0,
  "search_duration_count" bigint NOT NULL DEFAULT 0,
  "search_duration_ms" numeric NOT NULL DEFAULT 0,
  "chat_turns" bigint NOT NULL DEFAULT 0,
  CONSTRAINT "project_activity_stats_pkey" PRIMARY KEY ("project_id", "slot")
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
-- Adds one statement's amounts to a project's counters without waiting for any lock (see the top of this file).
-- The inner SELECT locks the project's first row that no other transaction holds; a row this transaction already
-- wrote counts as free, so a transaction keeps to one row per project. When there is none, the amounts go into a
-- new row: slot is an identity value, so the insert cannot collide with another one.
CREATE OR REPLACE FUNCTION project_activity_stats_add(
  p_project_id text, p_search_sessions bigint, p_search_result_count bigint, p_zero_result_searches bigint,
  p_search_duration_count bigint, p_search_duration_ms numeric, p_chat_turns bigint
) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF p_project_id IS NULL OR (p_search_sessions = 0 AND p_search_result_count = 0 AND p_zero_result_searches = 0
      AND p_search_duration_count = 0 AND p_search_duration_ms = 0 AND p_chat_turns = 0) THEN
    RETURN;
  END IF;
  UPDATE public.project_activity_stats s SET
    search_sessions = s.search_sessions + p_search_sessions,
    search_result_count = s.search_result_count + p_search_result_count,
    zero_result_searches = s.zero_result_searches + p_zero_result_searches,
    search_duration_count = s.search_duration_count + p_search_duration_count,
    search_duration_ms = s.search_duration_ms + p_search_duration_ms,
    chat_turns = s.chat_turns + p_chat_turns
  WHERE s.project_id = p_project_id AND s.slot = (
    SELECT c.slot FROM public.project_activity_stats c
    WHERE c.project_id = p_project_id ORDER BY c.slot LIMIT 1 FOR UPDATE SKIP LOCKED
  );
  IF NOT FOUND THEN
    INSERT INTO public.project_activity_stats
      (project_id, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms, chat_turns)
    VALUES (p_project_id, p_search_sessions, p_search_result_count, p_zero_result_searches,
      p_search_duration_count, p_search_duration_ms, p_chat_turns);
  END IF;
END $$;
--> statement-breakpoint
-- One function for the three search_sessions triggers. PL/pgSQL plans a statement when it first runs, so each
-- trigger only ever plans the branch whose transition tables it has. An upsert fires both the insert and the update
-- trigger; the one whose transition tables are empty aggregates nothing and writes nothing.
-- A project that no longer exists (its delete cascades here) is skipped: its counters go with it.
CREATE OR REPLACE FUNCTION apply_search_session_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The session's own foreign key has already checked that the project exists.
    PERFORM public.project_activity_stats_add(g.project_id, g.sessions, g.results, g.zero, g.durations, g.duration_ms, 0)
    FROM (
      SELECT d.project_id, count(*) AS sessions, sum(d.result_count::bigint)::bigint AS results,
        count(*) FILTER (WHERE d.result_count = 0) AS zero, count(d.duration_ms) AS durations,
        coalesce(sum(d.duration_ms), 0) AS duration_ms
      FROM (
        SELECT n.project_id, n.result_count, public.search_session_duration_ms(n.metadata) AS duration_ms
        FROM new_rows n WHERE n.project_id IS NOT NULL
      ) d
      GROUP BY d.project_id
    ) g;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM public.project_activity_stats_add(g.project_id, -g.sessions, -g.results, -g.zero, -g.durations, -g.duration_ms, 0)
    FROM (
      SELECT d.project_id, count(*) AS sessions, sum(d.result_count::bigint)::bigint AS results,
        count(*) FILTER (WHERE d.result_count = 0) AS zero, count(d.duration_ms) AS durations,
        coalesce(sum(d.duration_ms), 0) AS duration_ms
      FROM (
        SELECT o.project_id, o.result_count, public.search_session_duration_ms(o.metadata) AS duration_ms
        FROM old_rows o WHERE o.project_id IS NOT NULL
      ) d
      WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
      GROUP BY d.project_id
    ) g;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Every search insert is an upsert, which fires this trigger with nothing updated: leave before the aggregate.
    PERFORM 1 FROM new_rows LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- New values minus old values per project; a project whose totals did not change gets no write and no row
    -- lock. This covers a changed result_count or metadata, a project_id set by the 0152 sweep, and a session moved
    -- between projects.
    PERFORM public.project_activity_stats_add(g.project_id, g.sessions, g.results, g.zero, g.durations, g.duration_ms, 0)
    FROM (
      SELECT d.project_id, sum(d.sign)::bigint AS sessions, sum(d.sign * d.result_count::bigint)::bigint AS results,
        coalesce(sum(d.sign) FILTER (WHERE d.result_count = 0), 0)::bigint AS zero,
        coalesce(sum(d.sign) FILTER (WHERE d.duration_ms IS NOT NULL), 0)::bigint AS durations,
        coalesce(sum(d.sign * d.duration_ms), 0) AS duration_ms
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
    ) g;
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
-- Deleting single turns of a session that is being deleted at the same moment can deadlock on that session lock
-- (not on a counter row); Postgres aborts one of the two and no count is lost (no code deletes single turns).
CREATE OR REPLACE FUNCTION apply_chat_turn_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.chat_sessions cs
    WHERE cs.id IN (SELECT t.session_id FROM new_rows t) ORDER BY cs.id FOR KEY SHARE;
    PERFORM public.project_activity_stats_add(g.project_id, 0, 0, 0, 0, 0, g.turns)
    FROM (
      SELECT cs.project_id, count(*) AS turns
      FROM new_rows t JOIN public.chat_sessions cs ON cs.id = t.session_id
      GROUP BY cs.project_id
    ) g;
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public.chat_sessions cs
    WHERE cs.id IN (SELECT t.session_id FROM old_rows t) ORDER BY cs.id FOR KEY SHARE;
    PERFORM public.project_activity_stats_add(g.project_id, 0, 0, 0, 0, 0, -g.turns)
    FROM (
      SELECT cs.project_id, count(*) AS turns
      FROM old_rows t JOIN public.chat_sessions cs ON cs.id = t.session_id
      WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = cs.project_id)
      GROUP BY cs.project_id
    ) g;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A turn moved to another session (no code does this): one row, so a row-level trigger.
    PERFORM 1 FROM public.chat_sessions cs
    WHERE cs.id IN (OLD.session_id, NEW.session_id) ORDER BY cs.id FOR KEY SHARE;
    PERFORM public.project_activity_stats_add(g.project_id, 0, 0, 0, 0, 0, g.turns)
    FROM (
      SELECT d.project_id, sum(d.sign)::bigint AS turns
      FROM (
        SELECT cs.project_id, 1 AS sign FROM public.chat_sessions cs WHERE cs.id = NEW.session_id
        UNION ALL
        SELECT cs.project_id, -1 AS sign FROM public.chat_sessions cs WHERE cs.id = OLD.session_id
      ) d
      WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
      GROUP BY d.project_id
      HAVING sum(d.sign) <> 0
    ) g;
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
-- This runs once per session, so one statement that removes sessions of several projects writes their counters in
-- row order, and a transaction may delete sessions over several statements; neither can deadlock with another such
-- transaction, because the counter write does not wait (project_activity_stats_add).
CREATE OR REPLACE FUNCTION apply_chat_session_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  turn_count bigint;
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
    RETURN OLD;
  END IF;
  PERFORM 1 FROM public.chat_sessions cs WHERE cs.id = OLD.id FOR UPDATE;
  SELECT count(*) INTO turn_count FROM public.chat_turns t WHERE t.session_id = OLD.id;
  IF turn_count > 0 THEN
    IF EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
      PERFORM public.project_activity_stats_add(OLD.project_id, 0, 0, 0, 0, 0, -turn_count);
    END IF;
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id) THEN
      PERFORM public.project_activity_stats_add(NEW.project_id, 0, 0, 0, 0, 0, turn_count);
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
-- A deleted project's counter rows go with it (there is no foreign key to cascade; see the top of this file).
CREATE OR REPLACE FUNCTION delete_project_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    DELETE FROM public.project_activity_stats;
  ELSE
    DELETE FROM public.project_activity_stats s WHERE s.project_id = OLD.id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- Repair: replaces every counter row with one row per project holding the totals recomputed from history, and
-- returns the number of rows written. Exact under the locks it takes: SHARE ROW EXCLUSIVE on the three history
-- tables makes writers (and so every counter write) wait until the caller's transaction commits, while reads go on.
-- Call it in a short transaction of its own with a lock_timeout, as the role that owns or writes these tables:
--   BEGIN; SET LOCAL lock_timeout = '5s'; SELECT public.rebuild_project_activity_stats(); COMMIT;
-- The tables are locked in the order a transaction that removes chat and search history takes them (chat first),
-- so waiting for one cannot close a cycle with it. One pass over each table: about 1 s per million search sessions.
-- Sessions whose project does not exist (possible only after triggers were bypassed) get no row.
CREATE OR REPLACE FUNCTION rebuild_project_activity_stats() RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  written bigint;
BEGIN
  LOCK TABLE public.chat_sessions, public.chat_turns, public.search_sessions IN SHARE ROW EXCLUSIVE MODE;
  DELETE FROM public.project_activity_stats;
  INSERT INTO public.project_activity_stats
    (project_id, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms, chat_turns)
  SELECT w.id, coalesce(s.sessions, 0), coalesce(s.results, 0), coalesce(s.zero, 0), coalesce(s.durations, 0),
    coalesce(s.duration_ms, 0), coalesce(c.turns, 0)
  FROM public.projects w
  LEFT JOIN (
    SELECT d.project_id, count(*) AS sessions, sum(d.result_count::bigint)::bigint AS results,
      count(*) FILTER (WHERE d.result_count = 0) AS zero, count(d.duration_ms) AS durations,
      coalesce(sum(d.duration_ms), 0) AS duration_ms
    FROM (
      SELECT ss.project_id, ss.result_count, public.search_session_duration_ms(ss.metadata) AS duration_ms
      FROM public.search_sessions ss WHERE ss.project_id IS NOT NULL
    ) d
    GROUP BY d.project_id
  ) s ON s.project_id = w.id
  LEFT JOIN (
    SELECT cs.project_id, count(*) AS turns
    FROM public.chat_turns t JOIN public.chat_sessions cs ON cs.id = t.session_id
    GROUP BY cs.project_id
  ) c ON c.project_id = w.id
  WHERE s.project_id IS NOT NULL OR c.project_id IS NOT NULL;
  GET DIAGNOSTICS written = ROW_COUNT;
  RETURN written;
END $$;
--> statement-breakpoint
-- Folds each named project's counter rows into one, and returns the number of rows removed. A burst of concurrent
-- writers leaves a project one row per writer; reads sum them, so the maintenance sweep folds a few projects at a
-- time. Exact and non-blocking: one statement locks the rows no other transaction holds (SKIP LOCKED), deletes
-- all but the first and adds what they held to it. It creates no row, so a project delete running at the same
-- moment still removes everything, and a writer that finds these rows locked writes another one meanwhile.
CREATE OR REPLACE FUNCTION compact_project_activity_stats(p_project_ids text[]) RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  target text;
  removed bigint := 0;
  step bigint;
BEGIN
  FOR target IN SELECT DISTINCT u.id FROM unnest(p_project_ids) AS u(id) WHERE u.id IS NOT NULL ORDER BY u.id LOOP
    WITH free AS MATERIALIZED (
      SELECT c.slot FROM public.project_activity_stats c
      WHERE c.project_id = target ORDER BY c.slot FOR UPDATE SKIP LOCKED
    ), gone AS (
      DELETE FROM public.project_activity_stats d
      WHERE d.project_id = target AND d.slot IN (SELECT f.slot FROM free f) AND d.slot <> (SELECT min(f.slot) FROM free f)
      RETURNING d.search_sessions, d.search_result_count, d.zero_result_searches, d.search_duration_count,
        d.search_duration_ms, d.chat_turns
    ), folded AS (
      UPDATE public.project_activity_stats k SET
        search_sessions = k.search_sessions + t.search_sessions,
        search_result_count = k.search_result_count + t.search_result_count,
        zero_result_searches = k.zero_result_searches + t.zero_result_searches,
        search_duration_count = k.search_duration_count + t.search_duration_count,
        search_duration_ms = k.search_duration_ms + t.search_duration_ms,
        chat_turns = k.chat_turns + t.chat_turns
      FROM (
        SELECT count(*) AS n, coalesce(sum(g.search_sessions), 0)::bigint AS search_sessions,
          coalesce(sum(g.search_result_count), 0)::bigint AS search_result_count,
          coalesce(sum(g.zero_result_searches), 0)::bigint AS zero_result_searches,
          coalesce(sum(g.search_duration_count), 0)::bigint AS search_duration_count,
          coalesce(sum(g.search_duration_ms), 0) AS search_duration_ms,
          coalesce(sum(g.chat_turns), 0)::bigint AS chat_turns
        FROM gone g
      ) t
      WHERE t.n > 0 AND k.project_id = target AND k.slot = (SELECT min(f.slot) FROM free f)
      RETURNING t.n
    )
    SELECT coalesce(max(n), 0) INTO step FROM folded;
    removed := removed + step;
  END LOOP;
  RETURN removed;
END $$;
--> statement-breakpoint
-- Drift check: the projects whose stored counters differ from history, with both sets of numbers; no rows means
-- the counters are exact. Pass project ids to check only those (the maintenance sweep samples a few at a time);
-- with no argument it reads all history, and also reports counter rows left for a project that does not exist.
-- One statement, so one snapshot: a counter write commits with the session or turn it counts, which makes the
-- comparison exact while traffic flows. It takes no lock beyond a read's and blocks nothing. It reads as much
-- history as the aggregates this table replaced, so it belongs in maintenance, never on a request path.
CREATE OR REPLACE FUNCTION project_activity_stats_drift(p_project_ids text[] DEFAULT NULL)
RETURNS TABLE (project_id text, project_exists boolean, stored jsonb, actual jsonb)
LANGUAGE sql STABLE SET search_path=pg_catalog,pg_temp AS $$
  WITH stored AS (
    SELECT a.project_id, sum(a.search_sessions) AS search_sessions, sum(a.search_result_count) AS search_result_count,
      sum(a.zero_result_searches) AS zero_result_searches, sum(a.search_duration_count) AS search_duration_count,
      sum(a.search_duration_ms) AS search_duration_ms, sum(a.chat_turns) AS chat_turns
    FROM public.project_activity_stats a
    WHERE p_project_ids IS NULL OR a.project_id = ANY (p_project_ids)
    GROUP BY a.project_id
  ), searches AS (
    SELECT d.project_id, count(*) AS search_sessions, sum(d.result_count::bigint) AS search_result_count,
      count(*) FILTER (WHERE d.result_count = 0) AS zero_result_searches, count(d.duration_ms) AS search_duration_count,
      coalesce(sum(d.duration_ms), 0) AS search_duration_ms
    FROM (
      SELECT ss.project_id, ss.result_count, public.search_session_duration_ms(ss.metadata) AS duration_ms
      FROM public.search_sessions ss
      WHERE ss.project_id IS NOT NULL AND (p_project_ids IS NULL OR ss.project_id = ANY (p_project_ids))
    ) d
    GROUP BY d.project_id
  ), turns AS (
    SELECT cs.project_id, count(*) AS chat_turns
    FROM public.chat_turns t JOIN public.chat_sessions cs ON cs.id = t.session_id
    WHERE p_project_ids IS NULL OR cs.project_id = ANY (p_project_ids)
    GROUP BY cs.project_id
  ), compared AS (
    SELECT k.project_id, EXISTS (SELECT 1 FROM public.projects w WHERE w.id = k.project_id) AS project_exists,
      st.project_id IS NOT NULL AS has_rows,
      jsonb_build_object(
        'search_sessions', coalesce(st.search_sessions, 0), 'search_result_count', coalesce(st.search_result_count, 0),
        'zero_result_searches', coalesce(st.zero_result_searches, 0), 'search_duration_count', coalesce(st.search_duration_count, 0),
        'search_duration_ms', coalesce(st.search_duration_ms, 0), 'chat_turns', coalesce(st.chat_turns, 0)) AS stored,
      jsonb_build_object(
        'search_sessions', coalesce(se.search_sessions, 0), 'search_result_count', coalesce(se.search_result_count, 0),
        'zero_result_searches', coalesce(se.zero_result_searches, 0), 'search_duration_count', coalesce(se.search_duration_count, 0),
        'search_duration_ms', coalesce(se.search_duration_ms, 0), 'chat_turns', coalesce(tu.chat_turns, 0)) AS actual
    FROM (
      SELECT st.project_id FROM stored st UNION SELECT se.project_id FROM searches se UNION SELECT tu.project_id FROM turns tu
    ) k
    LEFT JOIN stored st ON st.project_id = k.project_id
    LEFT JOIN searches se ON se.project_id = k.project_id
    LEFT JOIN turns tu ON tu.project_id = k.project_id
  )
  SELECT c.project_id, c.project_exists, c.stored, c.actual
  FROM compared c
  WHERE (c.project_exists AND c.stored <> c.actual) OR (NOT c.project_exists AND c.has_rows)
  ORDER BY c.project_id
$$;
--> statement-breakpoint
-- Writers wait from here until the migration transaction commits, so the backfill below and the triggers see the
-- same rows: no session or turn is counted twice or missed. Reads of these tables are not blocked by this lock
-- (the top of this file lists every lock and what else can hold readers up). With lock_timeout this fails fast
-- behind a long-open writer instead of queueing every search behind it; a retried deploy finishes the work.
-- Same table order as rebuild_project_activity_stats().
LOCK TABLE "chat_sessions", "chat_turns", "search_sessions" IN SHARE ROW EXCLUSIVE MODE;
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
-- Fires after the foreign-key cascade triggers of the same row (triggers of one kind fire in name order, and
-- theirs are named RI_ConstraintTrigger_...), so the delete already holds every session and turn of the project.
CREATE OR REPLACE TRIGGER zz_projects_activity_stats_delete AFTER DELETE ON "projects"
FOR EACH ROW EXECUTE FUNCTION delete_project_activity_stats();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER zz_projects_activity_stats_truncate AFTER TRUNCATE ON "projects"
FOR EACH STATEMENT EXECUTE FUNCTION delete_project_activity_stats();
--> statement-breakpoint
-- Backfill: the repair function, so there is one implementation of "counters from history".
SELECT rebuild_project_activity_stats();
