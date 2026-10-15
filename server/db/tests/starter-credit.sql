DO $$
DECLARE
  account_id text := gen_random_uuid()::text;
  personal_id text := gen_random_uuid()::text;
  team_id text := gen_random_uuid()::text;
  replacement_id text := gen_random_uuid()::text;
  balance integer;
  grant_count integer;
BEGIN
  INSERT INTO "user" (id, name, email) VALUES (account_id, 'Starter credit test', account_id || '@example.test');
  INSERT INTO organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
    VALUES (personal_id, 'Personal test', true, account_id, account_id);
  SELECT credit_balance_cents INTO balance FROM organizations WHERE id = personal_id;
  IF balance <> 2500 THEN RAISE EXCEPTION 'Expected 2500 starter cents, got %', balance; END IF;
  SELECT count(*) INTO grant_count FROM credit_ledger
    WHERE user_id = account_id AND reason = 'new-account-starter-credit' AND delta = 25.00
      AND metadata->>'orgId' = personal_id;
  IF grant_count <> 1 THEN RAISE EXCEPTION 'Starter grant must have exactly one matching ledger entry'; END IF;

  INSERT INTO organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
    VALUES (gen_random_uuid()::text, 'Repeated onboarding', true, account_id, account_id)
    ON CONFLICT (personal_owner_user_id) DO NOTHING;
  SELECT credit_balance_cents INTO balance FROM organizations WHERE id = personal_id;
  IF balance <> 2500 THEN RAISE EXCEPTION 'Repeated onboarding changed starter balance'; END IF;

  INSERT INTO organizations (id, name, is_personal, created_by_user_id)
    VALUES (team_id, 'Team test', false, account_id);
  SELECT credit_balance_cents INTO balance FROM organizations WHERE id = team_id;
  IF balance <> 0 THEN RAISE EXCEPTION 'Additional organizations must not receive another grant'; END IF;

  DELETE FROM organizations WHERE id = personal_id;
  INSERT INTO organizations (id, name, is_personal, personal_owner_user_id, created_by_user_id)
    VALUES (replacement_id, 'Replacement test', true, account_id, account_id);
  SELECT credit_balance_cents INTO balance FROM organizations WHERE id = replacement_id;
  -- The original ledger row cascades with its org; the claim (keyed by user) survives.
  SELECT count(*) INTO grant_count FROM starter_credit_claims WHERE user_id = account_id;
  IF balance <> 0 OR grant_count <> 1 THEN RAISE EXCEPTION 'Recreating a personal organization must not duplicate starter credit (balance %, claims %)', balance, grant_count; END IF;
  SELECT count(*) INTO grant_count FROM credit_ledger WHERE user_id = account_id AND reason = 'new-account-starter-credit';
  IF grant_count <> 0 THEN RAISE EXCEPTION 'Recreation must not write a new starter ledger entry'; END IF;
END;
$$;
