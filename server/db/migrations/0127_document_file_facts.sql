-- What the bytes of a document are, sniffed once at intake (packages/shared/src/file-sniff.ts): declared and sniffed MIME
-- type, the canonical type the document is stored under, container, text encoding and the mismatch verdict. Routing, quotes and
-- billing read this record rather than the declared type. Null for documents ingested before it existed.
ALTER TABLE documents ADD COLUMN file_facts jsonb;
