-- Bounded demand survives API restarts and wakes a cold worker fleet.
create table document_page_renders (
 document_id text not null references documents(id) on delete cascade,
 run_id text not null references workspace_runs(id) on delete cascade,
 page_number integer not null check (page_number > 0),
 org_id text not null references organizations(id) on delete cascade,
 workspace_id text not null references workspaces(id) on delete cascade,
 expires_at timestamptz not null,
 primary key (document_id, run_id, page_number)
);
create index document_page_renders_expiry_idx on document_page_renders(expires_at);
