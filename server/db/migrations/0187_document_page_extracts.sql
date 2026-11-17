-- Page extract records (docs/extraction/page-extract-records.md): durable, labelled provenance of how each page's text was
-- produced. One row per (document, page, run, pass): the pass that wrote or replaced the page's text in that run, its
-- method, the engine route and serving member, the billed page class, closed-vocabulary tags, bounded quality signals
-- and its timing. `is_final` marks the pass whose text the page was indexed with; a later pass that replaces the text
-- clears it on the earlier row and names itself in `superseded_by_pass`.
--
-- Written by the worker in its checkpoint transaction (worker/src/pipeline/page-extracts.ts: one multi-row statement per
-- checkpoint, pipelined with the rest of the checkpoint, so no extra round trip and no per-page statement); read by
-- server/src/services/document-page-extracts.ts and the ingest report.
--
-- Labels only: no page text, no document-supplied value and no model or vendor id is stored. Every text column is a
-- closed vocabulary or a bounded token checked here; numbers are bounded.
--
-- Tenant scope: org_id and project_id are NOT NULL and tied to the document's own (id, project_id, org_id) by a composite
-- foreign key, and run_id to the run's own (id, project_id, org_id), so a row can never name another organization's
-- document or run. Reads filter by org_id.
--
-- Safe on a live database: a new, empty table; nothing existing is rewritten, locked for long or reshaped.
CREATE TABLE IF NOT EXISTS document_page_extracts (
  document_id text NOT NULL,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  run_id text NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 1 AND 1000000),
  -- The step that wrote the page's text: the primary extractor, OCR of pages without words inside extraction, the
  -- self-critique correction, the vision stage (vision model, OCR in the vision stage, page reader), or a human correction.
  pass text NOT NULL CHECK (pass IN ('extract', 'scan-ocr', 'critique', 'vision', 'human')),
  method text NOT NULL CHECK (method IN ('text-layer', 'ocr', 'ocr-second-read', 'vision', 'correction', 'kept-as-image', 'none')),
  -- The engine route (an extractor id or a route word such as vision-model, page-ocr, gpu-page-reader); never a model id.
  engine text CHECK (engine ~ '^[a-z0-9][a-z0-9._+-]{0,47}$'),
  -- The capability-pool member that served the page, and its region, when one did.
  member_id text CHECK (member_id ~ '^[A-Za-z0-9][A-Za-z0-9._:+-]{0,95}$'),
  region text CHECK (region ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  -- The page class the read was billed in (internal ids: fast = Text, ocr = Scan, rich = Vision), when this pass billed one.
  billed_class text CHECK (billed_class IN ('fast', 'ocr', 'rich')),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 16 AND array_position(tags, NULL) IS NULL AND tags <@ ARRAY[
    'scanned', 'table', 'math', 'garbled-text-layer', 'drawn', 'image-only', 'low-confidence', 'escalation-capped',
    'escalation-unfunded', 'pii-withheld', 'blank', 'yield-deficit', 'ladder-capped', 'failed', 'truncated',
    'rejected']::text[]),
  -- Quality signals: OCR mean confidence or a plausibility score in [0, 1], the page's text size, the reader's finish.
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  plausibility real CHECK (plausibility BETWEEN 0 AND 1),
  text_bytes integer CHECK (text_bytes BETWEEN 0 AND 268435456),
  finish_reason text CHECK (finish_reason IN ('stop', 'length', 'refused', 'error', 'empty', 'other')),
  duration_ms integer CHECK (duration_ms BETWEEN 0 AND 86400000),
  is_final boolean NOT NULL DEFAULT false,
  superseded_by_pass text CHECK (superseded_by_pass IN ('extract', 'scan-ocr', 'critique', 'vision', 'human')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, page_number, run_id, pass),
  -- Named *_document_id_fkey: a checkpoint that hits a document deleted mid-run drops its rows and retries (db/missing-document.ts).
  CONSTRAINT document_page_extracts_document_id_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT document_page_extracts_run_scope_fkey FOREIGN KEY (run_id, project_id, org_id)
    REFERENCES project_runs (id, project_id, org_id) ON DELETE CASCADE,
  CONSTRAINT document_page_extracts_final_check CHECK (NOT (is_final AND superseded_by_pass IS NOT NULL))
);
--> statement-breakpoint
-- Deleting a run cascades through this index; reads go through the primary key (document, page).
CREATE INDEX IF NOT EXISTS document_page_extracts_run_idx ON document_page_extracts (run_id);
--> statement-breakpoint
-- Live roles work at commit (server/db/roles.mjs WORKER_TABLES; reconciliation re-grants the same after migrate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON public.document_page_extracts TO docslurp_worker;
  END IF;
END $$;
