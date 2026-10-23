-- Direct-upload completion HEAD-verifies that the object size equals size_bytes
-- before persisting upload_session_files.status='completed'. Session confirmation
-- then stamps its owning organization/workspace. Older intake code dropped that
-- verified size, leaving documents.file_size=0 and sourceSizeMeasured=false.
-- Repair only unmeasured zeroes with an unambiguous, completed/confirmed receipt
-- for the identical source key AND user/org/workspace; never trust an unfinished
-- declaration, cross-owner receipt, conflicting sizes, or overwrite measured data.
WITH verified_uploads AS (
  SELECT f.source_key, s.user_id, s.org_id, s.workspace_id,
    min(f.size_bytes)::bigint AS verified_bytes
  FROM upload_session_files f
  JOIN upload_sessions s ON s.id = f.session_id
  WHERE f.status = 'completed' AND s.status = 'confirmed'
  GROUP BY f.source_key, s.user_id, s.org_id, s.workspace_id
  HAVING min(f.size_bytes) = max(f.size_bytes) AND min(f.size_bytes) > 0
)
UPDATE documents d
SET file_size = v.verified_bytes,
    metadata = jsonb_set(coalesce(d.metadata, '{}'::jsonb), '{sourceSizeMeasured}', 'true'::jsonb, true)
FROM verified_uploads v
WHERE d.source_key = v.source_key
  AND d.user_id = v.user_id AND d.org_id = v.org_id AND d.workspace_id = v.workspace_id
  AND d.file_size = 0
  AND d.metadata ->> 'sourceSizeMeasured' IS DISTINCT FROM 'true'
  AND (d.metadata IS NULL OR jsonb_typeof(d.metadata) = 'object');
-- The existing document corpus-stat trigger updates workspace source_bytes in
-- this same transaction; historical/superseded documents remain outside totals.
