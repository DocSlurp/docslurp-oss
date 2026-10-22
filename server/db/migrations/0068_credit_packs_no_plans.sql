-- Credit packs and per-unit prices; no subscription plans (2026-10-21).
--
-- destructive-migration: owner-approved plan removal (pricing spec 2026-10-21, pre-release; DB resets are acceptable). Release N-1 reads plan_id, included credits and the old function signatures, so this release must replace every app and worker machine together (no N-1 overlap, no rollback onto this schema) or start from a reset database.
--
-- One prepaid pool (organizations.credit_balance_cents). The included plan
-- allowance, plans, subscriptions, billing periods, past-due state and the
-- unimplemented 12-month inactivity lapse are removed: credits do not expire.
-- "Funded" replaces plans: an org is funded once it receives a paid grant
-- (topup, auto_recharge, adjustment, promo; never starter). funded_at is set
-- by grant_org_credits on that first grant and raises worker_slots to the
-- funded ceiling (FUNDED_WORKER_SLOTS = 250 in packages/shared/src/billing.ts;
-- STARTER_WORKER_SLOTS = 50 is the column default). Chat reserve, indexing
-- default, rate limits and video caps read funded instead of the plan.

-- 1. Fold any included allowance into the prepaid pool, then record funding.
UPDATE organizations
SET credit_balance_cents = credit_balance_cents + included_credits_remaining, updated_at = now()
WHERE included_credits_remaining > 0;
--> statement-breakpoint
UPDATE credit_grants
SET source = 'adjustment', metadata = metadata || jsonb_build_object('migratedFrom', 'subscription')
WHERE source = 'subscription';
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS funded_at timestamptz;
--> statement-breakpoint
UPDATE organizations o
SET funded_at = g.first_paid_at, worker_slots = greatest(o.worker_slots, 250), updated_at = now()
FROM (
  SELECT org_id, min(created_at) AS first_paid_at
  FROM credit_grants
  WHERE source IN ('topup', 'auto_recharge', 'adjustment', 'promo') AND credits - reversed_credits > 0
  GROUP BY org_id
) g
WHERE g.org_id = o.id;
--> statement-breakpoint
-- 2. Functions and triggers that read the columns dropped below.
DROP TRIGGER IF EXISTS organizations_notify_spend_changed ON organizations;
--> statement-breakpoint
DROP FUNCTION IF EXISTS expire_included_credits(text, text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS org_spend_status(text, text, numeric);
--> statement-breakpoint
DROP FUNCTION IF EXISTS org_available_credits(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS debit_org_credits(text, numeric, text, text, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grant_org_credits(text, text, text, text, numeric, boolean, text, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS append_credit_ledger(text, text, numeric, text, text, jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grant_credit_lease(text, text, text, text, numeric, numeric, numeric, numeric, numeric, integer, boolean, numeric, numeric);
--> statement-breakpoint
-- 3. Drop plan, subscription, period, past-due, included and lapse state.
ALTER TABLE organizations
  DROP COLUMN IF EXISTS plan_id,
  DROP COLUMN IF EXISTS scheduled_plan_id,
  DROP COLUMN IF EXISTS included_credits_remaining,
  DROP COLUMN IF EXISTS included_credits_granted,
  DROP COLUMN IF EXISTS subscription_status,
  DROP COLUMN IF EXISTS current_period_start,
  DROP COLUMN IF EXISTS current_period_end,
  DROP COLUMN IF EXISTS cancel_at_period_end,
  DROP COLUMN IF EXISTS past_due_since,
  DROP COLUMN IF EXISTS stripe_subscription_id,
  DROP COLUMN IF EXISTS last_billable_activity_at;
--> statement-breakpoint
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_pool_check;
--> statement-breakpoint
ALTER TABLE credit_ledger DROP COLUMN IF EXISTS pool;
--> statement-breakpoint
ALTER TABLE credit_grants DROP CONSTRAINT IF EXISTS credit_grants_pool_check;
--> statement-breakpoint
ALTER TABLE credit_grants DROP COLUMN IF EXISTS pool;
--> statement-breakpoint
ALTER TABLE credit_grants DROP CONSTRAINT IF EXISTS credit_grants_source_check;
--> statement-breakpoint
ALTER TABLE credit_grants ADD CONSTRAINT credit_grants_source_check
  CHECK (source IN ('topup', 'auto_recharge', 'starter', 'promo', 'adjustment', 'refund'));
--> statement-breakpoint
-- 4. Single-pool ledger and balance functions.
CREATE FUNCTION append_credit_ledger(
  p_org_id text,
  p_user_id text,
  p_credits numeric,
  p_reason text,
  p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_credits IS NULL OR p_credits = 0 THEN
    RETURN;
  END IF;
  -- credit_ledger.delta is denominated in dollars (credits / 100).
  INSERT INTO credit_ledger (id, user_id, org_id, delta, reason, metadata, created_at)
  VALUES (
    gen_random_uuid()::text,
    p_user_id,
    p_org_id,
    p_credits / 100.0,
    p_reason,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('orgId', p_org_id),
    now()
  );
END;
$$;
--> statement-breakpoint
-- Spend credits from the prepaid pool (may go negative so an admitted run can
-- finish). FOR NO KEY UPDATE, as in 0028, so FK checks on the org row never wait.
CREATE FUNCTION debit_org_credits(
  p_org_id text,
  p_credits numeric,
  p_user_id text DEFAULT NULL,
  p_reason text DEFAULT 'usage',
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  v_user text;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RETURN 0;
  END IF;
  SELECT coalesce(p_user_id, o.created_by_user_id) INTO v_user
  FROM organizations o WHERE o.id = p_org_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  UPDATE organizations o
  SET credit_balance_cents = o.credit_balance_cents - p_credits, updated_at = now()
  WHERE o.id = p_org_id;
  PERFORM append_credit_ledger(p_org_id, v_user, -p_credits, p_reason, p_metadata);
  RETURN p_credits;
END;
$$;
--> statement-breakpoint
-- What admission, the overview and auto top-up compare against.
CREATE FUNCTION org_available_credits(p_org_id text)
RETURNS TABLE (balance numeric, pending numeric, available numeric)
LANGUAGE sql STABLE AS $$
  SELECT o.credit_balance_cents, x.pending, o.credit_balance_cents - x.pending
  FROM organizations o
  CROSS JOIN LATERAL (SELECT pending_org_debit_credits(o.id) AS pending) x
  WHERE o.id = p_org_id
$$;
--> statement-breakpoint
-- Grant credits once per (source, external_id), after applying pending debits
-- so the balance moves in the order usage happened. A paid source marks the
-- org funded on its first grant and raises worker_slots to the funded ceiling.
CREATE FUNCTION grant_org_credits(
  p_org_id text,
  p_source text,
  p_external_id text,
  p_credits numeric,
  p_user_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_grant_id text;
  v_user text;
  v_funded_at timestamptz;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('source', p_source, 'externalId', p_external_id);
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN
    RAISE EXCEPTION 'grant_org_credits: credits must be >= 0 (got %)', p_credits;
  END IF;

  PERFORM * FROM apply_pending_org_debits(p_org_id);

  SELECT coalesce(p_user_id, o.created_by_user_id), o.funded_at INTO v_user, v_funded_at
  FROM organizations o WHERE o.id = p_org_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant_org_credits: organization % not found', p_org_id;
  END IF;

  INSERT INTO credit_grants (org_id, source, external_id, credits, metadata)
  VALUES (p_org_id, p_source, p_external_id, p_credits, coalesce(p_metadata, '{}'::jsonb))
  ON CONFLICT (source, external_id) DO NOTHING
  RETURNING id INTO v_grant_id;
  IF v_grant_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE organizations o
  SET credit_balance_cents = o.credit_balance_cents + p_credits,
      funded_at = CASE
        WHEN o.funded_at IS NULL AND p_source IN ('topup', 'auto_recharge', 'adjustment', 'promo') AND p_credits > 0
        THEN now() ELSE o.funded_at END,
      worker_slots = CASE
        WHEN o.funded_at IS NULL AND p_source IN ('topup', 'auto_recharge', 'adjustment', 'promo') AND p_credits > 0
        THEN greatest(o.worker_slots, 250) ELSE o.worker_slots END,
      updated_at = now()
  WHERE o.id = p_org_id;
  PERFORM append_credit_ledger(p_org_id, v_user, p_credits, 'grant:' || p_source, v_metadata || jsonb_build_object('grantId', v_grant_id));
  RETURN true;
END;
$$;
--> statement-breakpoint
-- Claw back a grant (refund, lost dispute, voided Stripe credit grant).
-- p_target_reversed is cumulative, so repeated refund events are idempotent.
-- An org whose paid grants are all reversed is starter again.
CREATE OR REPLACE FUNCTION reverse_credit_grant(
  p_grant_id text,
  p_target_reversed numeric,
  p_reason text,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  g credit_grants%ROWTYPE;
  v_amount numeric;
  v_user text;
BEGIN
  SELECT * INTO g FROM credit_grants WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_amount := least(greatest(coalesce(p_target_reversed, 0), 0), g.credits) - g.reversed_credits;
  IF v_amount <= 0 THEN
    RETURN 0;
  END IF;

  PERFORM * FROM apply_pending_org_debits(g.org_id);
  SELECT o.created_by_user_id INTO v_user FROM organizations o WHERE o.id = g.org_id FOR UPDATE;

  UPDATE credit_grants SET reversed_credits = reversed_credits + v_amount WHERE id = g.id;
  UPDATE organizations o
  SET credit_balance_cents = o.credit_balance_cents - v_amount, updated_at = now()
  WHERE o.id = g.org_id;
  UPDATE organizations o
  SET funded_at = NULL, worker_slots = CASE WHEN o.worker_slots = 250 THEN 50 ELSE o.worker_slots END, updated_at = now()
  WHERE o.id = g.org_id AND o.funded_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM credit_grants x
      WHERE x.org_id = g.org_id AND x.source IN ('topup', 'auto_recharge', 'adjustment', 'promo')
        AND x.credits - x.reversed_credits > 0
    );

  PERFORM append_credit_ledger(g.org_id, v_user, -v_amount, p_reason,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('grantId', g.id, 'source', g.source, 'externalId', g.external_id));
  RETURN v_amount;
END;
$$;
--> statement-breakpoint
-- The one-per-user starter grant (STARTER_CREDITS = 250), single pool.
CREATE OR REPLACE FUNCTION grant_new_account_starter_credit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grant_id text;
BEGIN
  INSERT INTO starter_credit_claims (user_id) VALUES (NEW.personal_owner_user_id)
  ON CONFLICT (user_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  INSERT INTO credit_ledger (id, user_id, org_id, delta, reason, metadata)
  VALUES (
    gen_random_uuid()::text,
    NEW.personal_owner_user_id,
    NEW.id,
    2.50,
    'new-account-starter-credit',
    jsonb_build_object('orgId', NEW.id, 'source', 'account-onboarding', 'amountCents', 250)
  )
  ON CONFLICT (user_id) WHERE reason = 'new-account-starter-credit' DO NOTHING
  RETURNING id INTO grant_id;

  IF grant_id IS NOT NULL THEN
    INSERT INTO credit_grants (org_id, source, external_id, credits, metadata)
    VALUES (NEW.id, 'starter', NEW.personal_owner_user_id, 250, jsonb_build_object('ledgerId', grant_id))
    ON CONFLICT (source, external_id) DO NOTHING;
    UPDATE organizations SET credit_balance_cents = credit_balance_cents + 250,
      updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- 5. Spend status: `funded` replaces `plan_id`.
CREATE FUNCTION org_spend_status(
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
-- grant_credit_lease (0053) with the chat reserve chosen by funding:
-- p_chat_reserve for funded orgs, p_chat_reserve_starter (default
-- p_chat_reserve) for starter orgs. Same argument types as 0053.
CREATE FUNCTION grant_credit_lease(
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
--> statement-breakpoint
-- 6. Triggers without plan_id / included credits.
CREATE TRIGGER organizations_notify_spend_changed
  AFTER UPDATE ON organizations
  FOR EACH ROW
  WHEN (
    NEW.credit_balance_cents > OLD.credit_balance_cents
    OR NEW.budget_paused IS DISTINCT FROM OLD.budget_paused
    OR NEW.monthly_budget_cents IS DISTINCT FROM OLD.monthly_budget_cents
    OR NEW.funded_at IS DISTINCT FROM OLD.funded_at
  )
  EXECUTE FUNCTION notify_org_spend_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_org_retention_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retain_document_versions IS DISTINCT FROM OLD.retain_document_versions THEN
    NEW.retention_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
