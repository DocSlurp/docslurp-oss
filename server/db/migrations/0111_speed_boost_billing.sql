-- Fixed four-times-credit opt-in. Existing base-mode reservations and tenant guards are preserved.
-- A run's price choice is an immutable opt-in snapshot, not live workspace configuration.
CREATE OR REPLACE FUNCTION enforce_run_speed_boost_snapshot() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline ? 'speedBoost' AND jsonb_typeof(NEW.pipeline -> 'speedBoost') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'speedBoost must be a JSON boolean';
  END IF;
  IF TG_OP = 'UPDATE' AND coalesce(NEW.pipeline -> 'speedBoost', 'false'::jsonb)
      IS DISTINCT FROM coalesce(OLD.pipeline -> 'speedBoost', 'false'::jsonb) THEN
    RAISE EXCEPTION 'run speedBoost is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_runs_speed_boost_snapshot
BEFORE INSERT OR UPDATE OF pipeline ON workspace_runs
FOR EACH ROW EXECUTE FUNCTION enforce_run_speed_boost_snapshot();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION org_spend_status(
  p_org_id text,
  p_workspace_id text DEFAULT NULL,
  p_run_reserve numeric DEFAULT 0
)
RETURNS TABLE (
  org_id text,
  funded boolean,
  available numeric,
  reserved numeric,
  workspace_budget_paused boolean,
  org_budget_paused boolean,
  workspace_in_org boolean
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.id,
    o.funded_at IS NOT NULL,
    a.available,
    CASE WHEN p_run_reserve > 0 THEN coalesce((
      SELECT sum(CASE WHEN r.pipeline -> 'speedBoost' = 'true'::jsonb
        THEN greatest(0, p_run_reserve * 4 - r.spent_cents)
        ELSE greatest(0, p_run_reserve - (r.input_cost_cents + r.output_cost_cents)) END)
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
  p_credit_exempt boolean DEFAULT false,
  p_chat_reserve numeric DEFAULT 0,
  p_chat_reserve_starter numeric DEFAULT NULL
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
  v_speed_multiplier numeric := 1;
  v_lease credit_leases%ROWTYPE;
  v_found boolean;
  v_live boolean := false;
  v_own numeric := 0;
  v_burn numeric;
  v_available numeric;
  v_funded boolean;
  v_reserve numeric := 0;
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

  SELECT r.org_id, r.workspace_id,
    CASE WHEN r.pipeline -> 'speedBoost' = 'true'::jsonb THEN 4 ELSE 1 END,
    r.status IN ('queued', 'processing')
      AND coalesce(r.control_state, '') NOT IN ('paused', 'pause_requested', 'cancelled', 'cancel_requested', 'dead-letter')
  INTO v_run_org, v_run_workspace, v_speed_multiplier, v_run_active
  FROM workspace_runs r WHERE r.id = p_holder_id;
  IF NOT FOUND OR v_run_org IS DISTINCT FROM p_org_id
     OR (p_workspace_id IS NOT NULL AND v_run_workspace IS DISTINCT FROM p_workspace_id) THEN
    RAISE EXCEPTION 'grant_credit_lease: run % is not in org %', p_holder_id, p_org_id;
  END IF;

  -- Size the initial/minimum/maximum window from the tenant-checked immutable run choice.
  -- Observed burn already includes the multiplier and must not be multiplied again.
  v_min := v_min * v_speed_multiplier;
  v_max := v_max * v_speed_multiplier;
  v_initial := v_initial * v_speed_multiplier;

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

  SELECT true, s.available, s.funded, s.workspace_budget_paused, s.org_budget_paused, s.workspace_in_org,
    CASE WHEN p_credit_exempt THEN 0 ELSE org_outstanding_credit_leases(p_org_id, p_holder_kind, p_holder_id) END
  INTO v_status_found, v_available, v_funded, v_ws_paused, v_org_paused, v_in_org, v_others
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

  IF NOT p_credit_exempt THEN
    v_reserve := greatest(coalesce(
      CASE WHEN v_funded THEN p_chat_reserve ELSE coalesce(p_chat_reserve_starter, p_chat_reserve) END,
      0), 0);
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
    v_free := v_available - v_others - v_reserve;
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
    v_available - v_reserve,
    v_others,
    CASE WHEN v_granted - v_consumed <= 0 AND NOT p_credit_exempt THEN 'credit_exhausted' ELSE NULL END;
END;
$$;
