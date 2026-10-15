-- One $20 starter grant per account, shared by web and API onboarding.
CREATE UNIQUE INDEX credit_ledger_starter_credit_user_idx
  ON credit_ledger (user_id) WHERE reason = 'new-account-starter-credit';
--> statement-breakpoint
CREATE FUNCTION grant_new_account_starter_credit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grant_id text;
BEGIN
  INSERT INTO credit_ledger (id, user_id, delta, reason, metadata)
  VALUES (
    gen_random_uuid()::text,
    NEW.personal_owner_user_id,
    20.00,
    'new-account-starter-credit',
    jsonb_build_object('orgId', NEW.id, 'source', 'account-onboarding', 'amountCents', 2000)
  )
  ON CONFLICT (user_id) WHERE reason = 'new-account-starter-credit' DO NOTHING
  RETURNING id INTO grant_id;

  IF grant_id IS NOT NULL THEN
    UPDATE organizations SET credit_balance_cents = credit_balance_cents + 2000,
      updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER organizations_starter_credit
AFTER INSERT ON organizations
FOR EACH ROW WHEN (NEW.is_personal AND NEW.personal_owner_user_id IS NOT NULL)
EXECUTE FUNCTION grant_new_account_starter_credit();
