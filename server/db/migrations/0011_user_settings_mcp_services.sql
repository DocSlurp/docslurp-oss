create table if not exists user_settings (
  user_id text primary key references "user"(id) on delete cascade,
  general jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists mcp_service_connections (
  id text primary key default gen_random_uuid(),
  user_id text not null references "user"(id) on delete cascade,
  name text not null,
  url text not null,
  transport text not null default 'streamable-http',
  auth_type text not null default 'anonymous',
  status text not null default 'connected',
  credentials_encrypted text not null default '',
  config jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_service_connections_transport_check check (transport in ('streamable-http', 'sse')),
  constraint mcp_service_connections_auth_type_check check (auth_type in ('anonymous', 'header-token', 'oauth2.1')),
  constraint mcp_service_connections_status_check check (status in ('connected', 'disabled', 'needs_auth', 'error', 'refreshing')),
  constraint mcp_service_connections_url_check check (url ~* '^https?://')
);

create index if not exists mcp_service_connections_user_id_idx
  on mcp_service_connections (user_id, created_at);

create index if not exists mcp_service_connections_status_idx
  on mcp_service_connections (status);
