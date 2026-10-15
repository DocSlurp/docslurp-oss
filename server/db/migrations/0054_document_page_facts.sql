-- Per-page ingest facts for the ingest report (server/src/services/ingest-report.ts).
-- The worker records cheap source facts at extraction time (plain-text bytes of
-- the PDF text layer, embedded image count) and the vision outcome per page, so
-- the report can explain why a page is or is not searchable. One row per
-- (document, page); rows go with their document. Files processed before this
-- table existed simply have no rows, and the report says so.
CREATE TABLE IF NOT EXISTS document_page_facts (
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  run_id text,
  -- Whitespace-collapsed UTF-8 bytes of the page's native text layer; 0 = no text layer.
  text_bytes integer CHECK (text_bytes IS NULL OR text_bytes >= 0),
  word_count integer CHECK (word_count IS NULL OR word_count >= 0),
  -- Embedded raster images drawn on the page (masks excluded).
  image_count integer CHECK (image_count IS NULL OR image_count >= 0),
  -- Where the facts came from, e.g. 'pdftotext+pdfimages' or 'image-file'.
  facts_source text,
  -- extracted | failed | not-selected | over-cap | cost-cap (null: vision did not consider the page)
  vision_status text,
  vision_text_bytes integer CHECK (vision_text_bytes IS NULL OR vision_text_bytes >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, page_number)
);
