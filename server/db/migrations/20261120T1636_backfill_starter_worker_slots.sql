-- Bring existing starter organizations on the old default up to the new limit.
UPDATE organizations
SET worker_slots = 128
WHERE funded_at IS NULL AND worker_slots = 50;
