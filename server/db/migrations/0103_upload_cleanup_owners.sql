-- Cleanup ownership survives deletion of operational upload/document records.
CREATE TABLE upload_cleanup_owners (
 original_key text PRIMARY KEY,
 sealed_key text NOT NULL,
 org_id text,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO upload_cleanup_owners (original_key, sealed_key, org_id)
 SELECT q.target, q.payload->>'sealedKey', q.org_id FROM storage_cleanup_queue q
 WHERE q.kind = 'upload_original' AND EXISTS (
   SELECT 1 FROM upload_session_files f JOIN upload_sessions s ON s.id = f.session_id
    WHERE f.source_key = q.payload->>'sealedKey' AND s.org_id = q.org_id
   UNION ALL SELECT 1 FROM documents d
    WHERE d.source_key = q.payload->>'sealedKey' AND d.org_id = q.org_id
 );
