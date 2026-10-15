-- Aggregated credit debits (docs/pricing-and-credits.md, "Billing latency").
--
-- Before: every billed checkpoint called debit_org_credits(), which locks the
-- org's organizations row until commit. At 576 slots in one org (2026-10-09
-- load-test re-run) ~550 backends queued on that row, each debit took ~12 s
-- and throughput fell to zero.
--
-- Now the hot path only appends a row to credit_debits_pending (insert-only,
-- no lock on organizations, no FK: a foreign-key check would take FOR KEY
-- SHARE on the org row from every concurrent checkpoint). A flusher (worker
-- maintenance leader every ~2 s, app maintenance sweeper every ~5 s) applies
-- each org's pending rows through debit_org_credits() in one transaction that
-- deletes exactly the rows it applied, so each pending debit is spent once.
-- Admission, the billing overview and auto-recharge subtract pending debits
-- (org_available_credits), so a burst cannot spend credits twice.
CREATE TABLE IF NOT EXISTS credit_debits_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  user_id text,
  run_id text,
  workspace_id text,
  reason text DEFAULT 'usage' NOT NULL,
  credits numeric(24,12) NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT credit_debits_pending_credits_check CHECK (credits > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_debits_pending_org_idx ON credit_debits_pending (org_id) INCLUDE (credits);
--> statement-breakpoint
-- Hot path: record a debit to apply later. Never touches organizations.
CREATE OR REPLACE FUNCTION enqueue_org_credit_debit(
  p_org_id text,
  p_credits numeric,
  p_user_id text DEFAULT NULL,
  p_reason text DEFAULT 'usage',
  p_run_id text DEFAULT NULL,
  p_workspace_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_org_id IS NULL OR p_credits IS NULL OR p_credits <= 0 THEN
    RETURN;
  END IF;
  INSERT INTO credit_debits_pending (org_id, user_id, run_id, workspace_id, reason, credits, metadata)
  VALUES (p_org_id, p_user_id, p_run_id, p_workspace_id, coalesce(p_reason, 'usage'), p_credits, coalesce(p_metadata, '{}'::jsonb));
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pending_org_debit_credits(p_org_id text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(p.credits), 0) FROM credit_debits_pending p WHERE p.org_id = p_org_id
$$;
--> statement-breakpoint
-- What admission, the overview and auto-recharge compare against.
CREATE OR REPLACE FUNCTION org_available_credits(p_org_id text)
RETURNS TABLE (included numeric, prepaid numeric, pending numeric, available numeric)
LANGUAGE sql STABLE AS $$
  SELECT o.included_credits_remaining, o.credit_balance_cents, x.pending,
    o.included_credits_remaining + o.credit_balance_cents - x.pending
  FROM organizations o
  CROSS JOIN LATERAL (SELECT pending_org_debit_credits(o.id) AS pending) x
  WHERE o.id = p_org_id
$$;
--> statement-breakpoint
-- Orgs with pending debits, oldest first.
CREATE OR REPLACE FUNCTION pending_debit_orgs(p_limit integer DEFAULT 500)
RETURNS TABLE (org_id text, debits integer, credits numeric)
LANGUAGE sql STABLE AS $$
  SELECT p.org_id, count(*)::int, sum(p.credits)
  FROM credit_debits_pending p
  GROUP BY p.org_id
  ORDER BY min(p.created_at)
  LIMIT greatest(p_limit, 1)
$$;
--> statement-breakpoint
-- Apply one org's pending debits: one debit_org_credits() call (so one ledger
-- row per pool) per (reason, user), with the per-run breakdown in metadata.
-- The org row lock serializes this with direct debits, grants and other
-- flushes; the DELETE runs after the lock, so a pending row is applied by
-- exactly one transaction. Rows committed after the DELETE wait for the next
-- flush. p_skip_locked lets a background flusher pass over a busy org.
CREATE OR REPLACE FUNCTION apply_pending_org_debits(p_org_id text, p_skip_locked boolean DEFAULT false)
RETURNS TABLE (debits integer, credits numeric)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  v_groups jsonb;
  v_group jsonb;
  v_debits integer := 0;
  v_credits numeric := 0;
  v_run_count integer;
  v_metadata jsonb;
BEGIN
  IF p_skip_locked THEN
    PERFORM 1 FROM organizations o WHERE o.id = p_org_id FOR NO KEY UPDATE SKIP LOCKED;
  ELSE
    PERFORM 1 FROM organizations o WHERE o.id = p_org_id FOR NO KEY UPDATE;
  END IF;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_org_id) THEN
      -- Deleted org: its pending debits have nothing left to charge.
      DELETE FROM credit_debits_pending p WHERE p.org_id = p_org_id;
    END IF;
    RETURN QUERY SELECT 0, 0::numeric;
    RETURN;
  END IF;

  WITH taken AS (
    DELETE FROM credit_debits_pending p
    WHERE p.org_id = p_org_id
    RETURNING p.user_id, p.reason, p.run_id, p.workspace_id, p.credits, p.created_at
  ),
  per_run AS (
    SELECT t.reason, t.user_id, t.run_id, max(t.workspace_id) AS workspace_id,
      sum(t.credits) AS credits, count(*) AS n, min(t.created_at) AS first_at, max(t.created_at) AS last_at,
      row_number() OVER (PARTITION BY t.reason, t.user_id ORDER BY sum(t.credits) DESC, t.run_id) AS rank
    FROM taken t
    GROUP BY t.reason, t.user_id, t.run_id
  )
  SELECT coalesce(jsonb_agg(g), '[]'::jsonb) INTO v_groups
  FROM (
    SELECT r.reason, r.user_id, sum(r.credits) AS credits, sum(r.n)::int AS debits,
      count(r.run_id)::int AS run_count,
      min(r.run_id) AS first_run_id,
      min(r.first_at) AS first_at, max(r.last_at) AS last_at,
      coalesce(jsonb_object_agg(r.run_id, r.credits) FILTER (WHERE r.run_id IS NOT NULL AND r.rank <= 50), '{}'::jsonb) AS runs,
      coalesce(jsonb_agg(DISTINCT r.workspace_id) FILTER (WHERE r.workspace_id IS NOT NULL), '[]'::jsonb) AS workspace_ids
    FROM per_run r
    GROUP BY r.reason, r.user_id
  ) g;

  FOR v_group IN SELECT value FROM jsonb_array_elements(v_groups) LOOP
    v_run_count := (v_group ->> 'run_count')::int;
    v_metadata := jsonb_build_object(
      'aggregated', true,
      'debitCount', (v_group ->> 'debits')::int,
      'runCount', v_run_count,
      'runs', v_group -> 'runs',
      'runsTruncated', v_run_count > 50,
      'workspaceIds', v_group -> 'workspace_ids',
      'firstDebitAt', v_group -> 'first_at',
      'lastDebitAt', v_group -> 'last_at'
    );
    IF v_run_count = 1 THEN
      v_metadata := v_metadata || jsonb_build_object('runId', v_group -> 'first_run_id');
      IF jsonb_array_length(v_group -> 'workspace_ids') = 1 THEN
        v_metadata := v_metadata || jsonb_build_object('workspaceId', v_group -> 'workspace_ids' -> 0);
      END IF;
    END IF;
    PERFORM * FROM debit_org_credits(
      p_org_id,
      (v_group ->> 'credits')::numeric,
      v_group ->> 'user_id',
      v_group ->> 'reason',
      v_metadata
    );
    v_debits := v_debits + (v_group ->> 'debits')::int;
    v_credits := v_credits + (v_group ->> 'credits')::numeric;
  END LOOP;

  RETURN QUERY SELECT v_debits, v_credits;
END;
$$;
--> statement-breakpoint
-- Grants, clawbacks and expiries apply the org's pending debits first, so the
-- pools move in the order the usage happened: a renewal grant pays down usage
-- from the previous period before it resets the allowance. Bodies otherwise
-- unchanged from 0024.
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

  PERFORM * FROM apply_pending_org_debits(p_org_id);

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

  PERFORM * FROM apply_pending_org_debits(g.org_id);

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
CREATE OR REPLACE FUNCTION expire_included_credits(p_org_id text, p_reason text DEFAULT 'included_expired')
RETURNS numeric
LANGUAGE plpgsql AS $$
DECLARE
  v_included numeric;
  v_user text;
BEGIN
  PERFORM * FROM apply_pending_org_debits(p_org_id);
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
