-- Follow-ups to per-workspace LanceDB databases (0082):
--
-- 1. storage_cleanup_queue kind 'vector_prefix': workspace deletion also purges
--    everything under <LANCEDB_URI>/<orgId>/<workspaceId>/ (tables of models
--    with no vector_indexes row left, empty directories), not only the
--    tables it knows about.
-- 2. vector_index_tables records each table's LanceDB location, so the
--    maintenance sweep no longer needs a surviving vector_index_outbox row
--    to find it (written rows are deleted after a day; relocated and
--    direct-mode tables never had one).
ALTER TABLE storage_cleanup_queue DROP CONSTRAINT IF EXISTS storage_cleanup_queue_kind_check;
--> statement-breakpoint
ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
  CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix'));
--> statement-breakpoint
ALTER TABLE vector_index_tables ADD COLUMN IF NOT EXISTS lance_uri text;
--> statement-breakpoint
ALTER TABLE vector_index_tables ADD COLUMN IF NOT EXISTS lance_table text;
--> statement-breakpoint
UPDATE vector_index_tables t
SET lance_uri = o.lance_uri, lance_table = o.lance_table
FROM (
  SELECT DISTINCT ON (table_key) table_key, lance_uri, lance_table
  FROM vector_index_outbox ORDER BY table_key, id DESC
) o
WHERE o.table_key = t.table_key AND t.lance_uri IS NULL;
