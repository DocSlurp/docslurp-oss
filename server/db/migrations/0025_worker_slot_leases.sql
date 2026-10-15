-- Per-org worker slot semaphore (docs/scaling-1000-workers.md).
-- One row per in-flight page task or document-stage activity. A slot counts
-- only while expires_at is in the future, so a crashed or partitioned worker
-- releases its slots once its heartbeats stop renewing them.
-- org_key is the run's org_id, or 'workspace:<id>' for runs without an org.
CREATE TABLE IF NOT EXISTS "worker_slot_leases" (
  "lease_id" text PRIMARY KEY NOT NULL,
  "org_key" text NOT NULL,
  "run_id" text REFERENCES "workspace_runs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "worker_id" text,
  "acquired_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL,
  CONSTRAINT "worker_slot_leases_kind_check" CHECK ("kind" IN ('page', 'stage'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_slot_leases_org_expires_idx"
  ON "worker_slot_leases" ("org_key", "expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_slot_leases_expires_idx"
  ON "worker_slot_leases" ("expires_at");
--> statement-breakpoint
-- Single-holder leases for fleet-wide maintenance (sweeps, graph-job polling),
-- so 125 workers do not all run the same hourly sweeps. Row leases rather than
-- advisory locks: session locks do not survive a transaction-mode pooler.
CREATE TABLE IF NOT EXISTS "worker_maintenance_leases" (
  "name" text PRIMARY KEY NOT NULL,
  "holder" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The full task (vision config, page count) so child workflows can load a
-- bounded batch by offset instead of carrying every task through history.
ALTER TABLE "page_work_tasks" ADD COLUMN IF NOT EXISTS "payload" jsonb;
--> statement-breakpoint
-- The autoscaler counts queued/processing page tasks across all runs.
CREATE INDEX IF NOT EXISTS "page_work_tasks_status_run_idx"
  ON "page_work_tasks" ("status", "run_id");
--> statement-breakpoint
-- One round trip per claim: the per-org advisory lock is held only for the
-- microseconds this function runs server-side, not across client round trips
-- (Fly -> Neon RTT would otherwise cap one org at ~15 claims/s).
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
  v_inflight integer;
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

  PERFORM pg_advisory_xact_lock(hashtextextended('worker-slots:' || v_org, 0));
  DELETE FROM worker_slot_leases l WHERE l.org_key = v_org AND l.expires_at < now();
  SELECT count(*)::int INTO v_inflight FROM worker_slot_leases l WHERE l.org_key = v_org AND l.expires_at >= now();
  IF v_inflight >= v_cap THEN
    RETURN QUERY SELECT false, v_org, v_inflight, v_cap, 'org-cap'::text;
    RETURN;
  END IF;
  IF p_global_cap > 0 THEN
    SELECT count(*)::int INTO v_fleet FROM worker_slot_leases l WHERE l.expires_at >= now();
    IF v_fleet >= p_global_cap THEN
      RETURN QUERY SELECT false, v_org, v_inflight, v_cap, 'global-cap'::text;
      RETURN;
    END IF;
  END IF;

  INSERT INTO worker_slot_leases (lease_id, org_key, run_id, kind, worker_id, expires_at)
    VALUES (p_lease_id, v_org, p_run_id, p_kind, p_worker_id, now() + p_ttl_ms * interval '1 millisecond');
  RETURN QUERY SELECT true, v_org, v_inflight + 1, v_cap, NULL::text;
END
$$;
