-- Forward upgrade for installations that already applied 0101.

-- Exact original upload keys, independent of the live run and sealed source.
ALTER TABLE storage_cleanup_queue DROP CONSTRAINT storage_cleanup_queue_kind_check;
ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
 CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix', 'upload_original'));
