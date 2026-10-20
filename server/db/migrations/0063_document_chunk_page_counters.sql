-- Per-document chunk and stored-page counters for search availability.
--
-- Every search computed coverage by counting document_chunks and document_pages
-- rows for all runs in the workspace. document_chunks has no run_id index a
-- workspace can use, so each search seq-scanned the whole table (1.2 GB across
-- tenants in production, 15 s on a cold cache). Triggers keep exact counts on
-- the owning document instead, so availability reads only the workspace's
-- documents rows.
--
-- Statement triggers with transition tables apply one grouped UPDATE per
-- INSERT/DELETE statement, not one per row, so batched chunk writes stay cheap.
-- INSERT ... ON CONFLICT DO UPDATE puts only the rows it really inserted in the
-- INSERT transition table. An upsert can still move a row to another document
-- (a deduplicated embed artifact reuses the first document's chunk ids, and
-- insertChunks sets document_id = excluded.document_id), so a row trigger moves
-- the count when document_id changes; it fires only on that column and only
-- when the value differs. Rows removed by the documents ON DELETE CASCADE
-- update nothing: their document is already gone.
--
-- Lock order keeps production reads flowing. drizzle-kit applies pending
-- migrations in one transaction, and ADD COLUMN takes ACCESS EXCLUSIVE on
-- documents until commit, blocking every read of it. So: first block chunk and
-- page writes (reads continue), count them while documents stays fully
-- available, then take documents only for the column add, the triggers and a
-- grouped UPDATE from the precomputed counts. Taking chunks/pages before
-- documents is also the order a chunk INSERT takes them (its foreign-key check
-- locks documents last), so batched worker inserts cannot deadlock with this.
-- lock_timeout fails the deploy instead of queueing every documents reader
-- behind a lock wait on a long-running transaction.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE document_chunks, document_pages IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE backfill_document_chunk_counts ON COMMIT DROP AS
SELECT document_id, count(*)::int AS n FROM document_chunks GROUP BY document_id;
--> statement-breakpoint
CREATE TEMP TABLE backfill_document_page_counts ON COMMIT DROP AS
SELECT document_id, count(*)::int AS n FROM document_pages GROUP BY document_id;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunk_count integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS stored_page_count integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_chunks_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET chunk_count = d.chunk_count + delta.n
  FROM (SELECT document_id, count(*)::int AS n FROM inserted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_chunks_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET chunk_count = greatest(d.chunk_count - delta.n, 0)
  FROM (SELECT document_id, count(*)::int AS n FROM deleted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_pages_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET stored_page_count = d.stored_page_count + delta.n
  FROM (SELECT document_id, count(*)::int AS n FROM inserted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_pages_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET stored_page_count = greatest(d.stored_page_count - delta.n, 0)
  FROM (SELECT document_id, count(*)::int AS n FROM deleted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_chunks_moved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents SET chunk_count = greatest(chunk_count - 1, 0) WHERE id = OLD.document_id;
  UPDATE documents SET chunk_count = chunk_count + 1 WHERE id = NEW.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_pages_moved() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents SET stored_page_count = greatest(stored_page_count - 1, 0) WHERE id = OLD.document_id;
  UPDATE documents SET stored_page_count = stored_page_count + 1 WHERE id = NEW.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_chunks_count_insert ON document_chunks;
--> statement-breakpoint
CREATE TRIGGER document_chunks_count_insert
AFTER INSERT ON document_chunks
REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION count_document_chunks_inserted();
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_chunks_count_delete ON document_chunks;
--> statement-breakpoint
CREATE TRIGGER document_chunks_count_delete
AFTER DELETE ON document_chunks
REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION count_document_chunks_deleted();
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_pages_count_insert ON document_pages;
--> statement-breakpoint
CREATE TRIGGER document_pages_count_insert
AFTER INSERT ON document_pages
REFERENCING NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION count_document_pages_inserted();
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_pages_count_delete ON document_pages;
--> statement-breakpoint
CREATE TRIGGER document_pages_count_delete
AFTER DELETE ON document_pages
REFERENCING OLD TABLE AS deleted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION count_document_pages_deleted();
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_chunks_count_move ON document_chunks;
--> statement-breakpoint
CREATE TRIGGER document_chunks_count_move
AFTER UPDATE OF document_id ON document_chunks
FOR EACH ROW
WHEN (OLD.document_id IS DISTINCT FROM NEW.document_id)
EXECUTE FUNCTION count_document_chunks_moved();
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_pages_count_move ON document_pages;
--> statement-breakpoint
CREATE TRIGGER document_pages_count_move
AFTER UPDATE OF document_id ON document_pages
FOR EACH ROW
WHEN (OLD.document_id IS DISTINCT FROM NEW.document_id)
EXECUTE FUNCTION count_document_pages_moved();
--> statement-breakpoint
-- Chunk and page writes have been blocked since the counts were taken, so the
-- counts are current and the triggers cover every later write. The full
-- assignment also makes a rerun of this migration exact.
UPDATE documents d
SET chunk_count = coalesce(counts.n, 0)
FROM documents base
LEFT JOIN backfill_document_chunk_counts counts ON counts.document_id = base.id
WHERE d.id = base.id AND d.chunk_count IS DISTINCT FROM coalesce(counts.n, 0);
--> statement-breakpoint
UPDATE documents d
SET stored_page_count = coalesce(counts.n, 0)
FROM documents base
LEFT JOIN backfill_document_page_counts counts ON counts.document_id = base.id
WHERE d.id = base.id AND d.stored_page_count IS DISTINCT FROM coalesce(counts.n, 0);
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
