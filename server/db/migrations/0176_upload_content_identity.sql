-- Client-claimed immutable identity for file re-selection; never checksum evidence.
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS content_identity jsonb;
CREATE OR REPLACE FUNCTION docslurp_upload_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.content_identity IS DISTINCT FROM OLD.content_identity THEN
    RAISE EXCEPTION 'Upload content identity is immutable';
  END IF;
  IF NEW.content_identity IS NOT NULL AND (
    jsonb_typeof(NEW.content_identity) IS DISTINCT FROM 'object'
    OR NEW.content_identity->>'algorithm' IS DISTINCT FROM 'sha256'
    OR COALESCE(NEW.content_identity->>'digest', '') !~ '^[0-9a-f]{64}$'
    OR (NEW.content_identity - 'algorithm' - 'digest') <> '{}'::jsonb
  ) THEN
    RAISE EXCEPTION 'Invalid upload content identity';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER upload_content_identity_guard BEFORE INSERT OR UPDATE ON upload_session_files
FOR EACH ROW EXECUTE FUNCTION docslurp_upload_identity_immutable();
