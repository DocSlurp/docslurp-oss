-- Summary tree (packages/shared/src/summary-tree.ts): Postgres side of a per-project derived index of section
-- summaries. The summary text and its vector live only in the project's `summaries` LanceDB table and in run
-- artifacts; these two tables hold no text.
--
-- document_summary_trees: one row per document, the tree's build state. Search serves a document's nodes only while
--   its row is `ready`.
-- document_summary_tree_nodes: one row per node. `id` is the node's row id in the summaries table; `node_hash` keys
--   reuse; `chunk_start`/`chunk_end` are inclusive document_chunks.chunk_index bounds.
--
-- Both cascade from documents (document, project and org deletes), and the worker's purge removes them when a
-- superseded version is archived or purged (DERIVED_TABLES and ARCHIVE_TABLES in worker/src/db/superseded-purge.ts).
-- org_id and project_id are stored on every row so no read needs a join to scope by tenant.
CREATE TABLE IF NOT EXISTS document_summary_trees (
  document_id text PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  project_id text NOT NULL,
  run_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'building', 'partial', 'ready', 'skipped')),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason IN ('format', 'tables', 'short', 'media', 'pii', 'no-leaves')),
  tree_key_version integer NOT NULL DEFAULT 1,
  -- Identity of what the nodes were built with (prompt version, model, generation settings); no secrets.
  config_hash text,
  -- The embedding space whose database holds this document's summary rows.
  embedding_model text,
  dimension integer CHECK (dimension IS NULL OR dimension > 0),
  leaf_count integer NOT NULL DEFAULT 0 CHECK (leaf_count >= 0),
  node_count integer NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  level_count integer NOT NULL DEFAULT 0 CHECK (level_count >= 0),
  root_node_id text,
  error text,
  built_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_summary_trees_project_status_idx ON document_summary_trees (project_id, status);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_summary_tree_nodes (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  project_id text NOT NULL,
  run_id text,
  node_hash text NOT NULL,
  level integer NOT NULL CHECK (level >= 1),
  -- The parent node's id; null for the root and until the level above is built.
  parent_id text,
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  chunk_start integer NOT NULL CHECK (chunk_start >= 0),
  chunk_end integer NOT NULL,
  page_start integer,
  page_end integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (chunk_end >= chunk_start),
  CHECK (page_start IS NULL OR page_end IS NULL OR page_end >= page_start)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_summary_tree_nodes_document_idx ON document_summary_tree_nodes (document_id, level, ordinal);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_summary_tree_nodes_hash_idx ON document_summary_tree_nodes (document_id, node_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_summary_tree_nodes_parent_idx ON document_summary_tree_nodes (parent_id) WHERE parent_id IS NOT NULL;
--> statement-breakpoint
-- The worker builds and purges both tables. server/db/roles.mjs reconciles the same grants after every migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.document_summary_trees FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_summary_trees TO docslurp_worker;
    REVOKE ALL ON public.document_summary_tree_nodes FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_summary_tree_nodes TO docslurp_worker;
  END IF;
END $$;
