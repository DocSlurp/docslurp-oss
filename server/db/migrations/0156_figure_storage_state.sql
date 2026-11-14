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
--> statement-breakpoint
-- Resumable work: images a resume would retry, uploads left pending by a crash (adopted without a VM), and gaps (page
-- ranges no shard returned a manifest for, resumed by a fresh pass over the range). Any of them makes the level
-- `resumable`; a gap a shard now covers is recorded but no longer work, so the check is one-directional for gaps.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS assets_pending integer NOT NULL DEFAULT 0 CHECK (assets_pending >= 0);
--> statement-breakpoint
-- Bytes of the folder's own stored files (manifests, page facts, document.md, index.json), billed with the figures.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS folder_bytes bigint NOT NULL DEFAULT 0 CHECK (folder_bytes >= 0);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_extraction_levels_status_resumable_check' AND conrelid = 'public.document_extraction_levels'::regclass) THEN
    ALTER TABLE document_extraction_levels DROP CONSTRAINT document_extraction_levels_status_resumable_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_extraction_levels_resumable_work_check' AND conrelid = 'public.document_extraction_levels'::regclass) THEN
    ALTER TABLE document_extraction_levels ADD CONSTRAINT document_extraction_levels_resumable_work_check CHECK (
      (images_status = 'resumable' OR (assets_resumable = 0 AND assets_pending = 0))
      AND (images_status <> 'resumable' OR assets_resumable > 0 OR assets_pending > 0 OR coalesce(jsonb_array_length(gaps), 0) > 0));
  END IF;
END $$;
--> statement-breakpoint
-- An earlier run's figure folder (`<root>/doppler/<doc>/`), queued when a newer run's full figure write commits; the
-- drainer re-checks that no ledger row or current level uses it before purging (worker/src/db/superseded-purge.ts).
ALTER TABLE storage_cleanup_queue DROP CONSTRAINT IF EXISTS storage_cleanup_queue_kind_check;
--> statement-breakpoint
ALTER TABLE storage_cleanup_queue ADD CONSTRAINT storage_cleanup_queue_kind_check
  CHECK (kind IN ('storage_prefix', 'vector_table', 'vector_prefix', 'vector_rows', 'upload_original', 'doppler_folder'));
--> statement-breakpoint
-- One index probe per withheld key when the meter subtracts PII-withheld figures (R3-M1), whatever join the planner picks.
CREATE INDEX IF NOT EXISTS document_assets_storage_key_idx ON document_assets (document_id, storage_key) WHERE storage_key IS NOT NULL;
