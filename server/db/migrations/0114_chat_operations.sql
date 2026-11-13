-- Durable chat ownership. Delivery transports never own execution leases.
CREATE TABLE IF NOT EXISTS chat_operations (
  id text PRIMARY KEY,
  root_id text NOT NULL REFERENCES chat_operations(id) ON DELETE CASCADE,
  parent_id text REFERENCES chat_operations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','completed','failed','cancelled','interrupted')),
  attempt_id text,
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  tree_cancel_requested boolean NOT NULL DEFAULT false,
  sequence integer NOT NULL DEFAULT 0,
  output_bytes integer NOT NULL DEFAULT 0,
  snapshot jsonb NOT NULL DEFAULT '{}',
  deadline timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS chat_operations_queue ON chat_operations(status, created_at);
CREATE INDEX IF NOT EXISTS chat_operations_tree ON chat_operations(root_id, created_at);
CREATE TABLE IF NOT EXISTS chat_operation_events (
  operation_id text NOT NULL REFERENCES chat_operations(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (operation_id, sequence)
);
