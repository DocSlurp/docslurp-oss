-- Raise worker slots: Free 2 -> 50, Silver 20 -> 100, Gold 100 -> 250
-- (SERVICE_PLANS in packages/shared/src/billing.ts). 50 is the floor for every
-- org, including past-due orgs held at the free level; orgs on a paid plan's
-- old ceiling move to its new one. Raised custom ceilings are left alone.
ALTER TABLE organizations ALTER COLUMN worker_slots SET DEFAULT 50;
--> statement-breakpoint
UPDATE organizations SET worker_slots = 50, updated_at = now() WHERE worker_slots < 50;
--> statement-breakpoint
UPDATE organizations SET worker_slots = 100, updated_at = now() WHERE plan_id = 'silver' AND worker_slots = 50 AND past_due_since IS NULL;
--> statement-breakpoint
UPDATE organizations SET worker_slots = 250, updated_at = now() WHERE plan_id = 'gold' AND worker_slots = 100;
