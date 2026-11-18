-- A contributing pass for page extract records (docs/extraction/page-extract-records.md): `video-frames`, the vision
-- model's read of a video's sampled frames. Its descriptions are merged into the video's one page, whose transcript
-- (`extract`) stays the page's final record: finalization ranks only the passes that write a page's text, so a
-- `video-frames` row is adopted, names the transcript in superseded_by_pass and is never final. superseded_by_pass keeps
-- its check (it only ever names a final pass).
--
-- Widening the pass check: the wider constraint is added NOT VALID in a catalog-guarded block (existing rows already
-- satisfy it, so nothing is scanned) and the narrower inline check is dropped in the same block. lock_timeout fails the
-- deploy instead of queueing readers behind the brief ACCESS EXCLUSIVE lock each ALTER takes.
--
-- Release N-1 (rollback): its finalization ranks passes by its own list, so a `video-frames` row gets a null rank and
-- its UPDATE would set is_final to NULL (a NOT NULL violation) for every finalization of a video document that has one.
-- The trigger below turns that NULL into false (the row is not final), and fires only when is_final is NULL, so it costs
-- nothing on every other write. A later contract migration may drop it once no running release predates this one.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_page_extracts'::regclass
      AND conname = 'document_page_extracts_pass_vocabulary_check') THEN
    ALTER TABLE document_page_extracts ADD CONSTRAINT document_page_extracts_pass_vocabulary_check
      CHECK (pass IN ('extract', 'scan-ocr', 'critique', 'vision', 'human', 'video-frames')) NOT VALID;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.document_page_extracts'::regclass
      AND conname = 'document_page_extracts_pass_check') THEN
    ALTER TABLE document_page_extracts DROP CONSTRAINT document_page_extracts_pass_check;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION document_page_extracts_final_not_null() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_final := false;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.document_page_extracts'::regclass
      AND tgname = 'document_page_extracts_final_not_null' AND NOT tgisinternal) THEN
    CREATE TRIGGER document_page_extracts_final_not_null BEFORE UPDATE ON document_page_extracts
      FOR EACH ROW WHEN (NEW.is_final IS NULL) EXECUTE FUNCTION document_page_extracts_final_not_null();
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
