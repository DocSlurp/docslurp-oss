ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_tags_tag_document_idx ON document_tags (tag, document_id);
