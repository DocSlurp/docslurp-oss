ALTER TABLE mcp_oauth_grants ADD COLUMN api_key_id text;
UPDATE mcp_oauth_grants SET api_key_id=gen_random_uuid()::text;
INSERT INTO api_keys(id,user_id,org_id,key_hash,name,key_type,allowed_domains,scopes,rate_limit_rpm,rate_limit_ppd,revoked_at)
SELECT g.api_key_id,g.user_id,g.org_id,
       encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text,'UTF8')),'hex'),
       'OAuth: ' || c.name,'server',ARRAY[]::text[],ARRAY(SELECT jsonb_array_elements_text(g.scopes)),120,10000,g.revoked_at
FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id=g.client_id;
ALTER TABLE mcp_oauth_grants ALTER COLUMN api_key_id SET NOT NULL;
ALTER TABLE mcp_oauth_grants ADD CONSTRAINT mcp_oauth_grants_api_key_id_fkey FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX mcp_oauth_grants_api_key_id_idx ON mcp_oauth_grants(api_key_id);
