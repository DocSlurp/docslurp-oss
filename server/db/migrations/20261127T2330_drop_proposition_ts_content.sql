-- document_propositions.ts_content (to_tsvector('english', text), generated) and its GIN indexes are never read: no
-- search path queries propositions by keyword. Every proposition insert still computed the vector and updated the GIN
-- index. Dropping a generated column is a catalog change (no table rewrite) and takes its indexes with it; the brief
-- exclusive lock waits at most lock_timeout rather than queueing behind long proposition writes.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE document_propositions DROP COLUMN IF EXISTS ts_content;
