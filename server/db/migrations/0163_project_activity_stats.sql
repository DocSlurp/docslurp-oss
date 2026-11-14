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
-- A project's counters are the sum of its rows, one row per (project, slot). A counter write never waits for
-- another writer:
--   - a writing transaction first takes a slot that no other transaction holds (a transaction-level advisory lock,
--     tried without waiting, lowest free slot first) and writes only rows of that slot. Until it ends, no other
--     writer touches those rows, so its counter writes find no row lock to wait for, in whatever order it and the
--     others touch projects. The amount is written in the writer's own transaction and commits or rolls back with
--     the session or turn it counts.
--   - the table has no foreign key to projects, so a write never waits for a project row either.
-- Two writers therefore cannot deadlock on counter rows, and a search or chat write is never queued behind
-- another one's commit. (The one wait a counter adds: a chat turn written while its session is being moved to
-- another project waits for that move, and the move for it; see apply_chat_turn_activity_stats().) A project has at most as many rows as there were writing transactions open at the same
-- moment across the database (bounded by the connection count); a read sums them, and
-- compact_project_activity_stats() (the maintenance sweep) and rebuild_project_activity_stats() fold them back
-- into one.
-- (Choosing a free row with FOR UPDATE SKIP LOCKED instead was measured and rejected: when the row's last writer
-- commits at that instant, Postgres follows the row's update chain and waits for whoever holds the newer version.)
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
-- destructive-migration: nothing is removed that was not already going. The matches are the AFTER DELETE and AFTER TRUNCATE trigger events below (they remove or zero counters when their project or history goes), the chat session delete trigger function (it removes the deleted session's turns itself, the rows the foreign-key cascade would remove a moment later, so that it can count them), the rebuild function, which replaces every counter row with the same totals recomputed, and the fold function, which merges a project's counter rows into one with the same totals.
-- idempotent-migration: the backfill calls rebuild_project_activity_stats(), which deletes every counter row and re-inserts the aggregates while writers are locked out, so a second run stores the same totals.
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
  CONSTRAINT "project_activity_stats_slot_check" CHECK ("slot" >= 0 AND "slot" < 1024)
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
-- The counter slot this transaction writes (see the top of this file): the one it already holds, else the lowest
-- slot no other transaction holds. pg_try_advisory_xact_lock never waits, the lock is released when the
-- transaction ends (or the savepoint that took it rolls back), and the transaction-local setting is only a hint
-- that saves the search on later calls: the lock is always taken again, which succeeds at once for its holder.
-- The two-key advisory locks (163001, slot) are used by nothing else; (163002, ...) are the chat session locks below. If all 1,024 slots are ever held at once
-- (more writing transactions than that open together), the caller waits for one instead of failing.
CREATE OR REPLACE FUNCTION project_activity_stats_slot() RETURNS smallint
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  hint text := current_setting('docslurp.project_activity_stats_slot', true);
  k integer;
BEGIN
  IF hint ~ '^[0-9]{1,4}$' AND hint::integer < 1024 AND pg_try_advisory_xact_lock(163001, hint::integer) THEN
    RETURN hint::smallint;
  END IF;
  FOR k IN 0..1023 LOOP
    IF pg_try_advisory_xact_lock(163001, k) THEN
      PERFORM set_config('docslurp.project_activity_stats_slot', k::text, true);
      RETURN k::smallint;
    END IF;
  END LOOP;
  k := pg_backend_pid() % 1024;
  PERFORM pg_advisory_xact_lock(163001, k);
  PERFORM set_config('docslurp.project_activity_stats_slot', k::text, true);
  RETURN k::smallint;
END $$;
--> statement-breakpoint
-- One function for the three search_sessions triggers. PL/pgSQL plans a statement when it first runs, so each
-- trigger only ever plans the branch whose transition tables it has. An upsert fires both the insert and the update
-- trigger; the one whose transition tables are empty aggregates nothing, takes no slot and writes nothing.
-- The slot is taken in the select list, so only a statement that has something to write takes one, and before
-- any counter row is touched. A project that no longer exists (its delete cascades here) is skipped: its counters
-- go with it.
CREATE OR REPLACE FUNCTION apply_search_session_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The session's own foreign key has already checked that the project exists.
    INSERT INTO public.project_activity_stats AS s
      (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
    SELECT g.project_id, public.project_activity_stats_slot(), g.sessions, g.results, g.zero, g.durations, g.duration_ms
    FROM (
      SELECT d.project_id, count(*) AS sessions, sum(d.result_count::bigint) AS results,
        count(*) FILTER (WHERE d.result_count = 0) AS zero, count(d.duration_ms) AS durations,
        coalesce(sum(d.duration_ms), 0) AS duration_ms
      FROM (
        SELECT n.project_id, n.result_count, public.search_session_duration_ms(n.metadata) AS duration_ms
        FROM new_rows n WHERE n.project_id IS NOT NULL
      ) d
      GROUP BY d.project_id
    ) g
    ON CONFLICT (project_id, slot) DO UPDATE SET
      search_sessions = s.search_sessions + EXCLUDED.search_sessions,
      search_result_count = s.search_result_count + EXCLUDED.search_result_count,
      zero_result_searches = s.zero_result_searches + EXCLUDED.zero_result_searches,
      search_duration_count = s.search_duration_count + EXCLUDED.search_duration_count,
      search_duration_ms = s.search_duration_ms + EXCLUDED.search_duration_ms;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.project_activity_stats AS s
      (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
    SELECT g.project_id, public.project_activity_stats_slot(), -g.sessions, -g.results, -g.zero, -g.durations, -g.duration_ms
    FROM (
      SELECT d.project_id, count(*) AS sessions, sum(d.result_count::bigint) AS results,
        count(*) FILTER (WHERE d.result_count = 0) AS zero, count(d.duration_ms) AS durations,
        coalesce(sum(d.duration_ms), 0) AS duration_ms
      FROM (
        SELECT o.project_id, o.result_count, public.search_session_duration_ms(o.metadata) AS duration_ms
        FROM old_rows o WHERE o.project_id IS NOT NULL
      ) d
      WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
      GROUP BY d.project_id
    ) g
    ON CONFLICT (project_id, slot) DO UPDATE SET
      search_sessions = s.search_sessions + EXCLUDED.search_sessions,
      search_result_count = s.search_result_count + EXCLUDED.search_result_count,
      zero_result_searches = s.zero_result_searches + EXCLUDED.zero_result_searches,
      search_duration_count = s.search_duration_count + EXCLUDED.search_duration_count,
      search_duration_ms = s.search_duration_ms + EXCLUDED.search_duration_ms;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Every search insert is an upsert, which fires this trigger with nothing updated: leave before the aggregate
    -- (measured: 0.006 ms instead of 0.04 ms per search).
    PERFORM 1 FROM new_rows LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    -- New values minus old values per project; a project whose totals did not change gets no write, no row lock
    -- and no slot. This covers a changed result_count or metadata, a project_id set by the 0152 sweep, and a
    -- session moved between projects.
    INSERT INTO public.project_activity_stats AS s
      (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms)
    SELECT g.project_id, public.project_activity_stats_slot(), g.sessions, g.results, g.zero, g.durations, g.duration_ms
    FROM (
      SELECT d.project_id, sum(d.sign) AS sessions, sum(d.sign * d.result_count::bigint) AS results,
        coalesce(sum(d.sign) FILTER (WHERE d.result_count = 0), 0) AS zero,
        coalesce(sum(d.sign) FILTER (WHERE d.duration_ms IS NOT NULL), 0) AS durations,
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
    ) g
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
-- Chat turns carry no project: it is their session's, read when the turn is written. Two things can change that
-- under a turn write: the session moves to another project, or the session is deleted.
--
-- A move and the turn writes of that session exclude each other with a transaction-level advisory lock on the
-- session (163002, hash of its id): turn writes take it shared before they read the session's project, a move
-- takes it exclusively before it counts the session's turns. So a move waits for the turn writes in flight and
-- counts their result, and later ones wait for the move and read the new project.
-- Row locks cannot do this. A turn insert's foreign-key check takes FOR KEY SHARE on the session, and Postgres
-- can grant that beside a concurrent FOR UPDATE on the same row (heap_lock_tuple re-checks only for updates after
-- it re-reads the row), which a move's own update never waits out: measured as one miscounted turn in most runs
-- of 6 sessions moved while 10 connections insert turns.
--
-- One statement that writes turns in more than 256 sessions (an import, a retention delete) takes the single
-- lock (163003, 0) shared instead of one lock per session, which would fill the shared lock table and fail other
-- transactions with it; a move takes that lock exclusively as well, so it still waits for such a statement.
--
-- These guarantees assume READ COMMITTED, where each trigger statement reads a fresh snapshot. Nothing writes
-- these tables at another isolation level; a REPEATABLE READ writer could miscount a turn across a session move.
--
-- A delete needs no lock: apply_chat_session_activity_stats() below subtracts exactly the turns it removes.
-- A turn whose session is not visible here is being removed by that function, which counts it.
CREATE OR REPLACE FUNCTION apply_chat_turn_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF (SELECT count(DISTINCT t.session_id) FROM new_rows t) > 256 THEN
      PERFORM pg_advisory_xact_lock_shared(163003, 0);
    ELSE
      PERFORM pg_advisory_xact_lock_shared(163002, hashtext(k.id))
      FROM (SELECT DISTINCT t.session_id AS id FROM new_rows t ORDER BY 1) k;
    END IF;
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT g.project_id, public.project_activity_stats_slot(), g.turns
    FROM (
      SELECT cs.project_id, count(*) AS turns
      FROM new_rows t JOIN public.chat_sessions cs ON cs.id = t.session_id
      GROUP BY cs.project_id
    ) g
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  ELSIF TG_OP = 'DELETE' THEN
    -- Only sessions that still exist: a cascade from a deleted session, user or project takes no lock here,
    -- however many sessions it removes.
    IF (SELECT count(*) FROM public.chat_sessions cs WHERE cs.id IN (SELECT t.session_id FROM old_rows t)) > 256 THEN
      PERFORM pg_advisory_xact_lock_shared(163003, 0);
    ELSE
      PERFORM pg_advisory_xact_lock_shared(163002, hashtext(k.id))
      FROM (SELECT cs.id FROM public.chat_sessions cs WHERE cs.id IN (SELECT t.session_id FROM old_rows t) ORDER BY 1) k;
    END IF;
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT g.project_id, public.project_activity_stats_slot(), -g.turns
    FROM (
      SELECT cs.project_id, count(*) AS turns
      FROM old_rows t JOIN public.chat_sessions cs ON cs.id = t.session_id
      WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = cs.project_id)
      GROUP BY cs.project_id
    ) g
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  ELSIF TG_OP = 'UPDATE' THEN
    -- A turn moved to another session (no code does this): one row, so a row-level trigger.
    PERFORM pg_advisory_xact_lock_shared(163002, hashtext(k.id))
    FROM (SELECT DISTINCT u.id FROM unnest(ARRAY[OLD.session_id, NEW.session_id]) AS u(id) ORDER BY 1) k;
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT g.project_id, public.project_activity_stats_slot(), g.turns
    FROM (
      SELECT d.project_id, sum(d.sign) AS turns
      FROM (
        SELECT cs.project_id, 1 AS sign FROM public.chat_sessions cs WHERE cs.id = NEW.session_id
        UNION ALL
        SELECT cs.project_id, -1 AS sign FROM public.chat_sessions cs WHERE cs.id = OLD.session_id
      ) d
      WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
      GROUP BY d.project_id
      HAVING sum(d.sign) <> 0
    ) g
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  ELSIF TG_OP = 'TRUNCATE' THEN
    UPDATE public.project_activity_stats SET chat_turns = 0 WHERE chat_turns <> 0;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
-- A chat session leaving its project takes its turns' count with it.
--
-- Moved to another project (BEFORE the update; no code does this): under the session's advisory lock, taken
-- exclusively, so the count below is final (see apply_chat_turn_activity_stats() above).
--
-- Deleted (AFTER the row is gone, and before the foreign-key cascade to chat_turns: the trigger's name sorts
-- before RI_ConstraintTrigger_...): this function removes the session's turns itself and subtracts the number it
-- removed. By then the delete has waited for every turn insert that held the session, and none can start, so the
-- rows removed here are all of them and each was counted once when it was written. Counting them before the
-- delete instead (as a BEFORE trigger must) misses a turn committed in between. The cascade then finds nothing.
-- When the project itself is gone (its delete cascades here) nothing is written: its counters go with it.
--
-- Neither path can deadlock with another one on a counter row: each transaction writes only the rows of its slot.
CREATE OR REPLACE FUNCTION apply_chat_session_activity_stats() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  turn_count bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.projects p WHERE p.id = OLD.project_id) THEN
      RETURN NULL;
    END IF;
    WITH gone AS (DELETE FROM public.chat_turns t WHERE t.session_id = OLD.id RETURNING 1)
    SELECT count(*) INTO turn_count FROM gone;
    IF turn_count > 0 THEN
      INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
      VALUES (OLD.project_id, public.project_activity_stats_slot(), -turn_count)
      ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
    END IF;
    RETURN NULL;
  END IF;
  -- The bulk lock first (see apply_chat_turn_activity_stats), then this session's.
  PERFORM pg_advisory_xact_lock(163003, 0);
  PERFORM pg_advisory_xact_lock(163002, hashtext(OLD.id));
  SELECT count(*) INTO turn_count FROM public.chat_turns t WHERE t.session_id = OLD.id;
  IF turn_count > 0 THEN
    INSERT INTO public.project_activity_stats AS s (project_id, slot, chat_turns)
    SELECT d.project_id, public.project_activity_stats_slot(), d.turns
    FROM (VALUES (OLD.project_id, -turn_count), (NEW.project_id, turn_count)) AS d(project_id, turns)
    WHERE d.project_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = d.project_id)
    ON CONFLICT (project_id, slot) DO UPDATE SET chat_turns = s.chat_turns + EXCLUDED.chat_turns;
  END IF;
  RETURN NEW;
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
-- Repair: replaces every counter row with one row per project (slot 0) holding the totals recomputed from history, and
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
    (project_id, slot, search_sessions, search_result_count, zero_result_searches, search_duration_count, search_duration_ms, chat_turns)
  SELECT w.id, 0, coalesce(s.sessions, 0), coalesce(s.results, 0), coalesce(s.zero, 0), coalesce(s.durations, 0),
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
-- writers leaves a project one row per slot they used; reads sum them, so the maintenance sweep folds a few
-- projects at a time. Exact and non-blocking: it folds only rows whose slot it could take without waiting (so no
-- writer is using them) and that no other transaction has locked (SKIP LOCKED: a project delete or a rebuild in
-- progress keeps its rows). One statement per project deletes all of those but the first and adds what they held
-- to it. It creates no row, so a project delete running at the same moment still removes everything. The slots
-- stay taken until the caller's transaction ends: call it on its own, not inside a long transaction.
CREATE OR REPLACE FUNCTION compact_project_activity_stats(p_project_ids text[]) RETURNS bigint
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE
  target text;
  removed bigint := 0;
  step bigint;
BEGIN
  FOR target IN SELECT DISTINCT u.id FROM unnest(p_project_ids) AS u(id) WHERE u.id IS NOT NULL ORDER BY u.id LOOP
    WITH mine AS MATERIALIZED (
      SELECT c.slot FROM public.project_activity_stats c
      WHERE c.project_id = target AND pg_try_advisory_xact_lock(163001, c.slot::integer)
    ), free AS MATERIALIZED (
      SELECT c.slot FROM public.project_activity_stats c
      WHERE c.project_id = target AND c.slot IN (SELECT m.slot FROM mine m) ORDER BY c.slot FOR UPDATE SKIP LOCKED
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
-- projects first: the trigger created on it below needs the same lock, and a project delete takes projects before
-- its cascade reaches these tables, so the other order could deadlock with one. Then the order of
-- rebuild_project_activity_stats().
LOCK TABLE "projects", "chat_sessions", "chat_turns", "search_sessions" IN SHARE ROW EXCLUSIVE MODE;
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
-- The name is quoted to keep its capital: triggers of one kind fire in name order, and this one must run before
-- the cascade to chat_turns (RI_ConstraintTrigger_...).
CREATE OR REPLACE TRIGGER "A_chat_sessions_activity_stats_delete" AFTER DELETE ON "chat_sessions"
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
