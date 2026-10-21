-- A key's requests-per-minute is now an optional cap below the plan's per-category
-- limits: NULL means the plan's limits apply. Keys left at the old default (60) never
-- chose a cap, so they move to NULL (pre-release; no customer set 60 deliberately).
ALTER TABLE api_keys ALTER COLUMN rate_limit_rpm DROP DEFAULT;
ALTER TABLE api_keys ALTER COLUMN rate_limit_rpm DROP NOT NULL;
UPDATE api_keys SET rate_limit_rpm = NULL WHERE rate_limit_rpm = 60;
-- OAuth MCP grant keys were stored with a fixed 120; they follow the plan too.
UPDATE api_keys SET rate_limit_rpm = NULL WHERE rate_limit_rpm = 120 AND name LIKE 'OAuth: %';
