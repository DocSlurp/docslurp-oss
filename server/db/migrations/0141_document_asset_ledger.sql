-- Document asset ledger (docs/extraction/doppler-figures.md, "Asset ledger"). One row per image Doppler reports for a
-- document (extracted, not extracted with the reason, or unlinked), and one extraction-level row per document: whether
-- its Markdown is committed and how far its images got. Written by the worker after the stage checkpoint that recorded
-- the Markdown and the image files commits (worker/src/db/document-asset-ledger.ts); read by
-- server/src/services/document-assets.ts.
--
-- Tenant scope: org_id and project_id are NOT NULL and tied to the document's own (id, project_id, org_id) by a composite
-- foreign key on documents_projection_scope (migration 0109), so a row can never name a document of another
-- organization or project, and a document without an organization can have no rows. run_id is tied the same way to the
-- run's own (id, project_id, org_id): a row cannot name another tenant's run. Every value is a validated manifest field
-- from a closed vocabulary or a bounded number; no document-supplied text is stored.
--
-- Object keys follow Doppler's own folder layout under `<artifact root>/doppler/<document>/` (packages/shared
-- DOPPLER_STORE_LAYOUT): the manifest at `images/manifest.json`, each file at `images/page-NNNN/(image|figure)-NNN.<ext>`.

-- The run a ledger row names must belong to the row's own project and organization.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conname = 'project_runs_tenant_scope' AND conrelid = 'public.project_runs'::regclass) THEN
    ALTER TABLE project_runs ADD CONSTRAINT project_runs_tenant_scope UNIQUE (id, project_id, org_id);
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_assets (
  document_id text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text,
  asset_id text NOT NULL CHECK (asset_id ~ '^p[1-9][0-9]{0,8}\.g?(0|[1-9][0-9]{0,5})$'),
  page_number integer NOT NULL CHECK (page_number >= 1),
  kind text NOT NULL CHECK (kind IN ('picture', 'mask', 'vector')),
  fate text NOT NULL CHECK (fate IN ('block', 'inline', 'page-scan', 'background', 'furniture', 'watermark', 'small',
    'duplicate', 'fragment', 'grouped', 'text', 'other')),
  status text NOT NULL CHECK (status IN ('extracted', 'not-extracted', 'unlinked')),
  reason text CHECK (reason IN ('min_side', 'repeat', 'pages', 'bbox', 'id', 'file_bytes', 'encode', 'scan-pages', 'copy',
    'error', 'budget', 'doc_budget', 'timeout', 'deadline', 'renderer', 'aborted', 'other')),
  resumable boolean NOT NULL DEFAULT false,
  source text CHECK (source IN ('copy', 'decode', 'render')),
  format text CHECK (format IN ('webp', 'svg', 'png', 'jpg')),
  -- 8 MiB for a picture or figure (--images-max-file-bytes); 64 MiB for a page scan copied or decoded from the PDF.
  bytes integer CHECK (bytes BETWEEN 1 AND 67108864),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width integer CHECK (width BETWEEN 1 AND 16384),
  height integer CHECK (height BETWEEN 1 AND 16384),
  repeat_of text CHECK (repeat_of ~ '^p[1-9][0-9]{0,8}\.g?(0|[1-9][0-9]{0,5})$'),
  fallback text CHECK (fallback IN ('svg_allowlist', 'svg_size', 'svg_input', 'other')),
  -- The link as the stored Markdown holds it (manifest v2 `link`: prefix + page-NNNN/(image|figure)-NNN.<format>).
  link_path text CHECK (char_length(link_path) <= 192 AND link_path ~ '^([A-Za-z0-9._~-]+/)*page-[0-9]{4,10}/(image|figure)-[0-9]{3,7}\.(webp|png|svg|jpg)$'),
  -- The image whose stored file shows this one (itself when it owns one).
  file_of text CHECK (file_of ~ '^p[1-9][0-9]{0,8}\.g?(0|[1-9][0-9]{0,5})$'),
  -- Object key of the file this image owns: `<artifact root>/doppler/<document>/images/<path derived from the id>`.
  storage_key text CHECK (char_length(storage_key) <= 512),
  -- The image object (manifest v2 `obj`, [num, gen]) and its box (page points, y down): kept for a resume and for
  -- matching repeats across runs.
  obj_num integer CHECK (obj_num >= 0),
  obj_gen integer CHECK (obj_gen BETWEEN 0 AND 65535),
  bbox double precision[] CHECK (bbox IS NULL OR (cardinality(bbox) = 4 AND array_position(bbox, NULL) IS NULL)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, asset_id),
  CONSTRAINT document_assets_document_scope_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  -- A deleted run leaves the row (its run unknown), never the row's tenant columns.
  CONSTRAINT document_assets_run_scope_fkey FOREIGN KEY (run_id, project_id, org_id)
    REFERENCES project_runs (id, project_id, org_id) ON DELETE SET NULL (run_id),
  CONSTRAINT document_assets_id_page_check CHECK (page_number = substring(asset_id from '^p([0-9]+)\.')::integer),
  CONSTRAINT document_assets_id_kind_check CHECK ((kind = 'vector') = (position('.g' in asset_id) > 0)),
  CONSTRAINT document_assets_obj_check CHECK ((obj_num IS NULL) = (obj_gen IS NULL)),
  CONSTRAINT document_assets_status_reason_check CHECK ((status = 'not-extracted') = (reason IS NOT NULL)),
  CONSTRAINT document_assets_resumable_reason_check CHECK (NOT resumable OR reason IN ('budget', 'doc_budget', 'timeout', 'deadline', 'aborted')),
  CONSTRAINT document_assets_status_file_check CHECK (CASE WHEN status = 'extracted'
    THEN bytes IS NOT NULL AND sha256 IS NOT NULL AND format IS NOT NULL AND storage_key IS NOT NULL AND file_of = asset_id
    ELSE bytes IS NULL AND sha256 IS NULL AND source IS NULL AND storage_key IS NULL END),
  CONSTRAINT document_assets_status_link_check CHECK (status <> 'unlinked' OR link_path IS NULL),
  -- Only a page scan is copied or decoded; a decoded scan is re-encoded (never a JPEG); only those may pass 8 MiB.
  CONSTRAINT document_assets_source_fate_check CHECK ((source IS DISTINCT FROM 'copy' AND source IS DISTINCT FROM 'decode') OR fate = 'page-scan'),
  CONSTRAINT document_assets_decode_format_check CHECK (source IS DISTINCT FROM 'decode' OR format <> 'jpg'),
  CONSTRAINT document_assets_file_bytes_check CHECK (bytes IS NULL OR bytes <= 8388608 OR source IN ('copy', 'decode')),
  -- The key ends in this document's folder and the path derived from the id and format, compared as plain text (no
  -- pattern built from column values); the worker also compares the whole key to the document's artifact root.
  CONSTRAINT document_assets_storage_key_scope_check CHECK (storage_key IS NULL OR (
    right(storage_key, char_length('/doppler/' || document_id || '/images/page-'
        || lpad(substring(asset_id from '^p([0-9]+)\.'), greatest(4, char_length(substring(asset_id from '^p([0-9]+)\.'))), '0')
        || (CASE WHEN kind = 'vector' THEN '/figure-' ELSE '/image-' END)
        || lpad(substring(asset_id from '([0-9]+)$'), greatest(3, char_length(substring(asset_id from '([0-9]+)$'))), '0')
        || '.' || format))
      = '/doppler/' || document_id || '/images/page-'
        || lpad(substring(asset_id from '^p([0-9]+)\.'), greatest(4, char_length(substring(asset_id from '^p([0-9]+)\.'))), '0')
        || (CASE WHEN kind = 'vector' THEN '/figure-' ELSE '/image-' END)
        || lpad(substring(asset_id from '([0-9]+)$'), greatest(3, char_length(substring(asset_id from '([0-9]+)$'))), '0')
        || '.' || format
    AND position('..' in storage_key) = 0 AND position('//' in storage_key) = 0 AND left(storage_key, 1) <> '/'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_assets_org_document_idx ON document_assets (org_id, document_id, page_number, asset_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_assets_resumable_idx ON document_assets (org_id, document_id) WHERE resumable;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_assets_run_idx ON document_assets (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
-- A separate table, not columns on documents: every documents UPDATE bumps projection_revision (migration 0109), and the
-- figure step (and a later resume) must not invalidate the document's projections.
CREATE TABLE IF NOT EXISTS document_extraction_levels (
  document_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text,
  -- The Markdown is committed: the checkpoint that recorded the document's markdown slot committed before this row.
  markdown_complete boolean NOT NULL DEFAULT false,
  -- Images: none (no figure step ran for the committed Markdown: another extractor won, or no VM), complete (exit 0),
  -- partial (exit 5, nothing a resume retries), resumable (exit 5, a resume would retry some), failed (exit 6, a refused
  -- folder, or nothing usable), disabled (figures off for the run).
  images_status text NOT NULL DEFAULT 'none' CHECK (images_status IN ('none', 'complete', 'partial', 'resumable', 'failed', 'disabled')),
  images_exit_code smallint CHECK (images_exit_code BETWEEN 0 AND 255),
  manifest_version smallint CHECK (manifest_version IN (1, 2, 3)),
  doppler_build text CHECK (doppler_build ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'),
  -- The stored manifest (`<artifact root>/doppler/<document>/images/manifest.jsonl`, the validated bytes unchanged) and
  -- its SHA-256: with the files, what a resume worker downloads as its DIR.
  manifest_key text CHECK (char_length(manifest_key) <= 512),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  -- Manifest v2 binding a resume must repeat (the PDF and the conversion settings).
  source_sha256 text CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  settings_sha256 text CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  -- Resumes the host itself wrote (previous + 1 per resume write); the manifest's own count is telemetry only. The resume
  -- queue skips a document at its cap (worker DOCUMENT_ASSET_RESUME_CAP).
  resumes integer NOT NULL DEFAULT 0 CHECK (resumes BETWEEN 0 AND 1000),
  last_cut_page integer CHECK (last_cut_page >= 1),
  deadline_ms integer CHECK (deadline_ms >= 0),
  assets_total integer NOT NULL DEFAULT 0 CHECK (assets_total >= 0),
  assets_extracted integer NOT NULL DEFAULT 0 CHECK (assets_extracted >= 0),
  assets_not_extracted integer NOT NULL DEFAULT 0 CHECK (assets_not_extracted >= 0),
  assets_unlinked integer NOT NULL DEFAULT 0 CHECK (assets_unlinked >= 0),
  assets_resumable integer NOT NULL DEFAULT 0 CHECK (assets_resumable >= 0),
  source_copy integer NOT NULL DEFAULT 0 CHECK (source_copy >= 0),
  source_decode integer NOT NULL DEFAULT 0 CHECK (source_decode >= 0),
  source_render integer NOT NULL DEFAULT 0 CHECK (source_render >= 0),
  asset_bytes bigint NOT NULL DEFAULT 0 CHECK (asset_bytes >= 0),
  -- Page ranges the provider did not extract images for, and why: [{first, last, reason}], at most 128, reasons from a
  -- closed set (packages/shared DOPPLER_FIGURE_GAP_REASONS). A page in a gap with no asset rows was not extracted.
  gaps jsonb CHECK (gaps IS NULL OR (jsonb_typeof(gaps) = 'array' AND jsonb_array_length(gaps) <= 128)),
  -- How many shard manifests the document has (document_extraction_shards); 0 for a single manifest.
  shards integer NOT NULL DEFAULT 0 CHECK (shards BETWEEN 0 AND 4096),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_extraction_levels_document_scope_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT document_extraction_levels_run_scope_fkey FOREIGN KEY (run_id, project_id, org_id)
    REFERENCES project_runs (id, project_id, org_id) ON DELETE SET NULL (run_id),
  CONSTRAINT document_extraction_levels_counts_check
    CHECK (assets_total = assets_extracted + assets_not_extracted + assets_unlinked AND assets_resumable <= assets_not_extracted),
  CONSTRAINT document_extraction_levels_status_resumable_check CHECK ((images_status = 'resumable') = (assets_resumable > 0)),
  -- The stored manifest is `images/manifest.jsonl` (version 3) or `images/manifest.json` (versions 1 and 2).
  CONSTRAINT document_extraction_levels_manifest_check CHECK ((manifest_key IS NULL) = (manifest_sha256 IS NULL)
    AND (manifest_key IS NULL OR ((right(manifest_key, char_length('/doppler/' || document_id || '/images/manifest.jsonl'))
        = '/doppler/' || document_id || '/images/manifest.jsonl'
      OR right(manifest_key, char_length('/doppler/' || document_id || '/images/manifest.json'))
        = '/doppler/' || document_id || '/images/manifest.json')
      AND position('..' in manifest_key) = 0 AND position('//' in manifest_key) = 0 AND left(manifest_key, 1) <> '/')))
);
--> statement-breakpoint
-- One row per shard of a sharded document (each shard VM ran Doppler on its own page range with its own manifest,
-- stored at `<artifact root>/doppler/<document>/images/shards/<first>-<last>/manifest.jsonl`). A resume runs per shard, with
-- that shard's manifest and range; the document's images status is the aggregate (complete only if every shard is).
CREATE TABLE IF NOT EXISTS document_extraction_shards (
  document_id text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text,
  first_page integer NOT NULL CHECK (first_page >= 1),
  last_page integer NOT NULL,
  manifest_key text NOT NULL CHECK (char_length(manifest_key) <= 512),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  settings_sha256 text NOT NULL CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  images_status text NOT NULL CHECK (images_status IN ('complete', 'partial', 'resumable')),
  assets_resumable integer NOT NULL DEFAULT 0 CHECK (assets_resumable >= 0),
  -- Resumes the host wrote for this shard (previous + 1); the queue skips a shard at 3.
  resumes integer NOT NULL DEFAULT 0 CHECK (resumes BETWEEN 0 AND 1000),
  last_cut_page integer CHECK (last_cut_page >= 1),
  deadline_ms integer CHECK (deadline_ms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, first_page),
  CONSTRAINT document_extraction_shards_document_scope_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT document_extraction_shards_run_scope_fkey FOREIGN KEY (run_id, project_id, org_id)
    REFERENCES project_runs (id, project_id, org_id) ON DELETE SET NULL (run_id),
  CONSTRAINT document_extraction_shards_range_check CHECK (first_page <= last_page),
  CONSTRAINT document_extraction_shards_status_resumable_check CHECK ((images_status = 'resumable') = (assets_resumable > 0)),
  CONSTRAINT document_extraction_shards_key_scope_check CHECK (
    right(manifest_key, char_length('/doppler/' || document_id || '/images/shards/'
        || lpad(first_page::text, greatest(4, char_length(first_page::text)), '0') || '-'
        || lpad(last_page::text, greatest(4, char_length(last_page::text)), '0') || '/manifest.jsonl'))
      = '/doppler/' || document_id || '/images/shards/'
        || lpad(first_page::text, greatest(4, char_length(first_page::text)), '0') || '-'
        || lpad(last_page::text, greatest(4, char_length(last_page::text)), '0') || '/manifest.jsonl'
    AND position('..' in manifest_key) = 0 AND position('//' in manifest_key) = 0 AND left(manifest_key, 1) <> '/')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_shards_resumable_idx
  ON document_extraction_shards (org_id, updated_at, document_id, first_page) WHERE images_status = 'resumable';
--> statement-breakpoint
-- The resume worker's queue: documents with images a resume would retry, per organization.
CREATE INDEX IF NOT EXISTS document_extraction_levels_resumable_idx
  ON document_extraction_levels (org_id, updated_at, document_id) WHERE images_status = 'resumable';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_levels_org_idx ON document_extraction_levels (org_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_levels_run_idx ON document_extraction_levels (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
-- Per-page routing facts beside the ingest report's other per-page facts, written through the worker's page-facts path
-- whatever the figure setting: the text layer (the VM's layout facts `textLayer`, or doppler-page-facts `text.textLayer`)
-- and the scan class (doppler-page-facts `scan`). Two closed enums, no free text.
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS text_layer text
  CHECK (text_layer IN ('none', 'invisible', 'visible', 'mixed'));
--> statement-breakpoint
ALTER TABLE document_page_facts ADD COLUMN IF NOT EXISTS scan_class text
  CHECK (scan_class IN ('none', 'single', 'tiled', 'layered'));
--> statement-breakpoint
-- Least privilege for the worker at commit (server/db/roles.mjs WORKER_TABLES, reconciled again on deploy): it writes and
-- prunes ledger rows and reads the resume queue. The app role gets DML through default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.document_assets, public.document_extraction_levels, public.document_extraction_shards FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_assets, public.document_extraction_levels, public.document_extraction_shards TO docslurp_worker;
  END IF;
END $$;
