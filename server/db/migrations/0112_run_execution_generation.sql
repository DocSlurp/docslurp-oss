-- Existing histories remain unowned; only newly inserted runs receive a token.
ALTER TABLE workspace_runs ADD COLUMN execution_generation text;
ALTER TABLE workspace_runs ALTER COLUMN execution_generation SET DEFAULT gen_random_uuid()::text;
