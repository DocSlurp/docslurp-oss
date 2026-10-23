-- New workspaces expire completed/failed ingestion runs and their documents
-- after 30 days. Preserve every existing workspace's explicit retention choice.
ALTER TABLE workspaces ALTER COLUMN run_retention_days SET DEFAULT 30;
