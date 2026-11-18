-- Which model read the page. A project holds a level (a profile, a quality), never a model, so the page index is where
-- "what actually read page 7" has to be answerable later: the model as one llm:// URI (provider, model id and, where
-- the pass knows them, the request settings) and the level that selected it at the time. Null for passes no model
-- served (a text layer, a human correction) and for rows written before this column existed.
--
-- Operator-facing only: the customer view of these records (server document-page-extracts.ts) does not select them.
ALTER TABLE document_page_extracts
  ADD COLUMN IF NOT EXISTS model_uri text CHECK (model_uri IS NULL OR (model_uri ~ '^llm://[a-z0-9][a-z0-9.-]*/' AND length(model_uri) <= 400)),
  ADD COLUMN IF NOT EXISTS model_class text CHECK (model_class IS NULL OR length(model_class) <= 200);
