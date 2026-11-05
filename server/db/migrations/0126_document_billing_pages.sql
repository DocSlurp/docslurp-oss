-- Pages a document bills, separate from `page_count`.
--
-- `page_count` is the page basis: the pages the extracted text can be split into (form-feed pages for a PDF), which citations,
-- page rows and the page index use. Word, slide, sheet and EPUB files have no form feeds, so the worker's measured count of
-- what the file really holds (LibreOffice pages, slides, text pages) cannot be the page basis. It is recorded here instead and
-- billing (completion page fee, optional features) reads it. Null: the document bills `page_count`.
ALTER TABLE documents ADD COLUMN billing_pages integer CHECK (billing_pages IS NULL OR billing_pages >= 1);
-- How `billing_pages` was found (pdf-conversion, slides, sheet-rows, text-pages, text-rule, size-estimate).
ALTER TABLE documents ADD COLUMN billing_pages_method text;
-- Where intake's `page_count` came from: `counted` (a PDF's own count, the text rule over a text file, an image's one page) or
-- `assumed` (one page for a format only the worker can count). Forecasts price an assumed count from the file's size.
ALTER TABLE documents ADD COLUMN page_count_source text NOT NULL DEFAULT 'counted' CHECK (page_count_source IN ('counted', 'assumed'));
