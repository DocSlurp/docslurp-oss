-- One row per document whose Markdown Doppler wrote (the sandboxed PDF provider, `vm-pdf`, or the local `doppler-md`
-- extractor): where each of that run's Doppler outputs is stored and the key fields Doppler measured, so every Doppler
-- document has an auditable record of what was kept, and why an output is missing. Written by the worker after the
-- extract-markdown checkpoint that commits the Markdown (worker/src/db/doppler-outputs.ts), replaced by each newer run.
--
-- Scope: org_id and project_id are the document's own (composite foreign key), run_id the run's own, exactly like
-- document_extraction_levels. Every stored key is one the writer derived from the run's artifact root and compared exactly
-- (key-mismatch otherwise); the checks below repeat the shape rules as plain text. Values are validated integers, hashes,
-- closed vocabularies and Doppler's own build strings: never document text and never PDF-supplied metadata (no producer,
-- creator, title, /Count or version from the file).
CREATE TABLE IF NOT EXISTS document_doppler_outputs (
  document_id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text,
  -- The extractor id that produced the Markdown (`vm-pdf`, `doppler-md`) and how it reached the document: `vm` (the
  -- document's own job) or `first-pass` (served from the run's batched first pass).
  extractor text NOT NULL CHECK (extractor ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  served_by text NOT NULL CHECK (served_by IN ('vm', 'first-pass')),
  -- Doppler's build: what the provider reported, and the version and commit from Doppler's own facts run line.
  doppler_build text CHECK (doppler_build ~ '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$'),
  doppler_version text CHECK (doppler_version ~ '^[0-9]+(\.[0-9]+){0,3}$'),
  doppler_commit text CHECK (doppler_commit ~ '^[0-9a-f]{7,40}$'),
  -- Doppler's Markdown as uploaded (`<artifact root>/markdown/<document>.<extractor>.md`), its SHA-256 and size.
  markdown_key text NOT NULL,
  markdown_sha256 text NOT NULL CHECK (markdown_sha256 ~ '^[0-9a-f]{64}$'),
  markdown_bytes bigint NOT NULL CHECK (markdown_bytes >= 0),
  -- Page facts (doppler-page-facts/1): `stored` (re-serialized canonical lines at
  -- `<artifact root>/doppler/<document>/images/page-facts.jsonl`), `absent` (the provider returned none), `off`
  -- (DOCSLURP_DOPPLER_PAGE_FACTS=off), `refused` (the strict reader refused them) or `failed` (the write failed).
  page_facts_status text NOT NULL CHECK (page_facts_status IN ('stored', 'absent', 'off', 'refused', 'failed')),
  page_facts_key text,
  page_facts_sha256 text CHECK (page_facts_sha256 ~ '^[0-9a-f]{64}$'),
  page_facts_bytes bigint CHECK (page_facts_bytes >= 0),
  page_facts_pages_known integer CHECK (page_facts_pages_known >= 0),
  page_facts_pages_failed integer CHECK (page_facts_pages_failed >= 0),
  page_facts_lines_dropped integer CHECK (page_facts_lines_dropped >= 0),
  page_facts_complete boolean,
  -- Layout facts the VM returned with the Markdown (`<artifact root>/page-layout-facts/<document>.json`), when stored.
  layout_facts_key text,
  layout_facts_pages integer CHECK (layout_facts_pages >= 0),
  -- Doppler's own run line: pages it emitted and failed, its wall time and peak RSS. Telemetry; never billing.
  engine_pages_emitted integer CHECK (engine_pages_emitted >= 0),
  engine_pages_failed integer CHECK (engine_pages_failed >= 0),
  engine_ms bigint CHECK (engine_ms >= 0),
  engine_peak_rss_kib bigint CHECK (engine_peak_rss_kib >= 0),
  -- Pages whose text the provider's OCR read (billing records them separately; this is the count only).
  ocr_pages integer NOT NULL DEFAULT 0 CHECK (ocr_pages >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_doppler_outputs_document_scope_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT document_doppler_outputs_run_scope_fkey FOREIGN KEY (run_id, project_id, org_id)
    REFERENCES project_runs (id, project_id, org_id) ON DELETE SET NULL (run_id),
  CONSTRAINT document_doppler_outputs_markdown_key_check CHECK (
    char_length(markdown_key) <= 1024 AND position('..' in markdown_key) = 0 AND position('//' in markdown_key) = 0
    AND left(markdown_key, 1) <> '/'
    AND position(('/markdown/' || document_id || '.') in markdown_key) > 0 AND right(markdown_key, 3) = '.md'),
  CONSTRAINT document_doppler_outputs_page_facts_check CHECK (
    ((page_facts_status = 'stored') = (page_facts_key IS NOT NULL))
    AND ((page_facts_key IS NULL) = (page_facts_sha256 IS NULL))
    AND ((page_facts_key IS NULL) = (page_facts_bytes IS NULL))
    AND (page_facts_key IS NULL OR (
      char_length(page_facts_key) <= 1024 AND position('..' in page_facts_key) = 0 AND position('//' in page_facts_key) = 0
      AND left(page_facts_key, 1) <> '/'
      AND right(page_facts_key, char_length('/doppler/' || document_id || '/images/page-facts.jsonl'))
        = '/doppler/' || document_id || '/images/page-facts.jsonl'))),
  CONSTRAINT document_doppler_outputs_layout_key_check CHECK (
    (layout_facts_key IS NULL) = (layout_facts_pages IS NULL)
    AND (layout_facts_key IS NULL OR (
      char_length(layout_facts_key) <= 1024 AND position('..' in layout_facts_key) = 0 AND position('//' in layout_facts_key) = 0
      AND left(layout_facts_key, 1) <> '/'
      AND right(layout_facts_key, char_length('/page-layout-facts/' || document_id || '.json'))
        = '/page-layout-facts/' || document_id || '.json')))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_doppler_outputs_org_idx ON document_doppler_outputs (org_id, project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_doppler_outputs_run_idx ON document_doppler_outputs (run_id) WHERE run_id IS NOT NULL;
