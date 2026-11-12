-- Fail closed (PR #339, council rounds 7 and 8). Quarantine records a decision for every document it accepts on the
-- document's own row: the scan version, and the sha256 of the bytes parsers read (the scanned copy's, or the upload's as
-- the scan read it). A document with no decision from the current scan version (every row written before this migration
-- included) is refused by every parser, the deferred page renderer and materialization until its quarantine re-runs
-- (every reprocess re-runs quarantine). See worker/src/lib/parse-source.ts.
--
-- A separate migration from 0134 (council R8-M1): databases that applied 0134 before these columns existed must still get
-- them. Idempotent, so a database that ran an interim 0134 carrying the same statements is unaffected.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_source_scan_version integer;
--> statement-breakpoint
-- Interim pre-release rows only; each becomes unscanned, so the next reprocess re-quarantines it, and none violates the
-- checks below (a NOT VALID check still refuses any later UPDATE of a row that breaks it):
-- * a decision without a scanned-bytes hash (council R8-L1) does not bind parsers to what the scan read;
-- * a copy recorded before decisions carried a scan version (0134 alone) was never a decision.
UPDATE documents SET parse_source_key = NULL, parse_source_sha256 = NULL, parse_source_scan_version = NULL
  WHERE (parse_source_scan_version IS NOT NULL AND (parse_source_sha256 IS NULL OR parse_source_sha256 !~ '^[0-9a-f]{64}$'))
     OR (parse_source_key IS NOT NULL AND parse_source_scan_version IS NULL);
--> statement-breakpoint
DO $$
BEGIN
  -- 0134's pair check (a copy key exactly when a hash) no longer holds: an "original" decision has a hash and no key.
  ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_parse_source_pair_check;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parse_source_copy_check' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parse_source_copy_check
      CHECK (parse_source_key IS NULL OR parse_source_sha256 IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parse_source_decision_check' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parse_source_decision_check
      CHECK (parse_source_key IS NULL OR parse_source_scan_version IS NOT NULL) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parse_source_hash_check' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parse_source_hash_check
      CHECK (parse_source_scan_version IS NULL OR (parse_source_sha256 IS NOT NULL AND parse_source_sha256 ~ '^[0-9a-f]{64}$')) NOT VALID;
  END IF;
END $$;
