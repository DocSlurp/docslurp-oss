ALTER TABLE upload_sessions ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX document_tags_tag_document_idx ON document_tags (tag, document_id);
