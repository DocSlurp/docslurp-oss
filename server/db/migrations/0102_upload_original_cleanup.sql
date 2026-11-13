-- Forward upgrade for installations that already applied 0101.

-- Exact original upload keys, independent of the live run and sealed source.
ALTER TABLE storage_cleanup_queue DROP CONSTRAINT IF EXISTS storage_cleanup_queue_kind_check;
DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_cleanup_queue_kind_check' AND conrelid = 'storage_cleanup_queue'::regclass) THEN
    ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
 CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix', 'upload_original'));
  END IF;
END $idem$;
