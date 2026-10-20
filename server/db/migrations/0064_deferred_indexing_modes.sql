alter table documents add column indexing_mode text not null default 'full'
  check (indexing_mode in ('full','map','visual'));
--> statement-breakpoint
create index documents_workspace_deferred_idx on documents (workspace_id) where indexing_mode <> 'full';
--> statement-breakpoint
alter table api_keys add column materialization_policy jsonb not null default '{}'::jsonb;
--> statement-breakpoint
create table document_page_states (
  document_id text not null references documents(id) on delete cascade,
  page_number integer not null check (page_number >= 1),
  page_label text,
  label_source text not null default 'none' check (label_source in ('pdf-page-labels','ocr-calibrated','none')),
  mapped boolean not null default false,
  embedded_at timestamptz,
  embedding_model text,
  state text not null default 'unseen' check (state in ('unseen','claimed','parsed','pii-checked','indexed','failed','blocked-pii')),
  claimed_by_run text,
  claim_expires_at timestamptz,
  materialized_by text check (materialized_by in ('ingest','query','full-index','backfill')),
  cost_credits numeric(12,4) not null default 0,
  failure_reason text,
  attempts integer not null default 0,
  -- Run that billed this page's base fee on demand (null = not billed by a query/backfill materialization).
  fee_billed_run text,
  fee_billed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (document_id, page_number)
);
--> statement-breakpoint
create index document_page_states_doc_state_idx on document_page_states (document_id, state);
--> statement-breakpoint
create table document_maps (
  document_id text primary key references documents(id) on delete cascade,
  run_id text not null,
  version integer not null default 1,
  nodes jsonb not null,
  terms jsonb not null default '[]'::jsonb,
  label_segments jsonb not null default '[]'::jsonb,
  coverage real not null default 0,
  siphon_pages integer not null default 0,
  siphon_decisions jsonb not null default '[]'::jsonb,
  search_text tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
--> statement-breakpoint
create index document_maps_search_idx on document_maps using gin (search_text);
--> statement-breakpoint
create table document_page_vectors (
  document_id text not null references documents(id) on delete cascade,
  page_number integer not null,
  model text not null,
  dims integer not null,
  bits bytea not null,
  int8 bytea not null,
  scale real not null,
  workspace_id text not null,
  org_id text,
  created_at timestamptz not null default now(),
  primary key (document_id, page_number, model)
);
--> statement-breakpoint
create index document_page_vectors_workspace_idx on document_page_vectors (workspace_id, model);
