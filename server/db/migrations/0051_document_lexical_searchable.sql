-- Keyword search can serve a document as soon as its chunks are materialized
-- (embed stage), before the index stage registers vectors and flips the
-- document to 'completed'. The worker stamps this after every chunk row of the
-- document is written; search reads it only for in-progress versions with no completed
-- sibling (see server/src/search/eligibility.ts), so replacements still swap
-- in atomically at completion.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS lexical_searchable_at timestamptz;
