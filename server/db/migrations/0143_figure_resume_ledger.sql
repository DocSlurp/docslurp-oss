-- Resumable partial figures (docs/extraction/doppler-figures.md, "Resuming partial figures"). The asset ledger (0141)
-- becomes the only authority for what is served, billed and resumable:
--
-- * document_assets.storage_state: `pending` is written before a file's upload and `stored` once the upload landed and
--   checked out. Only `stored` rows are served or billed; a pending row whose upload never landed is adopted (HEAD plus
--   streamed SHA-256) or turned back into a resumable `aborted` image on the next attempt. A crash can leave unbilled
--   orphans, never billed ghosts.
-- * Content-addressed keys: `.../images/page-NNNN/image-NNN.<first 16 hex of sha256>.<format>`. A replayed upload writes
--   identical bytes to the same key, and a stale writer can never overwrite a committed file.
-- * document_extraction_levels.figures_generation: bumped by every fresh figure pass. A resume compares and sets it, so a
--   reprocess that lands mid-resume turns the resume into a no-op.
-- * gaps: page ranges a shard returned nothing for (at most 128), resumable like a resumable image.
-- * index_bytes, manifest_bytes: the stored index.json and canonical manifest, counted in asset_bytes (recomputed from
--   stored rows in the same transaction as the row changes, never incremented).
ALTER TABLE document_assets ADD COLUMN IF NOT EXISTS storage_state text NOT NULL DEFAULT 'none'
  CHECK (storage_state IN ('none', 'pending', 'stored'));
--> statement-breakpoint
UPDATE document_assets SET storage_state = 'stored' WHERE status = 'extracted' AND storage_state = 'none';
--> statement-breakpoint
-- Old-layout keys (no content hash) cannot satisfy the new key rule; the database is reset before release, and any
-- such row becomes a resumable `aborted` image a resume re-extracts.
UPDATE document_assets SET status = 'not-extracted', reason = 'aborted', resumable = true, storage_state = 'none',
    storage_key = NULL, bytes = NULL, sha256 = NULL, source = NULL, width = NULL, height = NULL
  WHERE status = 'extracted' AND storage_key IS NOT NULL
    AND storage_key !~ '\.[0-9a-f]{16}\.(webp|png|svg|jpg)$';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_assets_extracted_storage_check' AND conrelid = 'public.document_assets'::regclass) THEN
    ALTER TABLE document_assets ADD CONSTRAINT document_assets_extracted_storage_check
      CHECK ((status = 'extracted') = (storage_state <> 'none'));
  END IF;
  -- The key ends in this document's folder, the path derived from the id, the first 16 hex digits of the file's SHA-256
  -- and its format; compared as plain text (no pattern built from column values).
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_assets_storage_key_scope_check' AND conrelid = 'public.document_assets'::regclass)
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_assets_content_key_check' AND conrelid = 'public.document_assets'::regclass) THEN
    ALTER TABLE document_assets DROP CONSTRAINT document_assets_storage_key_scope_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_assets_content_key_check' AND conrelid = 'public.document_assets'::regclass) THEN
    ALTER TABLE document_assets ADD CONSTRAINT document_assets_content_key_check CHECK (storage_key IS NULL OR (
      sha256 IS NOT NULL AND
      right(storage_key, char_length('/doppler/' || document_id || '/images/page-'
          || lpad(substring(asset_id from '^p([0-9]+)\.'), greatest(4, char_length(substring(asset_id from '^p([0-9]+)\.'))), '0')
          || (CASE WHEN kind = 'vector' THEN '/figure-' ELSE '/image-' END)
          || lpad(substring(asset_id from '([0-9]+)$'), greatest(3, char_length(substring(asset_id from '([0-9]+)$'))), '0')
          || '.' || left(sha256, 16) || '.' || format))
        = '/doppler/' || document_id || '/images/page-'
          || lpad(substring(asset_id from '^p([0-9]+)\.'), greatest(4, char_length(substring(asset_id from '^p([0-9]+)\.'))), '0')
          || (CASE WHEN kind = 'vector' THEN '/figure-' ELSE '/image-' END)
          || lpad(substring(asset_id from '([0-9]+)$'), greatest(3, char_length(substring(asset_id from '([0-9]+)$'))), '0')
          || '.' || left(sha256, 16) || '.' || format
      AND position('..' in storage_key) = 0 AND position('//' in storage_key) = 0 AND left(storage_key, 1) <> '/'));
  END IF;
END $$;
--> statement-breakpoint
-- Pending uploads the next attempt adopts, per document.
CREATE INDEX IF NOT EXISTS document_assets_pending_idx ON document_assets (org_id, document_id) WHERE storage_state = 'pending';
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS figures_generation bigint NOT NULL DEFAULT 1
  CHECK (figures_generation >= 1);
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS gaps jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(gaps) = 'array' AND jsonb_array_length(gaps) <= 128);
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS index_bytes bigint NOT NULL DEFAULT 0 CHECK (index_bytes >= 0);
--> statement-breakpoint
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS manifest_bytes bigint NOT NULL DEFAULT 0 CHECK (manifest_bytes >= 0);
--> statement-breakpoint
DO $$
BEGIN
  -- Resumable: an image a resume would retry, or a page range a shard returned nothing for.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_extraction_levels_status_resumable_check' AND conrelid = 'public.document_extraction_levels'::regclass) THEN
    ALTER TABLE document_extraction_levels DROP CONSTRAINT document_extraction_levels_status_resumable_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_extraction_levels_resumable_check' AND conrelid = 'public.document_extraction_levels'::regclass) THEN
    ALTER TABLE document_extraction_levels ADD CONSTRAINT document_extraction_levels_resumable_check
      CHECK ((images_status = 'resumable') = (assets_resumable > 0 OR jsonb_array_length(gaps) > 0));
  END IF;
END $$;
--> statement-breakpoint
-- Per-range deliveries: each validated range (a shard, or a batch a VM streamed out before it finished) is stored and
-- committed on its own, whatever later happens to the Markdown or the run. `ranges` lists the range manifests the ledger
-- holds ({first, last, key, sha256, bytes, complete}), at most 128; the resume of a range starts from its manifest.
ALTER TABLE document_extraction_levels ADD COLUMN IF NOT EXISTS ranges jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(ranges) = 'array' AND jsonb_array_length(ranges) <= 128);
--> statement-breakpoint
DO $$
BEGIN
  -- The level's manifest: the legacy whole-folder names, or a content-addressed range manifest
  -- `images/manifests/<first>-<last>.<sha16>.(jsonl|json)` under this document's folder.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_extraction_levels_manifest_check' AND conrelid = 'public.document_extraction_levels'::regclass) THEN
    ALTER TABLE document_extraction_levels DROP CONSTRAINT document_extraction_levels_manifest_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'document_extraction_levels_range_manifest_check' AND conrelid = 'public.document_extraction_levels'::regclass) THEN
    ALTER TABLE document_extraction_levels ADD CONSTRAINT document_extraction_levels_range_manifest_check CHECK (
      (manifest_key IS NULL) = (manifest_sha256 IS NULL)
      AND (manifest_key IS NULL OR (
        position('/doppler/' || document_id || '/images/' in manifest_key) > 0
        AND substring(manifest_key from position('/doppler/' || document_id || '/images/' in manifest_key)
              + char_length('/doppler/' || document_id || '/images/'))
          ~ '^(manifest\.jsonl?|manifests/[1-9][0-9]{0,8}-[1-9][0-9]{0,8}\.[0-9a-f]{16}\.jsonl?)$'
        AND position('..' in manifest_key) = 0 AND position('//' in manifest_key) = 0 AND left(manifest_key, 1) <> '/')));
  END IF;
END $$;
