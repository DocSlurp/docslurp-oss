-- Reduce new-account starter grants to 250 credits ($2.50), below Silver
-- monthly credits. Preserve existing grants and the once-per-user claim.
-- Keep in sync with STARTER_CREDITS in packages/shared/src/billing.ts.
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

  INSERT INTO credit_ledger (id, user_id, org_id, pool, delta, reason, metadata)
  VALUES (
    gen_random_uuid()::text,
    NEW.personal_owner_user_id,
    NEW.id,
    'prepaid',
    2.50,
    'new-account-starter-credit',
    jsonb_build_object('orgId', NEW.id, 'source', 'account-onboarding', 'amountCents', 250)
  )
  ON CONFLICT (user_id) WHERE reason = 'new-account-starter-credit' DO NOTHING
  RETURNING id INTO grant_id;

  IF grant_id IS NOT NULL THEN
    INSERT INTO credit_grants (org_id, source, external_id, credits, pool, metadata)
    VALUES (NEW.id, 'starter', NEW.personal_owner_user_id, 250, 'prepaid', jsonb_build_object('ledgerId', grant_id))
    ON CONFLICT (source, external_id) DO NOTHING;
    UPDATE organizations SET credit_balance_cents = credit_balance_cents + 250,
      updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
