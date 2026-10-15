-- New accounts start with $25 (2,500 credits) instead of $20; existing grants are
-- unchanged. Keep in sync with STARTER_CREDITS (packages/shared/src/billing.ts).
--
-- Also closes a repeat-grant hole: since 0024 the starter ledger row cascades
-- with its organization, so deleting a personal org and recreating it granted
-- the credit again. Claims now live in their own table keyed by user, which
-- survives org deletion (account deletion removes it with the user, and a new
-- account is a new user id).
CREATE TABLE IF NOT EXISTS starter_credit_claims (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  claimed_at timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO starter_credit_claims (user_id, claimed_at)
SELECT l.user_id, min(l.created_at)
FROM credit_ledger l
JOIN "user" u ON u.id = l.user_id
WHERE l.reason = 'new-account-starter-credit'
GROUP BY l.user_id
ON CONFLICT (user_id) DO NOTHING;
--> statement-breakpoint
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
    25.00,
    'new-account-starter-credit',
    jsonb_build_object('orgId', NEW.id, 'source', 'account-onboarding', 'amountCents', 2500)
  )
  ON CONFLICT (user_id) WHERE reason = 'new-account-starter-credit' DO NOTHING
  RETURNING id INTO grant_id;

  IF grant_id IS NOT NULL THEN
    INSERT INTO credit_grants (org_id, source, external_id, credits, pool, metadata)
    VALUES (NEW.id, 'starter', NEW.personal_owner_user_id, 2500, 'prepaid', jsonb_build_object('ledgerId', grant_id))
    ON CONFLICT (source, external_id) DO NOTHING;
    UPDATE organizations SET credit_balance_cents = credit_balance_cents + 2500,
      updated_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
