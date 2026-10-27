ALTER TABLE document_page_renders ADD COLUMN quality text NOT NULL DEFAULT 'reader' CHECK (quality IN ('reader', 'export'));
ALTER TABLE document_page_renders DROP CONSTRAINT document_page_renders_pkey;
ALTER TABLE document_page_renders ADD PRIMARY KEY (document_id, run_id, page_number, quality);
