-- Permanent request receipts outlive Stripe's idempotency-key retention.
CREATE TABLE admin_credit_requests (
  request_id uuid PRIMARY KEY,
  org_id text NOT NULL,
  actor_user_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 10000),
  reason text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_grant_id text UNIQUE,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
