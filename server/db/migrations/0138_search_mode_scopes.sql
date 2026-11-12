-- Search splits into nested modes: search:keyword (keyword matching, no model calls) ⊂ search:hybrid (adds the query
-- embedding and vector search) ⊂ search:deep (adds graph expansion, the hosted reranker and LLM query strategies).
-- The old `search` scope ran everything a project enabled, so keys holding it get search:deep: no key loses access.
-- MCP OAuth grants keep the OAuth scope name `search`; the server maps it to search:deep (services/mcp-oauth.ts).
UPDATE api_keys
SET scopes = ARRAY(SELECT DISTINCT scope FROM unnest(array_replace(scopes, 'search', 'search:deep')) AS scope ORDER BY scope)
WHERE 'search' = ANY(scopes);
--> statement-breakpoint
-- A key holds one search mode. Should a row hold several, keep the narrowest (fail closed).
UPDATE api_keys
SET scopes = array_remove(array_remove(scopes, 'search:deep'), CASE WHEN 'search:keyword' = ANY(scopes) THEN 'search:hybrid' END)
WHERE scopes && ARRAY['search:keyword', 'search:hybrid']::text[] AND 'search:deep' = ANY(scopes);
--> statement-breakpoint
UPDATE api_keys
SET scopes = array_remove(scopes, 'search:hybrid')
WHERE 'search:keyword' = ANY(scopes) AND 'search:hybrid' = ANY(scopes);
--> statement-breakpoint
ALTER TABLE api_keys ALTER COLUMN scopes SET DEFAULT '{"ingest","search:deep","artifacts"}';
--> statement-breakpoint
-- OAuth scopes follow the same names. Grants, pending requests and device codes holding `search` get search:deep;
-- the authorize, device and token endpoints still accept `search` from clients that saved it and map it the same way.
UPDATE mcp_oauth_grants
SET scopes = (SELECT jsonb_agg(DISTINCT CASE WHEN s = 'search' THEN 'search:deep' ELSE s END) FROM jsonb_array_elements_text(scopes) AS s)
WHERE scopes ? 'search';
--> statement-breakpoint
UPDATE mcp_oauth_requests
SET scopes = (SELECT jsonb_agg(DISTINCT CASE WHEN s = 'search' THEN 'search:deep' ELSE s END) FROM jsonb_array_elements_text(scopes) AS s)
WHERE scopes ? 'search';
--> statement-breakpoint
UPDATE mcp_oauth_device_codes
SET scopes = (SELECT jsonb_agg(DISTINCT CASE WHEN s = 'search' THEN 'search:deep' ELSE s END) FROM jsonb_array_elements_text(scopes) AS s)
WHERE scopes ? 'search';
