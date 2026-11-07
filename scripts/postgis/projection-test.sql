-- Minimal ownership fixture; production table changes still come only from migrations.
CREATE TABLE projects(id text PRIMARY KEY, org_id text, pipeline jsonb, archived_at timestamptz);
CREATE TABLE documents(id text PRIMARY KEY,project_id text,org_id text);
CREATE TABLE document_corrections(document_id text, corrected_structured_data jsonb);
