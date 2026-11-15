-- Unlinked assets cannot alias another asset. Keep historical rows untouched:
-- NOT VALID enforces all future inserts and updates without scanning old data.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.document_assets'::regclass
        AND conname = 'document_assets_unlinked_repeat_check') THEN
    ALTER TABLE public.document_assets
      ADD CONSTRAINT document_assets_unlinked_repeat_check
      CHECK (status <> 'unlinked' OR repeat_of IS NULL) NOT VALID;
  END IF;
END $$;
