-- Keyword search before embedding, served from LanceDB. With DOCSLURP_EARLY_LEXICAL_INDEX=on the embed stage writes a
-- document's chunk rows to its LanceDB table without vectors as soon as the chunks are materialized, and records here
-- which rows those are: `<run id>:<embedding model>:<dimensions>` (lexicalIndexKey in @docslurp/shared). Search serves an
-- in-progress document from LanceDB only while this equals its current run and the embedding space being searched, so a key left
-- by an earlier run or another embedding space is ignored without anyone having to clear it. NULL (every existing
-- row, and every document while the switch is off) keeps today's behaviour. Nullable with no default: no table rewrite.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS lexical_index_key text;
