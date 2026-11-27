ALTER TABLE organizations ALTER COLUMN worker_slots SET DEFAULT 128;

-- Restore the starter budget when the last paid grant is reversed.
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
  SET funded_at = NULL, worker_slots = CASE WHEN o.worker_slots = 250 THEN 128 ELSE o.worker_slots END, updated_at = now()
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
