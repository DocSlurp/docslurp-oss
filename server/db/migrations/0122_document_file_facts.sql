-- What the bytes of a document are, sniffed once at intake (packages/shared/src/file-sniff.ts): declared and sniffed MIME
-- type, the canonical type the document is stored under, container, text encoding and the mismatch verdict. Routing, quotes and
-- billing read this record rather than the declared type. Null for documents ingested before it existed.
-- ADD COLUMN takes ACCESS EXCLUSIVE on documents (a metadata-only change, no rewrite) until the migrator's transaction commits, and a
-- queued ACCESS EXCLUSIVE blocks every later reader of documents behind whatever transaction holds it (board reads, worker
-- stage updates). lock_timeout fails the deploy instead of queueing them, as 0063 does; a retried deploy finishes the work.
--
-- Lock prelude of the 0121-0127 release. The migrator applies every pending migration in ONE transaction, and a lock is held
-- until that transaction commits, so the locks of 0122, 0123, 0125, 0126 and 0127 add up. Taken one migration at a time they
-- were acquired in a scattered order (documents in 0122, organizations in 0125, org_memberships last in 0127), and a
-- transaction holding one of the later tables while waiting for an earlier one could deadlock with the migrator. So every
-- lock-taking migration of the release starts with this same prelude: whichever runs first takes all of the release's strong
-- locks, in one canonical order, before changing anything; in the later ones it re-takes locks already held (a no-op).
-- The order follows the application's own (0063's rule: take tables in the order hot transactions do):
--   documents, upload_session_files  the worker's terminal checkpoint updates documents and runs, then reads webhooks
--                                    (enqueueWebhookEvent), so documents comes before webhooks;
--   organizations, org_memberships   organization changes (tenant-offboarding.ts, withOrganizationLock) touch the
--   api_keys, webhooks               organization first, then memberships, then keys, grants and webhooks.
-- An ordered prelude removes deadlocks with transactions that follow this order; it cannot rule out one with a transaction that
-- takes two of these tables the other way round. Postgres detects such a deadlock after deadlock_timeout (1 s) and aborts one
-- side: if that is the migrator, the whole release step rolls back and is retried, and nothing is half-applied.
-- lock_timeout bounds each wait: 10 s, and 3 s for api_keys, which every API request reads.
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
ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_facts jsonb;
