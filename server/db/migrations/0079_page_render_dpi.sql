-- A policy upgrade must not share demand ownership with an older 120-DPI job.
ALTER TABLE document_page_renders ADD COLUMN IF NOT EXISTS dpi smallint NOT NULL DEFAULT 120 CHECK (dpi IN (120, 250));
ALTER TABLE document_page_renders DROP CONSTRAINT IF EXISTS document_page_renders_pkey;
ALTER TABLE document_page_renders ADD CONSTRAINT document_page_renders_pkey PRIMARY KEY (document_id, run_id, page_number, quality, dpi);
