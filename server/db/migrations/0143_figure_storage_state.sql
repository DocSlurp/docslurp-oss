-- Figures that survive every failure (docs/extraction/doppler-figures.md, "Pending and stored files"). Stacked on the
-- asset ledger (0141):
--
-- * document_assets.storage_state: `pending` is written before a file's upload, `stored` once it landed and checked out.
--   Only `stored` rows are served or billed. A pending row whose upload never finished is adopted on the next attempt
--   (its object streamed and hashed against the row) or turned back into a resumable `aborted` image. A crash can leave
--   unbilled orphans, never billed ghosts.
-- * Keys stay exactly Doppler's layout (document_assets_storage_key_scope_check, 0141), so the stored folder is a plain
--   `--images-resume` DIR and the Markdown's relative links resolve. Each figure is created with a conditional write
--   (If-None-Match: *); an object already there is accepted only when its SHA-256 is the row's, never overwritten.
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS storage_state text NOT NULL DEFAULT 'none'
  CHECK (storage_state IN ('none', 'pending', 'stored'));
--> statement-breakpoint
UPDATE document_assets SET storage_state = 'stored' WHERE status = 'extracted' AND storage_state = 'none';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_assets_extracted_storage_check' AND conrelid = 'public.document_assets'::regclass) THEN
    ALTER TABLE document_assets ADD CONSTRAINT document_assets_extracted_storage_check CHECK ((status = 'extracted') = (storage_state <> 'none'));
  END IF;
END $$;
--> statement-breakpoint
-- Pending uploads the next attempt adopts, per document.
CREATE INDEX IF NOT EXISTS document_assets_pending_idx ON document_assets (org_id, document_id) WHERE storage_state = 'pending';
--> statement-breakpoint
-- Whether the level's rows are current: a re-run that skipped the figure step (`none`/`disabled`, council MEDIUM-3) takes
-- the document off the resume queue and stops serving, counting and billing the rows earlier attempts left, without
-- deleting them (the orphan GC or the run's purge does that). Any figure write makes them current again.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS assets_current boolean NOT NULL DEFAULT true;
