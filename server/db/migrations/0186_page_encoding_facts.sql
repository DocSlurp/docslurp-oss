-- Doppler's math and table encoding words per page (doppler-page-facts/1, family `mathtables`): `mathBits` and `tableBits`
-- (one bit per encoding the router tells apart; bit i is the i-th name of Doppler's mathFlags / tableFlags vocabulary,
-- names only appended) and `encodingCounts` (13 four-bit log2 buckets, 52 bits). Written by the worker's routing-facts path
-- beside text_layer and scan_class (worker/src/lib/doppler-encoding-facts.ts decodes them), all three or none; integers
-- the worker validated, never document text. Routing evidence and diagnostics only: never a billing input.
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS math_bits bigint
  CHECK (math_bits IS NULL OR (math_bits >= 0 AND math_bits <= 4294967295));
--> statement-breakpoint
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS table_bits bigint
  CHECK (table_bits IS NULL OR (table_bits >= 0 AND table_bits <= 4294967295));
--> statement-breakpoint
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS encoding_counts bigint
  CHECK (encoding_counts IS NULL OR (encoding_counts >= 0 AND encoding_counts <= 4503599627370495));
--> statement-breakpoint
-- The three words come together: a row has all of them or none. Added NOT VALID (no table scan under the ACCESS
-- EXCLUSIVE lock) and validated separately (a SHARE UPDATE EXCLUSIVE scan that does not block writes).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.document_page_facts'::regclass AND conname = 'document_page_facts_encoding_words_together'
  ) THEN
    ALTER TABLE document_page_facts ADD CONSTRAINT document_page_facts_encoding_words_together
      CHECK ((math_bits IS NULL) = (table_bits IS NULL) AND (math_bits IS NULL) = (encoding_counts IS NULL)) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE document_page_facts VALIDATE CONSTRAINT document_page_facts_encoding_words_together;
