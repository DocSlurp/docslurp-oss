-- Let the vision attempt ledger count encoding reads. A page that classify-route authorizes for a model read by Doppler's math
-- and table encoding facts alone (math only a read recovers, tables drawn as glyph outlines) is admitted with purpose
-- `encoding-read` and a per-document page budget (encodingReadPageCap), counted from these rows so activity retries,
-- worker restarts and re-routed facts that nominate other pages cannot widen it (worker/src/lib/vision-attempt-guard.ts).
--
-- As 0133: the new CHECK is added NOT VALID (every existing row satisfies it; the old CHECK allowed a subset), and only
-- vision_run_attempts is locked.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE vision_run_attempts IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE vision_run_attempts DROP CONSTRAINT IF EXISTS vision_run_attempts_purpose_check;
--> statement-breakpoint
ALTER TABLE vision_run_attempts ADD CONSTRAINT vision_run_attempts_purpose_check
  CHECK (purpose IN ('page', 'region', 'map-ocr', 'critique', 'ocr', 'table-rescue', 'encoding-read')) NOT VALID;
