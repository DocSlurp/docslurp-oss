-- debit_org_credits takes the org row with FOR NO KEY UPDATE instead of FOR UPDATE.
-- Every checkpoint in an org debits the same organizations row. FOR UPDATE
-- conflicts with the FOR KEY SHARE lock that every foreign-key check on that
-- row takes, so at 128 slots in one org (2026-10-09 load-test re-run) inserts
-- into audit_log and notification_deliveries queued behind credit debits
-- (85-150 ms mean). Debits still serialize with each other; FK checks no
-- longer wait for them. Body otherwise unchanged from 0024.
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
  -- NO KEY: the debit never changes organizations.id, and FOR UPDATE would also
  -- block every FK check (FOR KEY SHARE) on the org row: audit_log,
  -- notification_deliveries, credit_ledger and other inserts for the org.
  FOR NO KEY UPDATE;

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
