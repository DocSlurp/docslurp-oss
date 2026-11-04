# Rollout: migrations 0121-0125 (expand now, contract later)

The Fly release path migrates first, then rolls workers, then the app (`scripts/fly-migrate.mjs` in the app repo;
[releases.md](releases.md)). For a few minutes release N-1 workers and app machines run against the new schema, and a
rollback runs N-1 against it for longer. These migrations are written for that overlap: additive, short locks, nothing
deleted. The one-way steps are listed under [Contract step](#contract-step-a-later-release).

| Migration | Change | Lock taken | Needs a follow-up |
| --- | --- | --- | --- |
| 0121 | Defines `docslurp_fold_text()` only | none on tables | Build the folded index (below) |
| 0122 | `documents.file_facts jsonb` | `documents` ACCESS EXCLUSIVE, metadata only, `lock_timeout` 10 s | no |
| 0123 | `upload_session_files.request_index`, `client_id` | `upload_session_files` ACCESS EXCLUSIVE, metadata only, `lock_timeout` 10 s | no |
| 0124 | `docslurp_workspace_access()` | none | no |
| 0125 | `webhooks.org_id` / `workspace_id` (nullable) with a backfill and an insert trigger; `api_keys` without an org revoked, plus a `NOT VALID` check | `organizations`, `workspaces` SHARE ROW EXCLUSIVE, then `webhooks` ACCESS EXCLUSIVE (10 s); `api_keys` (3 s) | contract step |

A migration that cannot get its lock within `lock_timeout` fails the release step instead of queueing every reader of
a hot table behind a long transaction. Re-run the release after the blocking transaction ends. Lock order follows
0063: `organizations`, `workspaces`, then `webhooks`, the order a worker transaction takes them, so the two cannot deadlock.

## Order

1. **Before**: `DATABASE_URL=<direct url> node server/db/predeploy-check.mjs --strict` (in the app image:
   `fly ssh console -C "node /app/core/server/db/predeploy-check.mjs --strict"`). It is read-only. Fix every
   `BLOCKER`; read every `WARN`. It reports `document_chunks` rows and size, `api_keys` and `webhooks` without an
   organization and where they could be homed, stored pipelines whose `piiPolicy.patterns` the new build rejects
   (the old build accepted any string and scanned for nothing), completed stage states with no artifact, runs in flight by
   routing pin, and transactions older than 30 s that would make a migration lock wait fail.
2. **Migrate** (`scripts/fly-migrate.mjs`). Takes seconds. Nothing rewrites a table.
3. **Build the folded index**, once, while traffic flows: `node server/db/folded-search-index.mjs`
   (`--status` to look, `--dry-run` to see what it would do). It runs `CREATE INDEX CONCURRENTLY` on
   `to_tsvector('simple', docslurp_fold_text(text))`, which blocks neither reads nor writes. It is idempotent, drops and rebuilds
   an INVALID leftover, keeps a build advisory lock, and retries on `lock_timeout`
   (`FOLDED_INDEX_LOCK_TIMEOUT_MS`, `FOLDED_INDEX_ATTEMPTS`, `FOLDED_INDEX_MAINTENANCE_WORK_MEM`). Measured on a throwaway
   postgres:17: 200k rows of ~2 KB text took 159 s while inserts into the table continued (worst insert 250 ms including
   `docker exec`), where the stored generated column it replaced held ACCESS EXCLUSIVE for 221 s plus 81 s of index build.
   Until the index exists keyword search still works: the folded leg (non-ASCII queries and English-empty fallbacks) scans the
   workspace's chunks under `SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS` (default 2000 ms) and contributes nothing when cut off;
   the English leg is unaffected. The query is cached for 5 minutes once the index is valid and 30 s while it is missing.
4. **Workers**, then the **app**, as usual. Watch SigNoz (below).

Order matters in one place: the index build is after the migration, never inside it. `CREATE INDEX CONCURRENTLY` cannot run
in the migrator's transaction, and the migrator applies every pending migration in one.

## Mixed-version behaviour

- **Routing pin.** Evidence routing pins `v3` in `run:vision-routing-version`. The previous release pinned `v2` for its keyword
  canary, so reusing `v2` would let an old worker route a new run with the old rules. An old worker does not know `v3`
  and routes as `v1` with a warning; this release reads any pin other than `v3` (including `v2`) as `v1`. A run in flight across
  the deploy keeps one set of rules per stage; none is widened.
- **Webhooks.** Release N-1 inserts webhooks without `org_id`. The `webhooks_default_org` trigger homes such a row with the
  backfill's rule (the organization of the runs the webhook itself delivered for, among its creator's organizations, else their
  personal organization, else one they own or administer) so new code matches it. A webhook that cannot be homed keeps a NULL
  `org_id`: new code ignores it, N-1 still delivers it by `user_id`. Before this change a webhook fired for every run its creator
  started; now it fires for the organization it is homed to. Users with runs in several organizations (the pre-deploy report counts
  them) need one webhook per organization.
- **API keys.** Every insert path in the deployed code sets `org_id`: `createApiKey` and `rotateApiKey` (`api-keys.ts`) and `createGrant`
  (`mcp-oauth.ts`); the app repository inserts none. Keys without an org were already refused by `validateApiKey`. 0125 revokes them,
  re-homes them only to their owner's personal organization and deletes nothing; `api_keys_org_id_required` (`CHECK (org_id IS NOT NULL OR
  revoked_at IS NOT NULL) NOT VALID`) refuses new live ones and lets updates of the dead rows keep working.

## Contract step (a later release)

Ship it only after every machine runs the new release, a rollback to N-1 is no longer wanted, and the pre-deploy report shows no
live NULL-org rows. It is destructive, so it carries the `-- destructive-migration:` marker (`scripts/check-migration-safety.mjs`).

```sql
-- destructive-migration: contract step of 0125; no running release inserts api_keys or webhooks without org_id.
SET LOCAL lock_timeout = '10s';
-- Back up what cannot be homed before deleting it. The api_keys copy holds key hashes: add both tables to WORKER_DENIED_TABLES
-- in server/db/roles.mjs (db-roles.test.ts fails otherwise) and drop them once nobody needs the rows.
CREATE TABLE IF NOT EXISTS webhooks_unhomed_backup AS SELECT *, now() AS backed_up_at FROM webhooks WHERE org_id IS NULL;
CREATE TABLE IF NOT EXISTS api_keys_unhomed_backup AS SELECT *, now() AS backed_up_at FROM api_keys WHERE org_id IS NULL;
DELETE FROM webhooks WHERE org_id IS NULL;
DELETE FROM api_keys WHERE org_id IS NULL;
-- api_keys is small; SET NOT NULL scans it under ACCESS EXCLUSIVE, so keep the short lock_timeout and run it off-peak.
ALTER TABLE api_keys ALTER COLUMN org_id SET NOT NULL;
ALTER TABLE api_keys DROP CONSTRAINT api_keys_org_id_required;
DROP TRIGGER webhooks_default_org ON webhooks;
ALTER TABLE webhooks ALTER COLUMN org_id SET NOT NULL;
DROP FUNCTION docslurp_webhooks_default_org();
DROP FUNCTION docslurp_webhook_home_org(text, text);
```

Also in that release: `webhooks.orgId` in `server/db/schema.ts` and `WebhookRow.org_id` return to non-null, and the `webhooks` DTO stops
being able to carry a NULL organization. Before the contract step, `listWebhooks` can return `orgId: null` for an unhomed legacy row.

## What to watch in SigNoz

During the migration and the first hour of workers:

- **Migration**: `[migrate] complete in ...ms` from the release machine; a `55P03` / `lock timeout` failure means a long transaction
  blocked it, so retry once `pg_stat_activity` is quiet (the pre-deploy report lists them).
- **Index build**: `[folded-index] built ... in ...ms`; `pg_stat_progress_create_index` while it runs. Inserts into `document_chunks`
  (worker `embed`/`index` stage latency) should not move.
- **Keyword search**: `foldedUnindexedTimeout` in search timings and `[search] folded keyword leg cut off` log lines mean the index is
  not built yet; they stop once it is valid. Compare lexical branch latency and `lexicalTimeout` before and after.
- **Routing**: `[classify-route] ... routing=v3 pages= measured= read= reasons={...} blank= repeatedImagePages= textLayer={...} ocrChecked=`
  per document, with the same fields in the `classify-route` stage stats (`intakePages` vs `measuredPages`, `pagesRead`,
  `pagesReadByReason`, `blankPages`, `repeatedImagePages`, `textLayerVerdicts`, `textLayerOcrChecked`, `textLayerOcrDisagrees`), and
  `selectedPageCount` / `failedPageCount` / `documentPages` in `vision-extract`. A large gap between `measuredPages` and `intakePages`, or
  `[vision-routing] ... routing as v1` warnings after the old workers drain, needs a look.
- **Fail-closed readers**: `ArtifactReadError` (retried by the stage) is the signal for a recorded artifact that cannot be read; a rise
  after the deploy is the readers refusing to answer from the raw source.
- **Webhooks**: `webhook_outbox` rows dispatched per run; a team whose webhook stopped firing is one the pre-deploy report listed
  (multiple organizations, or unhomed).
