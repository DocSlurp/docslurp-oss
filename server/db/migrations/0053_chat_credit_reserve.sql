-- Chat credit reserve and interactive overdraft (docs/pricing-and-credits.md,
-- "Chat reserve and overdraft"; packages/shared/src/chat-reserve.ts).
--
-- Since credit leases (0052) chat and search subtracted every live lease, so
-- a small org whose running upload held its last credits got 402s although
-- nothing had been spent. Now:
--  - jobs (credit leases here; run admission, the worker's mid-run check and
--    media admission in TS) leave a small per-plan reserve untouched, so the
--    last few credits are always there for chat;
--  - interactive spend is not blocked by leases on a positive balance and may carry a small negative balance
--    (admit_interactive_spend below), paid back by the next top-up,
--    auto-recharge or plan grant. Only orgs that received credits at least
--    once may overdraw (org_has_credit_grants).
--
-- Grant_credit_lease gains two trailing parameters with defaults, so a worker
-- still on the 0052 call (11 arguments) keeps working with no reserve.
DROP FUNCTION IF EXISTS grant_credit_lease(text, text, text, text, numeric, numeric, numeric, numeric, numeric, integer, boolean);
--> statement-breakpoint
-- Same as 0052, plus the chat reserve:
--   free = available - other live leases - reserve(plan)
-- where reserve = p_chat_reserve on paid plans and p_chat_reserve_free
-- (default p_chat_reserve) on Free, and 0 for billing-exempt orgs. The org
-- invariant becomes: live leases <= available - reserve.
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
  p_chat_reserve_free numeric DEFAULT NULL
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
  v_plan text;
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

  -- One snapshot for balance, plan, flags and other leases.
  SELECT true, s.available, s.plan_id, s.workspace_budget_paused, s.org_budget_paused, s.workspace_in_org,
    CASE WHEN p_credit_exempt THEN 0 ELSE org_outstanding_credit_leases(p_org_id, p_holder_kind, p_holder_id) END
  INTO v_status_found, v_available, v_plan, v_ws_paused, v_org_paused, v_in_org, v_others
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
    -- organizations.plan_id is constrained to free/silver/gold/platinum.
    v_reserve := greatest(coalesce(
      CASE WHEN v_plan = 'free' THEN coalesce(p_chat_reserve_free, p_chat_reserve) ELSE p_chat_reserve END,
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

  -- available_credits reports what jobs may use (available - reserve), so a
  -- refused grant reads as "out of credits for jobs", not a positive balance.
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
--> statement-breakpoint
-- Whether the org ever received credits that were not reversed (starter,
-- top-up, auto-recharge, plan grant, promo, adjustment). Gates the
-- interactive overdraft so empty orgs cannot overdraw.
CREATE OR REPLACE FUNCTION org_has_credit_grants(p_org_id text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM credit_grants g
    WHERE g.org_id = p_org_id AND g.credits - g.reversed_credits > 0
  )
$$;
--> statement-breakpoint
-- Short holds taken by interactive calls near or below zero. Not leases:
-- they never count against jobs or the displayed balance; they only stop
-- concurrent chat calls from all passing on the last of the overdraft
-- allowance. They expire on their own (no release path to forget).
CREATE TABLE IF NOT EXISTS interactive_spend_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  workspace_id text,
  credits numeric(24,12) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT interactive_spend_holds_credits_check CHECK (credits >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS interactive_spend_holds_org_idx
  ON interactive_spend_holds (org_id, expires_at) INCLUDE (credits);
--> statement-breakpoint
-- Interactive admission near or below zero, serialized per org on the
-- spend-admission advisory lock: admitted while
--   available - live run leases - live holds > -p_allowance
-- and, when admitted, hold p_hold credits for p_ttl_seconds. Leases count
-- toward the overdraft floor, not against a positive balance: grants keep
-- leases <= available - reserve, so they only matter once chat has spent
-- credits that running jobs still hold, and then the jobs' remaining spend
-- is part of the allowance instead of landing below it. Callers check
-- budget caps and entitlement first and pass the allowance for the org's
-- plan (0 when the org may not overdraw). Concurrent calls therefore see
-- each other's holds, which bounds the overdraft at the allowance plus what
-- an admitted call spends beyond its hold.
CREATE OR REPLACE FUNCTION admit_interactive_spend(
  p_org_id text,
  p_workspace_id text,
  p_allowance numeric,
  p_hold numeric,
  p_ttl_seconds integer
) RETURNS TABLE (admitted boolean, available numeric, held numeric)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_available numeric;
  v_leased numeric;
  v_held numeric;
  v_ok boolean;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'admit_interactive_spend: org is required';
  END IF;
  PERFORM pg_advisory_xact_lock(spend_admission_lock_key(p_org_id));
  DELETE FROM interactive_spend_holds h WHERE h.org_id = p_org_id AND h.expires_at <= now();
  SELECT a.available INTO v_available FROM org_available_credits(p_org_id) a;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::numeric, 0::numeric;
    RETURN;
  END IF;
  SELECT coalesce(sum(h.credits), 0) INTO v_held
  FROM interactive_spend_holds h WHERE h.org_id = p_org_id AND h.expires_at > now();
  v_leased := org_outstanding_credit_leases(p_org_id);
  v_ok := v_available - v_leased - v_held > -greatest(coalesce(p_allowance, 0), 0);
  IF v_ok AND coalesce(p_hold, 0) > 0 THEN
    INSERT INTO interactive_spend_holds (org_id, workspace_id, credits, expires_at)
    VALUES (p_org_id, p_workspace_id, p_hold,
      now() + make_interval(secs => least(greatest(coalesce(p_ttl_seconds, 120), 1), 3600)));
  END IF;
  RETURN QUERY SELECT v_ok, v_available, v_leased + v_held;
END;
$$;
