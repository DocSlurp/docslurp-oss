-- Why a direct-upload file was left out of its session's intake, as a code from a closed vocabulary, so clients can tell a
-- file the reconciler rejected from one that never finished uploading (server direct-upload-session.ts
-- DIRECT_UPLOAD_FILE_REJECTION_CODES):
--   too_large, unsupported_type, content_mismatch (the stored bytes are not what was declared), policy_refused (the intake
--   policy check failed), object_missing (no stored object), not_finished (still uploading when the session was confirmed
--   with skipIncomplete).
-- NULL for a file that was not left out, and for rows written before this column.
--
-- And a storage cleanup kind, `upload_skipped`: the stored object of a file a confirmed session left out (aborted or
-- rejected), deleted by the worker after every signed URL for it has expired (worker db/superseded-purge.ts).
--
-- Expand only: one nullable column with no default (a catalog change, no rewrite, no backfill) and a CHECK added NOT VALID
-- (no scan; every existing row is NULL anyway); the cleanup kind CHECK is re-added NOT VALID too (every existing row already
-- satisfies the wider list). The previous release never names the column or the kind, so it keeps working. Idempotent.
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS rejection_code text;
--> statement-breakpoint
DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_session_files_rejection_code_check' AND conrelid = '"upload_session_files"'::regclass) THEN
    ALTER TABLE upload_session_files ADD CONSTRAINT upload_session_files_rejection_code_check
      CHECK (rejection_code IS NULL OR rejection_code IN ('too_large', 'unsupported_type', 'content_mismatch', 'policy_refused', 'object_missing', 'not_finished')) NOT VALID;
  END IF;
END $idem$;
--> statement-breakpoint
DO $idem$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'storage_cleanup_queue_kind_check' AND conrelid = 'storage_cleanup_queue'::regclass
      AND pg_get_constraintdef(oid) LIKE '%''upload_skipped''%'
  ) THEN
    ALTER TABLE storage_cleanup_queue DROP CONSTRAINT IF EXISTS storage_cleanup_queue_kind_check;
    ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
      CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix', 'vector_rows', 'upload_original', 'doppler_folder', 'summary_tree_document', 'upload_skipped')) NOT VALID;
  END IF;
END $idem$;
