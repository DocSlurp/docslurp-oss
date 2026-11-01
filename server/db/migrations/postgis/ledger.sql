CREATE TABLE IF NOT EXISTS postgis_migration_ledger (
  name text PRIMARY KEY,
  digest text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
