-- Worker slots as pre-materialized tokens (docs/scaling-1000-workers.md).
--
-- 0025 serialized every claim for an org on one transaction advisory lock
-- (count live leases, then insert). At 576 slots in one org that lock had 278
-- waiters and claims took 51 ms on average (2026-10-09 load-test re-run).
--
-- Now an org with cap N owns token rows slot_no 0..N-1. A claim takes one
-- free token (lease_id NULL or expired) with FOR UPDATE SKIP LOCKED, starting
-- at a random slot so concurrent claimers spread over the table, and stamps
-- it. Claimers never wait on each other, and at most N tokens are claimable,
-- so the org can never hold more than N live slots.
--
-- Resizing: a claim that sees fewer tokens than its cap adds the missing ones.
-- When the cap shrinks, tokens at or above it are no longer claimable, and
-- free ones above the highest held one are deleted. Until the last of those
-- is released, the org's claims fall back to 0025's behaviour (advisory lock,
-- count every live lease, claim only below the cap), so live slots stay <= cap
-- while the excess drains. Normal claims only run once no token at or above
-- the cap exists, when every live lease sits on one of the cap's tokens.
--
-- Leases expire unless renewed; an expired token is free to the next claim.
-- Renewal no longer revives an expired lease. The fleet-wide cap stays a soft
-- check (see worker/src/db/worker-slot-store.ts). There is no run_id foreign
-- key: a deleted run's lease frees itself at expiry.
CREATE TABLE IF NOT EXISTS worker_slot_tokens (
  org_key text NOT NULL,
  slot_no integer NOT NULL,
  lease_id text,
  run_id text,
  kind text,
  worker_id text,
  acquired_at timestamptz,
  expires_at timestamptz,
  CONSTRAINT worker_slot_tokens_pkey PRIMARY KEY (org_key, slot_no),
  CONSTRAINT worker_slot_tokens_slot_no_check CHECK (slot_no >= 0),
  CONSTRAINT worker_slot_tokens_kind_check CHECK (kind IS NULL OR kind IN ('page', 'stage')),
  CONSTRAINT worker_slot_tokens_lease_check CHECK ((lease_id IS NULL) = (expires_at IS NULL))
) WITH (fillfactor = 70);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS worker_slot_tokens_lease_idx ON worker_slot_tokens (lease_id) WHERE lease_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS worker_slot_tokens_live_idx ON worker_slot_tokens (expires_at) WHERE lease_id IS NOT NULL;
--> statement-breakpoint
DROP TABLE IF EXISTS worker_slot_leases;
--> statement-breakpoint
-- Held tokens under the old name, for dashboards and ops queries
-- (`... from worker_slot_leases where expires_at > now()`).
CREATE OR REPLACE VIEW worker_slot_leases AS
  SELECT lease_id, org_key, slot_no, run_id, kind, worker_id, acquired_at, expires_at
  FROM worker_slot_tokens
  WHERE lease_id IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION acquire_worker_slot(
  p_run_id text, p_kind text, p_worker_id text, p_lease_id text,
  p_ttl_ms integer, p_global_cap integer, p_default_slots integer
) RETURNS TABLE (acquired boolean, org_key text, inflight integer, cap integer, reason text)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_org text;
  v_slots integer;
  v_cap integer;
  v_top integer;
  v_start integer;
  v_slot integer;
  v_inflight integer;
  v_tokens integer;
  v_attempt integer;
  v_fleet integer;
BEGIN
  SELECT coalesce(r.org_id, 'workspace:' || r.workspace_id), o.worker_slots
    INTO v_org, v_slots
    FROM workspace_runs r LEFT JOIN organizations o ON o.id = r.org_id
    WHERE r.id = p_run_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'worker slot: run % not found', p_run_id;
  END IF;
  v_cap := greatest(1, coalesce(v_slots, p_default_slots));
  IF p_global_cap > 0 THEN
    v_cap := least(v_cap, p_global_cap);
  END IF;

  SELECT t.slot_no INTO v_top FROM worker_slot_tokens t
    WHERE t.org_key = v_org ORDER BY t.slot_no DESC LIMIT 1;
  IF v_top IS NULL OR v_top < v_cap - 1 THEN
    -- First claim for the org, or the cap grew.
    INSERT INTO worker_slot_tokens (org_key, slot_no)
      SELECT v_org, g FROM generate_series(0, v_cap - 1) g
      ON CONFLICT DO NOTHING;
  ELSIF v_top >= v_cap THEN
    -- The cap shrank while tokens above it may still be held. Rare, so these
    -- claims serialize on the org's advisory lock (as in 0025) and claim only
    -- while all live leases, including those above the cap, number < cap.
    PERFORM pg_advisory_xact_lock(hashtextextended('worker-slots:' || v_org, 0));
    DELETE FROM worker_slot_tokens d
      WHERE d.org_key = v_org AND d.slot_no IN (
        SELECT t.slot_no FROM worker_slot_tokens t
        WHERE t.org_key = v_org AND t.slot_no >= v_cap
          AND t.slot_no > coalesce((
            SELECT max(h.slot_no) FROM worker_slot_tokens h
            WHERE h.org_key = v_org AND h.slot_no >= v_cap AND h.lease_id IS NOT NULL AND h.expires_at >= now()
          ), -1)
        FOR UPDATE SKIP LOCKED);
    SELECT count(*)::int INTO v_inflight FROM worker_slot_tokens t
      WHERE t.org_key = v_org AND t.lease_id IS NOT NULL AND t.expires_at >= now();
    IF v_inflight >= v_cap THEN
      RETURN QUERY SELECT false, v_org, v_inflight, v_cap, 'org-cap'::text;
      RETURN;
    END IF;
  END IF;

  FOR v_attempt IN 1..2 LOOP
    -- Start at a random slot so concurrent claimers spread over the tokens.
    v_start := floor(random() * v_cap)::int;
    SELECT t.slot_no INTO v_slot FROM worker_slot_tokens t
      WHERE t.org_key = v_org AND t.slot_no >= v_start AND t.slot_no < v_cap
        AND (t.lease_id IS NULL OR t.expires_at < now())
      ORDER BY t.slot_no LIMIT 1
      FOR UPDATE SKIP LOCKED;
    IF v_slot IS NULL AND v_start > 0 THEN
      SELECT t.slot_no INTO v_slot FROM worker_slot_tokens t
        WHERE t.org_key = v_org AND t.slot_no < v_start
          AND (t.lease_id IS NULL OR t.expires_at < now())
        ORDER BY t.slot_no LIMIT 1
        FOR UPDATE SKIP LOCKED;
    END IF;
    EXIT WHEN v_slot IS NOT NULL;

    SELECT count(*) FILTER (WHERE t.lease_id IS NOT NULL AND t.expires_at >= now())::int,
           count(*) FILTER (WHERE t.slot_no < v_cap)::int
      INTO v_inflight, v_tokens
      FROM worker_slot_tokens t WHERE t.org_key = v_org;
    -- A missing token below the cap (a held row deleted by hand through the
    -- worker_slot_leases view) is re-created once, then the claim retries.
    EXIT WHEN v_tokens >= v_cap OR v_attempt = 2;
    INSERT INTO worker_slot_tokens (org_key, slot_no)
      SELECT v_org, g FROM generate_series(0, v_cap - 1) g
      ON CONFLICT DO NOTHING;
  END LOOP;

  IF v_slot IS NULL THEN
    RETURN QUERY SELECT false, v_org, v_inflight, v_cap, 'org-cap'::text;
    RETURN;
  END IF;

  IF p_global_cap > 0 THEN
    SELECT count(*)::int INTO v_fleet FROM worker_slot_tokens t
      WHERE t.lease_id IS NOT NULL AND t.expires_at >= now();
    IF v_fleet >= p_global_cap THEN
      SELECT count(*)::int INTO v_inflight FROM worker_slot_tokens t
        WHERE t.org_key = v_org AND t.lease_id IS NOT NULL AND t.expires_at >= now();
      RETURN QUERY SELECT false, v_org, v_inflight, v_cap, 'global-cap'::text;
      RETURN;
    END IF;
  END IF;

  UPDATE worker_slot_tokens t
    SET lease_id = p_lease_id, run_id = p_run_id, kind = p_kind, worker_id = p_worker_id,
      acquired_at = now(), expires_at = now() + p_ttl_ms * interval '1 millisecond'
    WHERE t.org_key = v_org AND t.slot_no = v_slot;
  -- inflight is not counted on success (it would scan the org's tokens on every claim).
  RETURN QUERY SELECT true, v_org, NULL::integer, v_cap, NULL::text;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION renew_worker_slot(p_lease_id text, p_ttl_ms integer) RETURNS boolean
LANGUAGE sql AS $$
  WITH renewed AS (
    UPDATE worker_slot_tokens t
    SET expires_at = now() + p_ttl_ms * interval '1 millisecond'
    WHERE t.lease_id = p_lease_id AND t.expires_at >= now()
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM renewed)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION release_worker_slot(p_lease_id text) RETURNS void
LANGUAGE sql AS $$
  UPDATE worker_slot_tokens t
  SET lease_id = NULL, run_id = NULL, kind = NULL, worker_id = NULL, acquired_at = NULL, expires_at = NULL
  WHERE t.lease_id = p_lease_id
$$;
