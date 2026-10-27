-- `chat` splits answer generation (a model call on the owner's credits) out of
-- `search`. Keys and MCP OAuth grants that could chat through `search` keep that
-- access explicitly; new client keys are search-only until chat is granted.
UPDATE api_keys
SET scopes = array_append(scopes, 'chat')
WHERE 'search' = ANY(scopes) AND NOT ('chat' = ANY(scopes));
--> statement-breakpoint
UPDATE mcp_oauth_grants
SET scopes = scopes || '["chat"]'::jsonb
WHERE scopes ? 'search' AND NOT (scopes ? 'chat');
--> statement-breakpoint
UPDATE mcp_oauth_requests
SET scopes = scopes || '["chat"]'::jsonb
WHERE scopes ? 'search' AND NOT (scopes ? 'chat');
