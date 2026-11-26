-- PII page findings (docs/pii-page-withholding.md): for each page the PII stage withheld, which kinds of PII it detected
-- there and how sure the detector is. One row per (document, page, category) of the document's latest scan; page_number
-- is 0 when the finding has no page (an unpaged document's withheld section, or a whole-document block whose matches
-- could not be placed on a page).
--
-- Operator-only. The kinds of PII per page are also recorded on documents.metadata.pii.withheldPageTypes, which tenant
-- responses summarise; the confidence and its basis live only here. No tenant-facing route, serializer, export, MCP tool
-- or SDK type reads this table. It holds no matched text, fragment, offset or count: categories, page numbers and the
-- detector's confidence only.
--
-- confidence: the detector's score in [0, 1]. NULL when the detector produces none: every current detector is rule-based
-- (pattern plus a checksum, structural rule, context window or format check), recorded in `detector` and `validation`
-- rather than as an invented number.
--
-- Written by the worker's PII stage (worker/src/stages/pii-detect.ts setDocumentOutcome): a rescan replaces the
-- document's rows in one statement pair. Rows go with their document (cascade).
--
-- Tenant scope: org_id and project_id are NOT NULL and tied to the document's own (id, project_id, org_id) by a composite
-- foreign key, so a row can never name another organization's document.
--
-- Safe on a live database: a new, empty table; nothing existing is rewritten, locked for long or reshaped.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pii_page_findings (
  document_id text NOT NULL,
  org_id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  page_number integer NOT NULL CHECK (page_number BETWEEN 0 AND 1000000),
  -- A PiiPatternType id (packages/shared/src/pii.ts).
  pattern_type text NOT NULL CHECK (pattern_type ~ '^[a-z][a-z0-9-]{0,47}$'),
  detector text NOT NULL CHECK (detector IN ('rule', 'model')),
  validation text NOT NULL CHECK (validation IN ('checksum', 'structure', 'context', 'format', 'score')),
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, page_number, pattern_type),
  CONSTRAINT pii_page_findings_document_id_fkey FOREIGN KEY (document_id, project_id, org_id)
    REFERENCES documents (id, project_id, org_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT pii_page_findings_score_check CHECK ((detector = 'model') = (confidence IS NOT NULL))
);
--> statement-breakpoint
-- Live roles work at commit (server/db/roles.mjs WORKER_TABLES; reconciliation re-grants the same after migrate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT SELECT, INSERT, DELETE ON public.pii_page_findings TO docslurp_worker;
  END IF;
END $$;
