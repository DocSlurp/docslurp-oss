-- Doppler `--scan-pages copy` (its default from Doppler PR #39; docs/extraction/doppler-figures.md, "Asset ledger"): a
-- full-page scan that cannot be copied as its own bytes gets no marker and no file, and its page image comes from the
-- host's page rendering. Doppler reports it as an unlinked image with `reason: scan-not-copyable`, only on a
-- `background` image. Migration 0141 allowed a reason only on a not-extracted image; this lets an unlinked image carry
-- that one reason, and nothing else changes:
--   not-extracted  a reason, never scan-not-copyable;
--   unlinked       no reason, or scan-not-copyable on a background image;
--   extracted      no reason.
-- The same rule as packages/shared dopplerStatusReasonOk (manifest entries and ledger rows).
--
-- Each replaced CHECK allows a superset of what 0141's allowed for every existing row (0141 had no scan-not-copyable
-- value), so the new ones are added NOT VALID: nothing scans the table under the lock, and every later INSERT or UPDATE
-- is still checked. Release N-1 never writes the new value, so it keeps working. Only document_assets is locked.
-- Each step checks the catalog first, so a second run changes nothing.
DO $$
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.document_assets'::regclass
      AND conname = 'document_assets_reason_check' AND pg_get_constraintdef(oid) LIKE '%scan-not-copyable%') THEN
    LOCK TABLE public.document_assets IN ACCESS EXCLUSIVE MODE;
    ALTER TABLE public.document_assets DROP CONSTRAINT IF EXISTS document_assets_reason_check;
    ALTER TABLE public.document_assets ADD CONSTRAINT document_assets_reason_check CHECK (reason IN ('min_side', 'repeat',
      'pages', 'bbox', 'id', 'file_bytes', 'encode', 'scan-pages', 'copy', 'error', 'budget', 'doc_budget', 'timeout',
      'deadline', 'renderer', 'aborted', 'scan-not-copyable', 'other')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.document_assets'::regclass
      AND conname = 'document_assets_status_reason_check' AND pg_get_constraintdef(oid) LIKE '%scan-not-copyable%') THEN
    LOCK TABLE public.document_assets IN ACCESS EXCLUSIVE MODE;
    ALTER TABLE public.document_assets DROP CONSTRAINT IF EXISTS document_assets_status_reason_check;
    ALTER TABLE public.document_assets ADD CONSTRAINT document_assets_status_reason_check CHECK (
      (status = 'not-extracted' AND reason IS NOT NULL AND reason <> 'scan-not-copyable')
      OR (status = 'unlinked' AND (reason IS NULL OR reason = 'scan-not-copyable'))
      OR (status = 'extracted' AND reason IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid = 'public.document_assets'::regclass
      AND conname = 'document_assets_scan_not_copyable_fate_check') THEN
    LOCK TABLE public.document_assets IN ACCESS EXCLUSIVE MODE;
    ALTER TABLE public.document_assets ADD CONSTRAINT document_assets_scan_not_copyable_fate_check
      CHECK (reason IS DISTINCT FROM 'scan-not-copyable' OR fate = 'background') NOT VALID;
  END IF;
END $$;
