-- Instance-wide billing state shared by the app and workers. The app sets
-- metering_enforced when Stripe is configured; workers (which never hold the
-- Stripe secret) read it to decide whether compute usage is billed.
CREATE TABLE billing_runtime (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  metering_enforced boolean NOT NULL DEFAULT false,
  stripe_mode text CHECK (stripe_mode IN ('test', 'live')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO billing_runtime (id) VALUES (true);
