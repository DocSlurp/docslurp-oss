-- Exact indexed-text byte totals without scanning the chunk/page heap on board reads.
-- Match 0063's lock order: precompute while documents reads remain available,
-- then briefly lock documents for columns, trigger replacement and backfill.
-- Chunk/page writes wait during this one-time scan; lock_timeout aborts instead
-- of leaving every documents reader behind a long-running DDL lock.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE document_chunks, document_pages IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TEMP TABLE backfill_document_chunk_bytes ON COMMIT DROP AS
SELECT document_id, sum(octet_length(text))::bigint AS n FROM document_chunks GROUP BY document_id;
--> statement-breakpoint
CREATE TEMP TABLE backfill_document_page_bytes ON COMMIT DROP AS
SELECT document_id, sum(octet_length(text))::bigint AS n FROM document_pages GROUP BY document_id;
--> statement-breakpoint
-- Existing board reads take up to 28s on production's pre-counter schema.
-- Drain those readers before taking the brief DDL/backfill lock; source scans
-- above still run without blocking document reads. Keep a bounded acquisition.
SET LOCAL lock_timeout = '45s';
--> statement-breakpoint
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunk_text_bytes bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS stored_page_text_bytes bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_chunks_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET chunk_count = greatest(d.chunk_count + delta.n, 0),
      chunk_text_bytes = greatest(d.chunk_text_bytes + delta.bytes, 0)
  FROM (SELECT document_id, count(*)::int AS n,
      sum(octet_length(text))::bigint AS bytes FROM inserted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_chunks_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET chunk_count = greatest(d.chunk_count - delta.n, 0),
      chunk_text_bytes = greatest(d.chunk_text_bytes - delta.bytes, 0)
  FROM (SELECT document_id, count(*)::int AS n,
      sum(octet_length(text))::bigint AS bytes FROM deleted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_chunks_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- One delta per document even for batch upserts, text edits and moved rows.
  UPDATE documents d
  SET chunk_count = greatest(d.chunk_count + delta.n, 0),
      chunk_text_bytes = greatest(d.chunk_text_bytes + delta.bytes, 0)
  FROM (
    SELECT document_id, sum(n)::int AS n, sum(bytes)::bigint AS bytes
    FROM (
      SELECT document_id, 1 AS n, octet_length(text)::bigint AS bytes FROM inserted_rows
      UNION ALL
      SELECT document_id, -1 AS n, -octet_length(text)::bigint AS bytes FROM deleted_rows
    ) changes
    GROUP BY document_id
    HAVING sum(n) <> 0 OR sum(bytes) <> 0
  ) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_chunks_count_move ON document_chunks;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_chunks_count_update ON document_chunks;
--> statement-breakpoint
CREATE TRIGGER document_chunks_count_update
AFTER UPDATE ON document_chunks
REFERENCING OLD TABLE AS deleted_rows NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION count_document_chunks_updated();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_pages_inserted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET stored_page_count = greatest(d.stored_page_count + delta.n, 0),
      stored_page_text_bytes = greatest(d.stored_page_text_bytes + delta.bytes, 0)
  FROM (SELECT document_id, count(*)::int AS n,
      sum(octet_length(text))::bigint AS bytes FROM inserted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_pages_deleted() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE documents d
  SET stored_page_count = greatest(d.stored_page_count - delta.n, 0),
      stored_page_text_bytes = greatest(d.stored_page_text_bytes - delta.bytes, 0)
  FROM (SELECT document_id, count(*)::int AS n,
      sum(octet_length(text))::bigint AS bytes FROM deleted_rows GROUP BY document_id) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION count_document_pages_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- One delta per document even for batch upserts, text edits and moved rows.
  UPDATE documents d
  SET stored_page_count = greatest(d.stored_page_count + delta.n, 0),
      stored_page_text_bytes = greatest(d.stored_page_text_bytes + delta.bytes, 0)
  FROM (
    SELECT document_id, sum(n)::int AS n, sum(bytes)::bigint AS bytes
    FROM (
      SELECT document_id, 1 AS n, octet_length(text)::bigint AS bytes FROM inserted_rows
      UNION ALL
      SELECT document_id, -1 AS n, -octet_length(text)::bigint AS bytes FROM deleted_rows
    ) changes
    GROUP BY document_id
    HAVING sum(n) <> 0 OR sum(bytes) <> 0
  ) delta
  WHERE d.id = delta.document_id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_pages_count_move ON document_pages;
--> statement-breakpoint
DROP TRIGGER IF EXISTS document_pages_count_update ON document_pages;
--> statement-breakpoint
CREATE TRIGGER document_pages_count_update
AFTER UPDATE ON document_pages
REFERENCING OLD TABLE AS deleted_rows NEW TABLE AS inserted_rows
FOR EACH STATEMENT
EXECUTE FUNCTION count_document_pages_updated();
--> statement-breakpoint
UPDATE documents d
SET chunk_text_bytes = coalesce(counts.n, 0)
FROM documents base
LEFT JOIN backfill_document_chunk_bytes counts ON counts.document_id = base.id
WHERE d.id = base.id AND d.chunk_text_bytes IS DISTINCT FROM coalesce(counts.n, 0);
--> statement-breakpoint
UPDATE documents d
SET stored_page_text_bytes = coalesce(counts.n, 0)
FROM documents base
LEFT JOIN backfill_document_page_bytes counts ON counts.document_id = base.id
WHERE d.id = base.id AND d.stored_page_text_bytes IS DISTINCT FROM coalesce(counts.n, 0);
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
