# Data deletion and tenant offboarding

How DocSlurp deletes documents, runs, projects, organizations and accounts,
what it keeps, and how long each step takes.

## The contract

Postgres rows are deleted immediately. Everything outside Postgres, meaning
LanceDB rows, object-storage artifacts and raw uploads, is deleted
asynchronously by the worker cleanup sweep.

Callers never enqueue cleanup themselves. Two `BEFORE DELETE` triggers
(migration `0035_data_lifecycle_cleanup.sql`) record what must be removed
before FK cascades destroy the rows that describe it:

| Trigger | Queue | What it records |
| --- | --- | --- |
| `documents_enqueue_cleanup` | `document_cleanup_queue` (one row per document) | LanceDB targets (from `vector_indexes` and `vector_index_outbox`), stage artifact URIs, the raw source key, knowledge-graph node ids. It also drops the document's pending vector writes. |
| `project_runs_enqueue_storage_cleanup` | `storage_cleanup_queue` (`storage_prefix`) | The run's storage prefix `<userId>/<runId>/` for each uploader, plus run-level artifact URIs. |

Because the triggers run inside Postgres, every delete path is covered: single
and bulk document delete, project delete, run retention, discarded intake,
org and account deletion, and a manual `delete` in psql.

Extracts (see [extract.md](extract.md)) write everything under
`extracts/<org>/<extract>/` instead of `<userId>/<runId>/`. Their `extracts`
row is a durable expiry record with no foreign keys, so it survives project,
run and account deletion. The API's maintenance sweep deletes an expired
extract's documents and runs, which fires the triggers above, and then empties
its prefix. Deleting a project expires its extracts at once.

Every project has its own LanceDB database per embedding space
(`<LANCEDB_URI>/<orgId>/<projectId>/vectors-<model>-<dimensions>`). Project
deletion (`deleteProjectData`, which organization deletion also runs for each
project) queues `vector_table` entries for them first, so they are dropped
whole instead of being deleted one document at a time, then a `vector_prefix`
entry that removes everything left under `<LANCEDB_URI>/<orgId>/<projectId>/`
(tables of models no document indexes any more, the directories). A local root
is removed directly; an object-storage root must live in the artifact bucket,
otherwise only the known tables are dropped and the sweep logs a warning. While documents are
still in flight the drop waits out the same 15-minute grace as their cleanup.

Org-level tables from before per-project databases are deleted by the
relocation CLI's `--drop-legacy` step (see [operations](self-host/operations.md#moving-to-per-project-lancedb-databases-migration-0082));
cleanup rows queued for them before migration 0082 drop them by their legacy
names.

A dedup copy shares its source's LanceDB rows only inside the source's
project. A copy in another project has its own rows, so deleting the source
removes the source's rows even while that copy lives; the shared storage
artifacts stay until the last copy is gone.

## The sweep

The worker leader runs the sweep every 30 s (`purgeSupersededDocuments` in
`worker/src/db/store.ts`):

1. Superseded versions whose 60 s grace has passed.
2. `document_cleanup_queue`, claimed in batches of 200 with `FOR UPDATE SKIP
   LOCKED`. Each batch issues one LanceDB delete per table
   (`"documentId" IN (...)`) and one storage listing per surviving run prefix.
   It deletes a raw source only when no remaining document references it, and
   it skips tables that are queued for a whole drop.
3. `storage_cleanup_queue`: it lists and deletes every key under each run
   prefix and drops queued LanceDB tables. A prefix must have exactly two
   segments (`user/run/`). Wider prefixes are refused.

### What a LanceDB delete removes, and when

A LanceDB delete hides rows at once (a deletion vector), but their bytes stay
in the table's files until maintenance rewrites them:

1. After each cleanup transaction the sweep sets
   `vector_index_tables.history_prune_due_at` for every table it deleted rows
   from, to the version-retention window (10 minutes by default) plus one
   minute. The maintenance sweep then runs a pass on that table even if nobody
   writes to it again. Before migration 0162 a table with no later writes kept
   deleted rows in its older versions indefinitely. A table the write queue
   never registered (direct writes) is registered by the delete.
2. That pass prunes the versions from before the delete. While a table is
   marked, any pass that compacted, due or write-triggered, re-arms the prune:
   the fragments it replaced are still referenced by the version it compacted
   from, and a later pass after retention removes them. A pass that compacted
   nothing settles the prune if it started after the due time. A table that no
   longer exists drops its mark.
3. An expired extract uses the strict path instead (`purgeHistory`): two
   passes with zero retention, in the cleanup itself, and the cleanup row
   stays queued until they succeed.

The scheduled pass also runs in inline maintenance mode and with direct
writes, where maintenance otherwise only follows writes. It does not run when
maintenance is switched off (`maintenance=off`).

**Known limits.**

- Compaction rewrites a fragment only when more than 10% of its rows are
  deleted, and `@lancedb/lancedb` 0.41 does not expose that threshold. When a
  deleted document is a small share of a large fragment, its rows stay in that
  fragment's file, hidden from every query, until later deletes or a table
  rebuild cross the threshold. This applies to the strict path too. A verified
  erasure request that cannot wait needs the table rebuilt (reindex the
  project) or dropped.
- The mark is written after the cleanup transaction, from process memory. A
  worker that dies between the commit and that write loses it, and the table
  is then pruned by its next write's maintenance.
- Row deletes outside document cleanup (a re-embed replacing stale chunk
  vectors, a page-vector rollback) do not schedule a prune. They are followed
  by writes, so ordinary maintenance prunes them, and any pass that compacts
  re-arms the prune.

### Community summaries

A graph community summary is written from its member entities and the
relations between them. Three rules keep one from outliving a removed
document:

- When cleanup removes a document's graph contributions, every community that
  lost a member entity or an internal relation is deleted with its summary. A
  community whose members and relations are all still supported by other
  documents is kept.
- A refresh reuses an earlier summary only when its entities (id, name, type)
  and internal relations are exactly the same (`metadata.inputHash`), not just
  the same member ids.
- A refresh re-reads the graph under the project graph lock before publishing
  and drops any community whose inputs changed while it was being summarized.

Nothing schedules a refresh after a delete. Deleted communities are rebuilt by
the project's next graph-enabled run or graph rebuild job; until then
community search has no entry for those entities. Chunk, graph and lexical
search are unaffected.

Community search can still return the old summary until the cleanup sweep
runs: 30 s after a delete, 60 s grace plus a sweep for a superseded version,
15 minutes for a document deleted while still processing.

When a batch fails, the sweep retries it row by row so that one bad row cannot
block the others. A failed row is retried on later sweeps, up to 10 attempts,
and `last_error` holds the cause.

Documents and runs that were still `queued` or `processing` when they were
deleted get `not_before = now() + 15 min`. A cancelled worker can still write
for a short time, and this window lets those late artifacts land before the
sweep deletes them.

## Delete paths

| Path | Entry point | Behaviour |
| --- | --- | --- |
| Document(s) | `DELETE /v1/documents/:id`, bulk delete (`services/documents.ts`) | Rows are deleted at once, and the trigger enqueues cleanup. |
| Project | `DELETE /v1/projects/:id` (`services/projects.ts` → `services/data-deletion.ts`) | In-flight runs are cancelled in Temporal and marked `cancelled`. Documents are then deleted in batches of 500, and finally the project row is deleted, which cascades to runs and per-project rows. If Temporal is unreachable, the delete still proceeds and the grace period covers late writes. |
| Run retention | worker `deleteExpiredRuns` | When a run is older than `run_retention_days`, its documents and the run row are deleted together, whether or not artifact retention already ran. A deleted run takes its artifacts with it. Newer versions that pointed at a deleted predecessor get `previous_version_id = null`. |
| Artifact retention | worker `purgeExpiredArtifacts` | Deletes artifacts and derived rows but keeps the document rows. Before `vector_indexes` is dropped, the document's LanceDB targets are queued (`delete_source = false`). |
| Discarded intake | `discardUnstartedRun` (`services/run-creation.ts`) | When a queued run's intake failed, its documents and run are deleted and the triggers enqueue its raw uploads. |
| Organization | `DELETE /v1/organizations/:orgId` | See below. |
| Account | `DELETE /v1/account` | See below. |

## Organization deletion

This action requires a signed-in session from an owner. API keys are refused.
The owner confirms by typing the org name exactly. A personal organization
cannot be deleted on its own. It is removed when the account is deleted.

`purgeOrganization` (`services/tenant-offboarding.ts`) runs these steps in
order:

1. **Billing.** There is no subscription to cancel: credits are prepaid.
   Unused credits are not refunded automatically; refunds are handled
   manually.
2. **Tombstone and access, in one transaction.** It sets `deleted_at`,
   turns off auto top-up (so no further charge can start), deletes memberships and invites, revokes API keys
   and MCP OAuth grants, deletes the organization's webhooks (URLs and signing secrets, with their delivery log),
   deletes SSO domains, links and requests, and writes an `organization.deleted` audit row.
3. It cancels in-flight runs through Temporal.
4. It deletes undelivered `webhook_outbox` rows about the org's runs.
5. It deletes every project (`deleteProjectData`): each queues
   `vector_table` drops for its LanceDB databases, and the triggers enqueue
   storage cleanup.
6. It deletes org-scoped non-billing rows: AI operations, graph jobs, budget
   alerts, notification preferences and deliveries, and upload sessions.
7. It anonymizes the tombstone: `name = 'Deleted organization'`, `slug`,
   SSO config, budgets and auto top-up cleared, and `offboarded_at` set.

The purge is idempotent. If it is interrupted after step 2 (`deleted_at` set,
`offboarded_at` null), the maintenance sweep resumes it after 5 minutes
(`resumeOrganizationDeletions`).

## Account deletion

This action requires a signed-in session. The user confirms by typing their
email address. Use `GET /v1/account/deletion` to preview the outcome:

- **Blockers.** These are orgs where the user is the only owner and other
  members remain. The request is refused (409 `ownership_transfer_required`)
  until the user makes another member an owner or deletes the org.
- **Deleted.** The user's personal org, and any org where they are the only
  member, are fully purged as described above.
- **Left.** The user leaves every other org. Documents and projects they
  added there stay with the org, because the org is the data controller for
  team content, and the org's owners and admins keep managing them.

The following user data is deleted: memberships, pending invites the user
sent, API keys (revoked and renamed), MCP grants and requests, webhooks they
created (they stop delivering once the user leaves anyway) and their deliveries, MCP service connections, stored OAuth tokens, SSO
links, settings, notification preferences, chat and search sessions, query
suggestions, idempotency entries, and Better Auth sessions, credentials and
verifications. The response also clears the browser's session cookies.

Better Auth's built-in `deleteUser` endpoint is not used. A hard delete of the
`user` row would cascade through about 50 `user_id` foreign keys, including
team content and billing history. Instead, the user row becomes a tombstone:
`name = 'Deleted user'`, `email = deleted-<id>@deleted.invalid`, no image, and
`deleted_at` set. The opaque id stays on retained org content and billing
records but no longer identifies a person.

Session cookies are cached for up to 5 minutes (`cookieCache.maxAge`). During
that window, another device that is still signed in may load pages, but it has
no memberships, and bootstrap refuses to recreate a personal org for a deleted
user.

## What is kept, and why

These records are kept for accounting, tax and audit purposes. They reference
anonymized tombstones.

- `organizations` tombstone row: Stripe customer id, the prepaid credit
  balance and when the organization was first funded.
- `credit_ledger`, `credit_grants`, `credit_debits_pending`,
  `storage_meter_days`: the money trail.
- `usage_events`: the usage behind invoices. `run_id` and `document_id` become
  null once runs and documents are deleted.
- `audit_log`, including the `organization.deleted` and `account.deleted`
  rows.
- Stripe keeps its own customer and invoice records, which DocSlurp does not
  delete.

Migration `0036_tenant_offboarding.sql` enforces this in the schema. Deleting
an org's creator no longer deletes the org (`created_by_user_id` is now `ON
DELETE SET NULL`). A hard `delete from "user"` is refused (`RESTRICT`) while
the user still owns projects, runs or documents, or has usage events or
ledger entries, so it can no longer cascade into shared data.

## SLA

| Step | Target |
| --- | --- |
| Rows removed and content no longer searchable or listable | Immediate (the request returns after commit) |
| LanceDB rows and storage artifacts deleted | Within 5 minutes; within 20 minutes for work that was in flight (15 min grace plus a sweep) |
| Community summaries that drew on the document deleted | With the row above |
| Deleted rows pruned from LanceDB table history | About 11 minutes after the delete, or about 22 when the pass compacted; see the known limits above for small deletes |
| Interrupted org deletion completed | Within 10 minutes (resumed by the maintenance sweep) |
| Backups and snapshots age out | Within 35 days: Neon history window (≤ 30 days), Tigris snapshots and the backup bucket's 35-day lifecycle (`docs/disaster-recovery.md`). For a verified erasure request that cannot wait, delete the specific object `versionId`s. |

Operators should alert on cleanup rows that have stopped retrying or are
overdue:

```sql
select 'document' as queue, count(*) filter (where attempts >= 10) as stuck,
  count(*) filter (where not_before < now() - interval '1 hour') as overdue
from document_cleanup_queue
union all
select 'storage', count(*) filter (where attempts >= 10),
  count(*) filter (where not_before < now() - interval '1 hour')
from storage_cleanup_queue;
```

To retry stuck rows after fixing the cause, run `update ... set attempts = 0`.

## Not covered yet

- A self-serve data export before deletion. Documents and artifacts can be
  exported per document today.
- Ownership transfer UI. Owners are promoted through the members API.
- Hard deletion of tombstones after the accounting retention period.
