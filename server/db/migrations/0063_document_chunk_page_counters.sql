-- Per-document chunk and stored-page counters for search availability.
--
-- Every search computed coverage by counting document_chunks and document_pages
-- rows for all runs in the workspace. document_chunks has no run_id index a
-- workspace can use, so each search seq-scanned the whole table (1.2 GB across
-- tenants in production, 15 s on a cold cache). Statement-level triggers keep
-- exact counts on the owning document instead, so availability reads only the
-- workspace's documents rows.
--
-- Statement triggers with transition tables apply one grouped UPDATE per
-- INSERT/DELETE statement, not one per row, so batched chunk writes stay cheap.
-- Chunks and pages never move between documents (upserts keep document_id),
-- so UPDATE needs no trigger. Rows removed by the documents ON DELETE CASCADE
-- update nothing: their document is already gone.
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
-- Backfill after the triggers exist, in the same transaction: CREATE TRIGGER
-- holds a lock that blocks concurrent chunk/page writes until commit, so no
-- write lands between the count and the trigger.
UPDATE documents d
SET chunk_count = counts.n
FROM (SELECT document_id, count(*)::int AS n FROM document_chunks GROUP BY document_id) counts
WHERE d.id = counts.document_id AND d.chunk_count <> counts.n;
--> statement-breakpoint
UPDATE documents d
SET stored_page_count = counts.n
FROM (SELECT document_id, count(*)::int AS n FROM document_pages GROUP BY document_id) counts
WHERE d.id = counts.document_id AND d.stored_page_count <> counts.n;
