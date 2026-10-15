-- Tenant offboarding (org and account deletion). See docs/data-deletion.md.
--
-- Tombstones: organizations.deleted_at and "user".deleted_at. A deleted org or
-- account keeps an anonymized row, so the credit ledger, credit grants, storage
-- meter and usage history it is referenced by stay intact for accounting.
--
-- FK fixes: deleting an org's creator no longer deletes the org (it was ON
-- DELETE CASCADE), and a hard user delete is refused while the user still owns
-- workspaces, runs, documents, usage events or ledger entries, instead of
-- silently cascading into shared org data and billing history.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
-- Set when the purge finished; deleted_at without it is resumed by the maintenance sweep.
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS offboarded_at timestamptz;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ALTER COLUMN created_by_user_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_created_by_user_id_fkey;
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_created_by_user_id_fkey
  FOREIGN KEY (created_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_user_id_fkey;
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE workspace_runs DROP CONSTRAINT IF EXISTS workspace_runs_user_id_fkey;
--> statement-breakpoint
ALTER TABLE workspace_runs ADD CONSTRAINT workspace_runs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_user_id_fkey;
--> statement-breakpoint
ALTER TABLE documents ADD CONSTRAINT documents_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE usage_events DROP CONSTRAINT IF EXISTS usage_events_user_id_fkey;
--> statement-breakpoint
ALTER TABLE usage_events ADD CONSTRAINT usage_events_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_user_id_fkey;
--> statement-breakpoint
ALTER TABLE credit_ledger ADD CONSTRAINT credit_ledger_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE RESTRICT;
