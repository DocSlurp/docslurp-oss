-- documents.page_count_source defaults to `assumed`: a page count is `counted` only on evidence (a count taken from the
-- bytes at intake, or the worker's own measurement), so an insert that omits the provenance must not claim one. Every
-- current insert sets it explicitly; this closes the default that 0126 set to `counted`.
--
-- SET DEFAULT changes the catalog only (no rewrite, no scan; existing rows keep their value), but takes ACCESS EXCLUSIVE on
-- documents, which the release's lock prelude already holds in its order (see 0122).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE upload_session_files IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE documents ALTER COLUMN page_count_source SET DEFAULT 'assumed';
