-- New-account starter grant: 100 credits ($1), down from 250. Existing grants and the once-per-user claim stay as
-- they are. Keep in sync with the pricing provider's plans.starterCredits (OPEN_STARTER_CREDITS in
-- packages/shared/src/pricing-open.ts for the open default).
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
    1.00,
    'new-account-starter-credit',
    jsonb_build_object('orgId', NEW.id, 'source', 'account-onboarding', 'amountCents', 100)
  )
  ON CONFLICT (user_id) WHERE reason = 'new-account-starter-credit' DO NOTHING
  RETURNING id INTO grant_id;

  IF grant_id IS NOT NULL THEN
    INSERT INTO credit_grants (org_id, source, external_id, credits, metadata)
    VALUES (NEW.id, 'starter', NEW.personal_owner_user_id, 100, jsonb_build_object('ledgerId', grant_id))
    ON CONFLICT (source, external_id) DO NOTHING;
    UPDATE organizations SET credit_balance_cents = credit_balance_cents + 100,
      updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
