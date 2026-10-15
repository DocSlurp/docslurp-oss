-- Service plans and two credit pools (docs/pricing-and-credits.md).
--
-- 1 credit = 1 cent. organizations.credit_balance_cents is the PREPAID pool
-- (top-ups, auto-recharge, starter and promotional credits; may go negative
-- after a run overdraws). included_credits_remaining is the plan's monthly
-- allowance, reset on each paid renewal invoice. Usage spends included first,
-- then prepaid, only through debit_org_credits() so the worker and the API
-- cannot drift. The old token-denominated rate-limit tables are dropped.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS plan_id text DEFAULT 'free' NOT NULL,
  ADD COLUMN IF NOT EXISTS worker_slots integer DEFAULT 2 NOT NULL,
  ADD COLUMN IF NOT EXISTS included_credits_remaining numeric(24,12) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS included_credits_granted numeric(24,12) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'none' NOT NULL,
  ADD COLUMN IF NOT EXISTS current_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS scheduled_plan_id text,
  ADD COLUMN IF NOT EXISTS past_due_since timestamptz,
  ADD COLUMN IF NOT EXISTS auto_recharge_enabled boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS auto_recharge_threshold_credits integer,
  ADD COLUMN IF NOT EXISTS auto_recharge_amount_cents integer,
  ADD COLUMN IF NOT EXISTS auto_recharge_monthly_limit_cents integer,
  ADD COLUMN IF NOT EXISTS auto_recharge_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_recharge_consecutive_failures integer DEFAULT 0 NOT NULL,
  -- PaymentIntent (or attempt key) of the last counted failure: sweeper and webhook both report it once.
  ADD COLUMN IF NOT EXISTS auto_recharge_last_failure_ref text,
  ADD COLUMN IF NOT EXISTS auto_recharge_authorized_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_recharge_authorized_by_user_id text,
  ADD COLUMN IF NOT EXISTS last_billable_activity_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations
  ADD CONSTRAINT organizations_plan_id_check CHECK (plan_id IN ('free', 'silver', 'gold', 'platinum')),
  ADD CONSTRAINT organizations_scheduled_plan_id_check CHECK (scheduled_plan_id IS NULL OR scheduled_plan_id IN ('free', 'silver', 'gold', 'platinum')),
  ADD CONSTRAINT organizations_worker_slots_check CHECK (worker_slots > 0),
  ADD CONSTRAINT organizations_included_credits_check CHECK (included_credits_remaining >= 0),
  ADD CONSTRAINT organizations_auto_recharge_authorized_by_fkey
    FOREIGN KEY (auto_recharge_authorized_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organizations_auto_recharge_idx ON organizations (id) WHERE auto_recharge_enabled;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organizations_past_due_idx ON organizations (past_due_since) WHERE past_due_since IS NOT NULL;
--> statement-breakpoint
-- Ledger rows carry their org and pool so the billing ledger is an indexed read.
ALTER TABLE credit_ledger
  ADD COLUMN IF NOT EXISTS org_id text,
  ADD COLUMN IF NOT EXISTS pool text;
--> statement-breakpoint
UPDATE credit_ledger l SET org_id = l.metadata ->> 'orgId'
WHERE l.org_id IS NULL AND EXISTS (SELECT 1 FROM organizations o WHERE o.id = l.metadata ->> 'orgId');
--> statement-breakpoint
UPDATE credit_ledger SET pool = 'prepaid' WHERE pool IS NULL;
--> statement-breakpoint
ALTER TABLE credit_ledger
  ADD CONSTRAINT credit_ledger_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  ADD CONSTRAINT credit_ledger_pool_check CHECK (pool IS NULL OR pool IN ('included', 'prepaid'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_ledger_org_created_idx ON credit_ledger (org_id, created_at DESC);
--> statement-breakpoint
-- One row per credit grant, keyed by the Stripe object (or user, for the
-- starter grant) that paid for it. Refunds and lost disputes raise
-- reversed_credits, never beyond credits.
CREATE TABLE IF NOT EXISTS credit_grants (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
  org_id text NOT NULL,
  source text NOT NULL,
  external_id text,
  credits numeric(24,12) NOT NULL,
  pool text NOT NULL,
  reversed_credits numeric(24,12) DEFAULT 0 NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT credit_grants_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT credit_grants_source_check CHECK (source IN ('subscription', 'topup', 'auto_recharge', 'starter', 'promo', 'adjustment')),
  CONSTRAINT credit_grants_pool_check CHECK (pool IN ('included', 'prepaid')),
  CONSTRAINT credit_grants_credits_check CHECK (credits >= 0),
  CONSTRAINT credit_grants_reversed_check CHECK (reversed_credits >= 0 AND reversed_credits <= credits),
  CONSTRAINT credit_grants_source_external_id_key UNIQUE (source, external_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grants_org_created_idx ON credit_grants (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grants_payment_intent_idx ON credit_grants ((metadata ->> 'paymentIntentId')) WHERE metadata ? 'paymentIntentId';
--> statement-breakpoint
-- Daily storage meter: one row per org per UTC day makes the charge idempotent.
CREATE TABLE IF NOT EXISTS storage_meter_days (
  org_id text NOT NULL,
  day date NOT NULL,
  object_bytes bigint DEFAULT 0 NOT NULL,
  index_bytes bigint DEFAULT 0 NOT NULL,
  credits numeric(24,12) DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT storage_meter_days_pkey PRIMARY KEY (org_id, day),
  CONSTRAINT storage_meter_days_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);
--> statement-breakpoint
-- Existing top-ups become prepaid grants; stripe_topups is retired.
INSERT INTO credit_grants (org_id, source, external_id, credits, pool, metadata, created_at)
SELECT org_id, 'topup', payment_intent_id, amount_cents, 'prepaid',
  jsonb_build_object('paymentIntentId', payment_intent_id, 'migratedFrom', 'stripe_topups'), created_at
FROM stripe_topups
ON CONFLICT (source, external_id) DO NOTHING;
--> statement-breakpoint
DROP TABLE IF EXISTS stripe_topups;
--> statement-breakpoint
DROP TABLE IF EXISTS org_rate_limits;
--> statement-breakpoint
DROP TABLE IF EXISTS rate_limit_usage;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_tier_prices;
--> statement-breakpoint
DROP TABLE IF EXISTS subscription_usage;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION append_credit_ledger(
  p_org_id text,
  p_user_id text,
  p_credits numeric,
  p_reason text,
  p_pool text,
  p_metadata jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_credits IS NULL OR p_credits = 0 THEN
    RETURN;
  END IF;
  -- credit_ledger.delta is denominated in dollars (credits / 100).
  INSERT INTO credit_ledger (id, user_id, org_id, pool, delta, reason, metadata, created_at)
  VALUES (
    gen_random_uuid()::text,
    p_user_id,
    p_org_id,
    p_pool,
    p_credits / 100.0,
    p_reason,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('orgId', p_org_id),
    now()
  );
END;
$$;
--> statement-breakpoint
-- Spend credits: included pool first, then prepaid (which may go negative so an
-- admitted run can finish). The org row is locked, then one UPDATE whose
-- right-hand sides all read the pre-update values applies both pools.
CREATE OR REPLACE FUNCTION debit_org_credits(
  p_org_id text,
  p_credits numeric,
  p_user_id text DEFAULT NULL,
  p_reason text DEFAULT 'usage',
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS TABLE (from_included numeric, from_prepaid numeric)
LANGUAGE plpgsql AS $$
DECLARE
  v_included numeric;
  v_user text;
  v_from_included numeric;
  v_from_prepaid numeric;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric;
    RETURN;
  END IF;

  SELECT o.included_credits_remaining, coalesce(p_user_id, o.created_by_user_id)
  INTO v_included, v_user
  FROM organizations o
  WHERE o.id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric;
    RETURN;
  END IF;

  v_from_included := least(p_credits, greatest(v_included, 0));
  v_from_prepaid := p_credits - v_from_included;

  UPDATE organizations o
  SET
    included_credits_remaining = greatest(o.included_credits_remaining - p_credits, 0),
    credit_balance_cents = o.credit_balance_cents - greatest(p_credits - greatest(o.included_credits_remaining, 0), 0),
    -- Storage accrual is not account activity (prepaid credits lapse after 12 idle months).
    last_billable_activity_at = CASE WHEN p_reason = 'storage' THEN o.last_billable_activity_at ELSE now() END,
    updated_at = now()
  WHERE o.id = p_org_id;

  PERFORM append_credit_ledger(p_org_id, v_user, -v_from_included, p_reason, 'included', p_metadata);
  PERFORM append_credit_ledger(p_org_id, v_user, -v_from_prepaid, p_reason, 'prepaid', p_metadata);

  RETURN QUERY SELECT v_from_included, v_from_prepaid;
END;
$$;
--> statement-breakpoint
-- Grant credits once per (source, external_id). Included grants first pay down
-- a negative prepaid balance; p_reset_included expires the previous period's
-- unused allowance (renewal invoices) instead of adding to it (prorations).
CREATE OR REPLACE FUNCTION grant_org_credits(
  p_org_id text,
  p_source text,
  p_external_id text,
  p_pool text,
  p_credits numeric,
  p_reset_included boolean DEFAULT false,
  p_user_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_grant_id text;
  v_user text;
  v_included numeric;
  v_prepaid numeric;
  v_paydown numeric := 0;
  v_to_included numeric := 0;
  v_reason text := 'grant:' || p_source;
  v_metadata jsonb := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('source', p_source, 'externalId', p_external_id);
BEGIN
  IF p_credits IS NULL OR p_credits < 0 THEN
    RAISE EXCEPTION 'grant_org_credits: credits must be >= 0 (got %)', p_credits;
  END IF;

  SELECT o.included_credits_remaining, o.credit_balance_cents, coalesce(p_user_id, o.created_by_user_id)
  INTO v_included, v_prepaid, v_user
  FROM organizations o
  WHERE o.id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'grant_org_credits: organization % not found', p_org_id;
  END IF;

  INSERT INTO credit_grants (org_id, source, external_id, credits, pool, metadata)
  VALUES (p_org_id, p_source, p_external_id, p_credits, p_pool, coalesce(p_metadata, '{}'::jsonb))
  ON CONFLICT (source, external_id) DO NOTHING
  RETURNING id INTO v_grant_id;

  IF v_grant_id IS NULL THEN
    RETURN false;
  END IF;
  v_metadata := v_metadata || jsonb_build_object('grantId', v_grant_id);

  IF p_pool = 'included' THEN
    IF p_reset_included AND v_included > 0 THEN
      PERFORM append_credit_ledger(p_org_id, v_user, -v_included, 'included_expired', 'included', v_metadata);
      v_included := 0;
    END IF;
    v_paydown := least(p_credits, greatest(-v_prepaid, 0));
    v_to_included := p_credits - v_paydown;
    UPDATE organizations o
    SET
      included_credits_remaining = v_included + v_to_included,
      included_credits_granted = CASE WHEN p_reset_included THEN p_credits ELSE o.included_credits_granted + p_credits END,
      credit_balance_cents = o.credit_balance_cents + v_paydown,
      updated_at = now()
    WHERE o.id = p_org_id;
    PERFORM append_credit_ledger(p_org_id, v_user, v_to_included, v_reason, 'included', v_metadata);
    PERFORM append_credit_ledger(p_org_id, v_user, v_paydown, v_reason, 'prepaid', v_metadata || '{"paysDownOverdraft": true}'::jsonb);
  ELSE
    UPDATE organizations o
    SET credit_balance_cents = o.credit_balance_cents + p_credits, updated_at = now()
    WHERE o.id = p_org_id;
    PERFORM append_credit_ledger(p_org_id, v_user, p_credits, v_reason, 'prepaid', v_metadata);
  END IF;

  RETURN true;
END;
$$;
--> statement-breakpoint
-- Claw back a grant (refund, lost dispute). p_target_reversed is the cumulative
-- amount that should be reversed so far, so repeated charge.refunded events
-- (which report cumulative refunds) are idempotent. Never exceeds the grant.
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
  v_included numeric;
  v_user text;
  v_from_included numeric := 0;
  v_metadata jsonb;
BEGIN
  SELECT * INTO g FROM credit_grants WHERE id = p_grant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  v_amount := least(greatest(coalesce(p_target_reversed, 0), 0), g.credits) - g.reversed_credits;
  IF v_amount <= 0 THEN
    RETURN 0;
  END IF;

  SELECT o.included_credits_remaining, o.created_by_user_id
  INTO v_included, v_user
  FROM organizations o
  WHERE o.id = g.org_id
  FOR UPDATE;

  UPDATE credit_grants SET reversed_credits = reversed_credits + v_amount WHERE id = g.id;

  IF g.pool = 'included' THEN
    v_from_included := least(v_amount, greatest(v_included, 0));
  END IF;

  UPDATE organizations o
  SET
    included_credits_remaining = o.included_credits_remaining - v_from_included,
    credit_balance_cents = o.credit_balance_cents - (v_amount - v_from_included),
    updated_at = now()
  WHERE o.id = g.org_id;

  v_metadata := coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('grantId', g.id, 'source', g.source, 'externalId', g.external_id);
  PERFORM append_credit_ledger(g.org_id, v_user, -v_from_included, p_reason, 'included', v_metadata);
  PERFORM append_credit_ledger(g.org_id, v_user, -(v_amount - v_from_included), p_reason, 'prepaid', v_metadata);
  RETURN v_amount;
END;
$$;
--> statement-breakpoint
-- Drop the included allowance (cancellation, period end without renewal).
CREATE OR REPLACE FUNCTION expire_included_credits(p_org_id text, p_reason text DEFAULT 'included_expired')
RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  v_included numeric;
  v_user text;
BEGIN
  SELECT o.included_credits_remaining, o.created_by_user_id INTO v_included, v_user
  FROM organizations o WHERE o.id = p_org_id FOR UPDATE;
  IF NOT FOUND OR v_included <= 0 THEN
    RETURN 0;
  END IF;
  UPDATE organizations SET included_credits_remaining = 0, updated_at = now() WHERE id = p_org_id;
  PERFORM append_credit_ledger(p_org_id, v_user, -v_included, p_reason, 'included', '{}'::jsonb);
  RETURN v_included;
END;
$$;
--> statement-breakpoint
-- The one-per-user starter grant now goes through credit_grants as well.
CREATE OR REPLACE FUNCTION grant_new_account_starter_credit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grant_id text;
BEGIN
  INSERT INTO credit_ledger (id, user_id, org_id, pool, delta, reason, metadata)
  VALUES (
    gen_random_uuid()::text,
    NEW.personal_owner_user_id,
    NEW.id,
    'prepaid',
    20.00,
    'new-account-starter-credit',
    jsonb_build_object('orgId', NEW.id, 'source', 'account-onboarding', 'amountCents', 2000)
  )
  ON CONFLICT (user_id) WHERE reason = 'new-account-starter-credit' DO NOTHING
  RETURNING id INTO grant_id;

  IF grant_id IS NOT NULL THEN
    INSERT INTO credit_grants (org_id, source, external_id, credits, pool, metadata)
    VALUES (NEW.id, 'starter', NEW.personal_owner_user_id, 2000, 'prepaid', jsonb_build_object('ledgerId', grant_id))
    ON CONFLICT (source, external_id) DO NOTHING;
    UPDATE organizations SET credit_balance_cents = credit_balance_cents + 2000,
      updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
