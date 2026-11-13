-- Document asset ledger (docs/extraction/doppler-figures.md, "Asset ledger"). One row per image Doppler reports for a
-- document (extracted, not extracted with the reason, or unlinked), and one extraction-level row per document: how far
-- its text, page facts and images got. Written by the worker in one transaction per figure step
-- (worker/src/db/document-asset-ledger.ts); read by server/src/services/document-assets.ts.
--
-- Tenant scope: org_id and project_id are NOT NULL and tied to the document's own (id, project_id, org_id) by a composite
-- foreign key on documents_projection_scope (migration 0109), so a row can never name a document of another
-- organization or project, and a document without an organization can have no rows. Every value is a validated
-- manifest field from a closed vocabulary or a bounded number; no document-supplied text is stored.
CREATE TABLE IF NOT EXISTS document_assets (
  document_id text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text REFERENCES project_runs(id) ON DELETE SET NULL,
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
  bytes integer CHECK (bytes BETWEEN 1 AND 8388608),
  sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  width integer CHECK (width BETWEEN 1 AND 16384),
  height integer CHECK (height BETWEEN 1 AND 16384),
  repeat_of text CHECK (repeat_of ~ '^p[1-9][0-9]{0,8}\.g?(0|[1-9][0-9]{0,5})$'),
  fallback text CHECK (fallback IN ('svg_allowlist', 'svg_size', 'svg_input', 'other')),
  -- The link as the stored Markdown holds it (manifest v2 `link`: prefix + page-NNNN/(image|figure)-NNN.<format>).
  link_path text CHECK (char_length(link_path) <= 192 AND link_path ~ '^([A-Za-z0-9._~-]+/)*page-[0-9]{4,10}/(image|figure)-[0-9]{3,7}\.(webp|png|svg|jpg)$'),
  -- The image whose stored file shows this one (itself when it owns one).
  file_of text CHECK (file_of ~ '^p[1-9][0-9]{0,8}\.g?(0|[1-9][0-9]{0,5})$'),
  -- Object key of the file this image owns: under the run's tenant-scoped artifact root and this document's folder.
  storage_key text CHECK (char_length(storage_key) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, asset_id),
  CONSTRAINT document_assets_document_scope_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT document_assets_id_page_check CHECK (page_number = substring(asset_id from '^p([0-9]+)\.')::integer),
  CONSTRAINT document_assets_id_kind_check CHECK ((kind = 'vector') = (asset_id LIKE '%.g%')),
  CONSTRAINT document_assets_status_reason_check CHECK ((status = 'not-extracted') = (reason IS NOT NULL)),
  CONSTRAINT document_assets_resumable_reason_check CHECK (NOT resumable OR reason IN ('budget', 'doc_budget', 'timeout', 'deadline', 'aborted')),
  CONSTRAINT document_assets_status_file_check CHECK (CASE WHEN status = 'extracted'
    THEN bytes IS NOT NULL AND sha256 IS NOT NULL AND format IS NOT NULL AND storage_key IS NOT NULL AND file_of = asset_id
    ELSE bytes IS NULL AND sha256 IS NULL AND source IS NULL AND storage_key IS NULL END),
  CONSTRAINT document_assets_status_link_check CHECK (status <> 'unlinked' OR link_path IS NULL),
  CONSTRAINT document_assets_storage_key_scope_check CHECK (storage_key IS NULL
    OR (storage_key LIKE '%/doppler-figures/' || document_id || '/' || asset_id || '.' || format AND storage_key NOT LIKE '%..%'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_assets_org_document_idx ON document_assets (org_id, document_id);
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
  run_id text REFERENCES project_runs(id) ON DELETE SET NULL,
  -- Text: the Markdown (with its final links) is stored.
  markdown_complete boolean NOT NULL DEFAULT false,
  -- Page facts (doppler-page-facts/1): the level computed, or none.
  facts_level text NOT NULL DEFAULT 'none' CHECK (facts_level IN ('none', 'basic', 'full')),
  -- Images: none (not run), complete (exit 0), partial (exit 5, nothing a resume retries), resumable (exit 5, a resume
  -- would retry some), failed (exit 6, a refused folder, or nothing usable), disabled (figures off for the run).
  images_status text NOT NULL DEFAULT 'none' CHECK (images_status IN ('none', 'complete', 'partial', 'resumable', 'failed', 'disabled')),
  images_exit_code smallint CHECK (images_exit_code BETWEEN 0 AND 255),
  manifest_version smallint CHECK (manifest_version IN (1, 2)),
  doppler_build text CHECK (doppler_build ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'),
  -- Manifest v2 binding a resume must repeat (the PDF and the conversion settings).
  source_sha256 text CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  settings_sha256 text CHECK (settings_sha256 ~ '^[0-9a-f]{64}$'),
  resumes integer NOT NULL DEFAULT 0 CHECK (resumes >= 0),
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
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_extraction_levels_document_scope_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT document_extraction_levels_counts_check
    CHECK (assets_total = assets_extracted + assets_not_extracted + assets_unlinked AND assets_resumable <= assets_not_extracted),
  CONSTRAINT document_extraction_levels_status_resumable_check CHECK ((images_status = 'resumable') = (assets_resumable > 0))
);
--> statement-breakpoint
-- The resume worker's queue: documents with images a resume would retry, per organization.
CREATE INDEX IF NOT EXISTS document_extraction_levels_resumable_idx
  ON document_extraction_levels (org_id, updated_at, document_id) WHERE images_status = 'resumable';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_extraction_levels_org_idx ON document_extraction_levels (org_id, project_id);
--> statement-breakpoint
-- Per-page routing facts beside the ingest report's other per-page facts: the text layer (doppler-page-facts
-- `text.textLayer`, or the layout facts' equivalent) and the scan class (`scan`). Two closed enums, no free text.
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
    REVOKE ALL ON public.document_assets, public.document_extraction_levels FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_assets, public.document_extraction_levels TO docslurp_worker;
  END IF;
END $$;
