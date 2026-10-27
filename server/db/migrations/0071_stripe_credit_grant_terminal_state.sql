-- A void can arrive before the created event or synchronous administrative mirror.
-- Retain terminal state even when no local allocation/customer exists yet.
CREATE TABLE stripe_credit_grant_voids (
  stripe_grant_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION reconcile_stripe_credit_grant(
  p_stripe_grant_id text,
  p_org_id text,
  p_credits numeric,
  p_voided boolean,
  p_metadata jsonb
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_grant credit_grants%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(90104, hashtext(p_stripe_grant_id));
  IF p_voided THEN
    INSERT INTO stripe_credit_grant_voids(stripe_grant_id) VALUES (p_stripe_grant_id)
    ON CONFLICT DO NOTHING;
  END IF;
  IF EXISTS (SELECT 1 FROM stripe_credit_grant_voids WHERE stripe_grant_id = p_stripe_grant_id) THEN
    SELECT * INTO v_grant FROM credit_grants WHERE source = 'promo' AND external_id = p_stripe_grant_id;
    IF FOUND THEN
      PERFORM reverse_credit_grant(v_grant.id, v_grant.credits, 'stripe_credit_grant_voided', p_metadata);
    END IF;
    RETURN 'voided';
  END IF;
  IF p_org_id IS NULL THEN RETURN 'ignored'; END IF;
  PERFORM grant_org_credits(p_org_id, 'promo', p_stripe_grant_id, p_credits, NULL, p_metadata);
  RETURN 'granted';
END;
$$;
