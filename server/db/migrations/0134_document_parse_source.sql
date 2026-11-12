-- Scan what we parse (PR #339, council rounds 6 and 7). For an encrypted PDF, quarantine scans a qpdf-decrypted, normalized
-- copy it makes in the parser VM. Readers resolve an encrypted file's objects differently (a linearized file's first-page
-- cross-reference section against its main one), so every parser must read that scanned copy, never the original.
-- Quarantine stores the copy as a run artifact of the document's own run and records it here; the worker's document loader
-- hands parsers this key (worker/src/lib/parse-source.ts). `source_key` stays the original, used only for "download
-- original" and exports.
--
-- Fail closed (council round 7): quarantine records a decision for every document it accepts, the scan version with or
-- without a copy. A document with no decision from the current scan version (every row written before this migration
-- included) is refused by every parser, the deferred page renderer and materialization until its quarantine re-runs
-- (every reprocess re-runs quarantine).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_source_key text;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_source_sha256 text;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS parse_source_scan_version integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parse_source_pair_check' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parse_source_pair_check
      CHECK ((parse_source_key IS NULL) = (parse_source_sha256 IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_parse_source_decision_check' AND conrelid = 'documents'::regclass) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_parse_source_decision_check
      CHECK (parse_source_key IS NULL OR parse_source_scan_version IS NOT NULL) NOT VALID;
  END IF;
END $$;
