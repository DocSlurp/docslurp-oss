-- Org-level credit leases (WORKER_CREDIT_LEASES; docs/pricing-and-credits.md,
-- "Credit leases").
--
-- Before: every run re-read org_spend_status() every WORKER_SPEND_CHECK_PAGES
-- pages / WORKER_SPEND_CHECK_CREDITS credits and at stage boundaries. The
-- overdraft bound was per run, so N concurrent runs in one org could overshoot
-- N x interval, and rich orgs paid for checks that could never block.
--
-- Now a run holds one lease: credits reserved from the org's available
-- balance. Grants are serialized per org on the run-admission advisory lock
-- (spend_admission_lock_key) and never let the leases outstanding in an org
-- exceed its available credits. The worker consumes the lease in the same
-- checkpoint transaction that enqueues the run's credit debit, so available
-- and outstanding fall together and the invariant holds while runs spend.
-- A lease is renewed (topped up) when ~80% is used and sized adaptively from
-- the run's burn rate; when nothing more can be granted the run is paused
-- exactly as the cadence check pauses it.
--
--   outstanding  greatest(granted - consumed, 0) of an active, unexpired lease
--   lease_size   remaining right after the last grant (renewal threshold)
--   consumed_at_grant / granted_at  burn-rate window for the next grant
--   credit_exempt  billing-exempt house orgs: metered, never credit-gated;
--               their leases skip the org lock and never count as outstanding
-- Expiry is computed (expires_at > now()), so a crashed worker's lease returns
-- to the pool after its TTL without any sweep; the app's sweep only marks
-- such rows expired and notifies. A run leaving queued/processing, or being
-- paused or cancelled, releases its lease (trigger below).
CREATE TABLE IF NOT EXISTS credit_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  workspace_id text,
  holder_kind text DEFAULT 'run' NOT NULL,
  holder_id text NOT NULL,
  granted numeric(24,12) DEFAULT 0 NOT NULL,
  consumed numeric(24,12) DEFAULT 0 NOT NULL,
  lease_size numeric(24,12) DEFAULT 0 NOT NULL,
  consumed_at_grant numeric(24,12) DEFAULT 0 NOT NULL,
  granted_at timestamptz DEFAULT now() NOT NULL,
  credit_exempt boolean DEFAULT false NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  grants integer DEFAULT 0 NOT NULL,
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT credit_leases_holder_kind_check CHECK (holder_kind IN ('run')),
  CONSTRAINT credit_leases_status_check CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  CONSTRAINT credit_leases_amounts_check CHECK (granted >= 0 AND consumed >= 0 AND lease_size >= 0),
  CONSTRAINT credit_leases_holder_unique UNIQUE (holder_kind, holder_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_leases_org_active_idx
  ON credit_leases (org_id) INCLUDE (granted, consumed, expires_at, credit_exempt)
  WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_leases_active_expiry_idx
  ON credit_leases (expires_at)
  WHERE status = 'active';
--> statement-breakpoint
-- Credits held by the org's live leases, optionally excluding one holder.
CREATE OR REPLACE FUNCTION org_outstanding_credit_leases(
  p_org_id text,
  p_exclude_kind text DEFAULT NULL,
  p_exclude_holder text DEFAULT NULL
) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(greatest(l.granted - l.consumed, 0)), 0)
  FROM credit_leases l
  WHERE l.org_id = p_org_id
    AND l.status = 'active'
    AND l.expires_at > now()
    AND NOT l.credit_exempt
    AND NOT (p_exclude_holder IS NOT NULL AND l.holder_kind = p_exclude_kind AND l.holder_id = p_exclude_holder)
$$;
--> statement-breakpoint
-- org_spend_status (0044) with live leases folded into `reserved`, so app
-- admission (assertCanSpend / admitRunSpend: spendable = available -
-- reserved), the spend-paused sweep and worker leases agree on what is free.
-- Without leases (flag off) the sum is 0 and the function is unchanged.
CREATE OR REPLACE FUNCTION org_spend_status(
  p_org_id text,
  p_workspace_id text DEFAULT NULL,
  p_run_reserve numeric DEFAULT 0
)
RETURNS TABLE (
  org_id text,
  plan_id text,
  available numeric,
  reserved numeric,
  workspace_budget_paused boolean,
  org_budget_paused boolean,
  workspace_in_org boolean
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.id,
    o.plan_id,
    a.available,
    CASE WHEN p_run_reserve > 0 THEN coalesce((
      SELECT sum(greatest(0, p_run_reserve - (r.input_cost_cents + r.output_cost_cents)))
      FROM workspace_runs r
      WHERE r.org_id = o.id
        AND r.status IN ('queued', 'processing')
        AND coalesce(r.control_state, '') NOT IN ('paused', 'cancelled', 'cancel_requested', 'dead-letter')
    ), 0) ELSE 0 END + org_outstanding_credit_leases(o.id),
    coalesce(w.budget_paused, false),
    o.budget_paused,
    p_workspace_id IS NULL OR w.id IS NOT NULL
  FROM organizations o
  CROSS JOIN LATERAL org_available_credits(o.id) a
  LEFT JOIN workspaces w ON w.id = p_workspace_id AND w.org_id = o.id
  WHERE o.id = coalesce(p_org_id, (SELECT ws.org_id FROM workspaces ws WHERE ws.id = p_workspace_id))
$$;
--> statement-breakpoint
-- Grant or renew a run's lease: top its remaining up to an adaptive target.
--   target = clamp(min(p_fraction * free, burn * p_horizon_seconds), p_min, p_max)
--   free   = available - other live leases (what this holder may hold)
--   burn   = credits consumed since the last grant / seconds since it
--            (p_initial when the lease has no history yet)
-- and never more than `free`, so the org's live leases never exceed its
-- available credits. Near exhaustion free shrinks, so leases shrink toward
-- p_min (one batch) and then to whatever is left: renewals, and therefore
-- balance checks, become frequent exactly when they matter.
-- Blocked (budget caps, entitlement): the lease is revoked and 0 returned.
-- Exhausted: lease_remaining <= 0 with block_reason 'credit_exhausted'.
-- Billing-exempt orgs (p_credit_exempt, decided by the caller from
-- BILLING_EXEMPT_ORG_IDS) skip the org lock and get p_max, but budget caps
-- still apply, as in spendBlockCode.
-- Lock order: own lease row, then (in the same statement snapshot) available
-- and other leases; the run row is only read. Checkpoints lock run -> lease;
-- admission takes the advisory lock first; nothing takes them in reverse.
CREATE OR REPLACE FUNCTION grant_credit_lease(
  p_org_id text,
  p_workspace_id text,
  p_holder_kind text,
  p_holder_id text,
  p_min numeric,
  p_max numeric,
  p_initial numeric,
  p_fraction numeric,
  p_horizon_seconds numeric,
  p_ttl_seconds integer,
  p_credit_exempt boolean DEFAULT false
) RETURNS TABLE (
  lease_id uuid,
  lease_remaining numeric,
  lease_credits numeric,
  added_credits numeric,
  available_credits numeric,
  outstanding_credits numeric,
  block_reason text
)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_min numeric := greatest(coalesce(p_min, 0), 0);
  v_max numeric;
  v_initial numeric;
  v_fraction numeric := least(greatest(coalesce(p_fraction, 0.25), 0.01), 1);
  v_horizon numeric := least(greatest(coalesce(p_horizon_seconds, 30), 1), 3600);
  v_ttl interval := make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 300), 5), 86400));
  v_run_org text;
  v_run_workspace text;
  v_run_active boolean;
  v_lease credit_leases%ROWTYPE;
  v_found boolean;
  v_live boolean := false;
  v_own numeric := 0;
  v_burn numeric;
  v_available numeric;
  v_others numeric := 0;
  v_free numeric;
  v_target numeric;
  v_add numeric := 0;
  v_ws_paused boolean;
  v_org_paused boolean;
  v_in_org boolean;
  v_status_found boolean;
  v_reason text;
  v_id uuid;
  v_granted numeric;
  v_consumed numeric;
BEGIN
  IF p_holder_kind IS DISTINCT FROM 'run' THEN
    RAISE EXCEPTION 'grant_credit_lease: unsupported holder kind %', p_holder_kind;
  END IF;
  IF p_org_id IS NULL OR p_holder_id IS NULL THEN
    RAISE EXCEPTION 'grant_credit_lease: org and holder are required';
  END IF;
  v_max := greatest(coalesce(p_max, v_min), v_min);
  v_initial := least(greatest(coalesce(p_initial, v_min), v_min), v_max);

  -- Tenant scope: the holder run must belong to this org (and workspace).
  SELECT r.org_id, r.workspace_id,
    r.status IN ('queued', 'processing')
      AND coalesce(r.control_state, '') NOT IN ('paused', 'pause_requested', 'cancelled', 'cancel_requested', 'dead-letter')
  INTO v_run_org, v_run_workspace, v_run_active
  FROM workspace_runs r WHERE r.id = p_holder_id;
  IF NOT FOUND OR v_run_org IS DISTINCT FROM p_org_id
     OR (p_workspace_id IS NOT NULL AND v_run_workspace IS DISTINCT FROM p_workspace_id) THEN
    RAISE EXCEPTION 'grant_credit_lease: run % is not in org %', p_holder_id, p_org_id;
  END IF;

  IF NOT p_credit_exempt THEN
    PERFORM pg_advisory_xact_lock(spend_admission_lock_key(p_org_id));
  END IF;

  SELECT * INTO v_lease FROM credit_leases l
  WHERE l.holder_kind = p_holder_kind AND l.holder_id = p_holder_id
  FOR UPDATE;
  v_found := FOUND;
  IF v_found AND v_lease.org_id IS DISTINCT FROM p_org_id THEN
    RAISE EXCEPTION 'grant_credit_lease: lease for % belongs to another org', p_holder_id;
  END IF;

  -- One snapshot for balance, flags and other leases: a checkpoint that
  -- commits in between moves available and outstanding together.
  SELECT true, s.available, s.workspace_budget_paused, s.org_budget_paused, s.workspace_in_org,
    CASE WHEN p_credit_exempt THEN 0 ELSE org_outstanding_credit_leases(p_org_id, p_holder_kind, p_holder_id) END
  INTO v_status_found, v_available, v_ws_paused, v_org_paused, v_in_org, v_others
  FROM org_spend_status(p_org_id, coalesce(p_workspace_id, v_run_workspace), 0) s;

  IF NOT coalesce(v_status_found, false) OR NOT v_in_org THEN
    v_reason := 'plan_not_entitled';
  ELSIF v_ws_paused THEN
    v_reason := 'workspace_budget_paused';
  ELSIF v_org_paused THEN
    v_reason := 'org_budget_paused';
  ELSIF NOT v_run_active THEN
    v_reason := 'run_inactive';
  END IF;

  IF v_reason IS NOT NULL THEN
    UPDATE credit_leases l
    SET status = CASE WHEN v_reason = 'run_inactive' THEN 'released' ELSE 'revoked' END,
        released_at = now(), updated_at = now()
    WHERE l.holder_kind = p_holder_kind AND l.holder_id = p_holder_id AND l.status = 'active';
    RETURN QUERY SELECT v_lease.id, 0::numeric, 0::numeric, 0::numeric, coalesce(v_available, 0), coalesce(v_others, 0), v_reason;
    RETURN;
  END IF;

  v_live := v_found AND v_lease.status = 'active' AND v_lease.expires_at > now();
  v_own := CASE WHEN v_live THEN greatest(v_lease.granted - v_lease.consumed, 0) ELSE 0 END;
  IF v_found AND v_lease.consumed > v_lease.consumed_at_grant THEN
    v_burn := (v_lease.consumed - v_lease.consumed_at_grant)
      / greatest(extract(epoch FROM now() - v_lease.granted_at), 0.5);
  END IF;

  IF p_credit_exempt THEN
    v_target := v_max;
    v_add := greatest(v_target - v_own, 0);
  ELSE
    v_free := v_available - v_others;
    v_target := least(v_fraction * greatest(v_free, 0), coalesce(v_burn * v_horizon, v_initial));
    v_target := least(greatest(v_target, v_min), v_max);
    v_add := least(greatest(v_target - v_own, 0), greatest(v_free - v_own, 0));
  END IF;

  INSERT INTO credit_leases AS l (
    org_id, workspace_id, holder_kind, holder_id, granted, consumed, lease_size,
    consumed_at_grant, granted_at, credit_exempt, status, grants, expires_at
  ) VALUES (
    p_org_id, coalesce(p_workspace_id, v_run_workspace), p_holder_kind, p_holder_id, v_add, 0, v_add,
    0, now(), p_credit_exempt, 'active', 1, now() + v_ttl
  )
  ON CONFLICT (holder_kind, holder_id) DO UPDATE SET
    granted = CASE WHEN v_live THEN greatest(l.granted, l.consumed) ELSE l.consumed END + v_add,
    lease_size = v_own + v_add,
    consumed_at_grant = l.consumed,
    granted_at = now(),
    credit_exempt = p_credit_exempt,
    status = 'active',
    released_at = NULL,
    grants = l.grants + 1,
    expires_at = now() + v_ttl,
    updated_at = now()
  RETURNING l.id, l.granted, l.consumed INTO v_id, v_granted, v_consumed;

  RETURN QUERY SELECT
    v_id,
    v_granted - v_consumed,
    v_own + v_add,
    v_add,
    v_available,
    v_others,
    CASE WHEN v_granted - v_consumed <= 0 AND NOT p_credit_exempt THEN 'credit_exhausted' ELSE NULL END;
END;
$$;
--> statement-breakpoint
-- Settlement: a run that stops spending (finished, failed, paused, cancelled,
-- dead-lettered) releases its lease, whichever path changed the run, and
-- wakes waiters when credits went back to the pool. Resuming re-grants.
CREATE OR REPLACE FUNCTION release_run_credit_lease()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_released numeric;
BEGIN
  IF NEW.status IN ('queued', 'processing')
     AND coalesce(NEW.control_state, '') NOT IN ('paused', 'pause_requested', 'cancelled', 'cancel_requested', 'dead-letter') THEN
    RETURN NEW;
  END IF;
  UPDATE credit_leases l
  SET status = 'released', released_at = now(), updated_at = now()
  WHERE l.holder_kind = 'run' AND l.holder_id = NEW.id AND l.status = 'active'
  RETURNING CASE WHEN l.expires_at > now() AND NOT l.credit_exempt THEN greatest(l.granted - l.consumed, 0) ELSE 0 END
  INTO v_released;
  IF coalesce(v_released, 0) > 0 AND NEW.org_id IS NOT NULL THEN
    PERFORM pg_notify('org_spend_changed', json_build_object('orgId', NEW.org_id, 'reason', 'lease_released')::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_runs_release_credit_lease ON workspace_runs;
--> statement-breakpoint
CREATE TRIGGER workspace_runs_release_credit_lease
  AFTER UPDATE OF status, control_state ON workspace_runs
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.control_state IS DISTINCT FROM NEW.control_state)
  EXECUTE FUNCTION release_run_credit_lease();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_run_credit_lease()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM credit_leases l WHERE l.holder_kind = 'run' AND l.holder_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_runs_delete_credit_lease ON workspace_runs;
--> statement-breakpoint
CREATE TRIGGER workspace_runs_delete_credit_lease
  AFTER DELETE ON workspace_runs
  FOR EACH ROW
  EXECUTE FUNCTION delete_run_credit_lease();
--> statement-breakpoint
-- Event-driven refresh: anything that can let a blocked org spend again
-- (top-ups, auto-recharge and other grants, budget raises or unpausing, plan
-- changes) notifies `org_spend_changed` with the org id, so the app resumes
-- its spend-paused runs at once instead of at the next maintenance sweep.
-- A budget pause revokes the scope's leases, so runs stop at their next
-- checkpoint rather than when their lease runs out. Debits (the flusher moves
-- pending into the balance) lower nothing here and stay silent.
CREATE OR REPLACE FUNCTION notify_org_spend_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.budget_paused AND NOT coalesce(OLD.budget_paused, false) THEN
    UPDATE credit_leases l
    SET status = 'revoked', released_at = now(), updated_at = now()
    WHERE l.org_id = NEW.id AND l.status = 'active';
  END IF;
  PERFORM pg_notify('org_spend_changed', json_build_object('orgId', NEW.id, 'reason', 'org')::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS organizations_notify_spend_changed ON organizations;
--> statement-breakpoint
CREATE TRIGGER organizations_notify_spend_changed
  AFTER UPDATE ON organizations
  FOR EACH ROW
  WHEN (
    NEW.credit_balance_cents > OLD.credit_balance_cents
    OR NEW.included_credits_remaining > OLD.included_credits_remaining
    OR NEW.budget_paused IS DISTINCT FROM OLD.budget_paused
    OR NEW.monthly_budget_cents IS DISTINCT FROM OLD.monthly_budget_cents
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
  )
  EXECUTE FUNCTION notify_org_spend_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_workspace_spend_changed()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.budget_paused AND NOT coalesce(OLD.budget_paused, false) THEN
    UPDATE credit_leases l
    SET status = 'revoked', released_at = now(), updated_at = now()
    WHERE l.org_id = NEW.org_id AND l.workspace_id = NEW.id AND l.status = 'active';
  END IF;
  IF NEW.org_id IS NOT NULL THEN
    PERFORM pg_notify('org_spend_changed', json_build_object('orgId', NEW.org_id, 'reason', 'workspace')::text);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspaces_notify_spend_changed ON workspaces;
--> statement-breakpoint
CREATE TRIGGER workspaces_notify_spend_changed
  AFTER UPDATE ON workspaces
  FOR EACH ROW
  WHEN (
    NEW.budget_paused IS DISTINCT FROM OLD.budget_paused
    OR NEW.monthly_budget_cents IS DISTINCT FROM OLD.monthly_budget_cents
  )
  EXECUTE FUNCTION notify_workspace_spend_changed();
