-- What the bytes of a document are, sniffed once at intake (packages/shared/src/file-sniff.ts): declared and sniffed MIME
-- type, the canonical type the document is stored under, container, text encoding and the mismatch verdict. Routing, quotes and
-- billing read this record rather than the declared type. Null for documents ingested before it existed.
-- ADD COLUMN takes ACCESS EXCLUSIVE on documents (a metadata-only change, no rewrite) until the migrator's transaction commits, and a
-- queued ACCESS EXCLUSIVE blocks every later reader of documents behind whatever transaction holds it (board reads, worker
-- stage updates). lock_timeout fails the deploy instead of queueing them, as 0063 does; a retried deploy finishes the work.
-- documents is the only table this migration locks, so there is no lock order to keep.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_facts jsonb;
