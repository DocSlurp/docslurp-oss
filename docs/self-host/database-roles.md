# Database roles

By default the server, the workers, migrations and backups all connect as one Postgres role that owns the schema. That role can create, alter and drop every table, so a compromised worker (workers parse untrusted files) could read or rewrite every tenant's data, including credentials. DocSlurp supports four roles so each process gets only what it needs.

| Role | Used by | Privileges |
| --- | --- | --- |
| `docslurp` (owner) | Migrations (`MIGRATION_DATABASE_URL`) and break-glass access | Owns every object |
| `docslurp_app` | The API server (`DATABASE_URL`) | Select, insert, update and delete on every table; usage on sequences; execute on functions. No `CREATE`, not an owner |
| `docslurp_worker` | Workers (`DATABASE_URL` on worker hosts) | DML only on the tables workers use; column-level reads of `user` (`id`, `email`), `webhooks` (`user_id`, `active`, `events`) and `workspace_secrets` (no ciphertext). No access to auth, API key, OAuth, SSO, connector or Stripe tables |
| `docslurp_backup` | `pg_dump` | `pg_read_all_data` |

The worker's table list lives in `server/db/roles.mjs` (`WORKER_TABLES`, with the code that needs each one, and `WORKER_DENIED_TABLES`, with the reason for each). A test (`server/src/__tests__/db-roles.test.ts`) fails when a migration adds a table that is in neither list, so a new table is never silently granted or denied.

## How grants are kept current

Roles are cluster-wide and need `CREATEROLE`, so migrations do not create them. Once they exist:

- `server/db/migrate.mjs` reconciles grants after every run, under the migration lock, so a table a release adds is granted before the release's code runs. Without the roles it does nothing extra.
- Default privileges (`ALTER DEFAULT PRIVILEGES FOR ROLE docslurp`) give `docslurp_app` DML on every table the owner creates later. The worker gets nothing by default; it gets a new table only once the table is added to `WORKER_TABLES`.
- `node server/db/roles.mjs` (with `DATABASE_URL` set to the owner or a superuser) reconciles without applying migrations.

`migrate.mjs` refuses to run as a role that cannot create in schema `public` or does not own the tables, and names `MIGRATION_DATABASE_URL` in the error. Set it to the owner's URL whenever `DATABASE_URL` points at a restricted role. This includes `RUN_STARTUP_MIGRATIONS=true`.

## Set up

1. As a superuser, create the login roles and give the backup role `pg_read_all_data`:

   ```sql
   create role docslurp_app login password '...';
   create role docslurp_worker login password '...';
   create role docslurp_backup login password '...';
   grant connect on database docslurp to docslurp_app, docslurp_worker, docslurp_backup;
   grant pg_read_all_data to docslurp_backup;
   ```

2. Reconcile grants: `DATABASE_URL=postgres://docslurp:...@host/docslurp node server/db/roles.mjs`.
3. Set `MIGRATION_DATABASE_URL` to the owner's URL on the server, then point the workers' `DATABASE_URL` at `docslurp_worker`, the server's at `docslurp_app` and backups at `docslurp_backup`.

Rolling back is the reverse: point `DATABASE_URL` back at the owner. The roles and grants can stay.

## Runtime requirements

Neither runtime role runs DDL. The server and workers use `LISTEN`/`NOTIFY`, advisory locks (`pg_advisory_lock`, `pg_advisory_xact_lock`) and `to_regclass`/`information_schema` checks, none of which need ownership. Triggers and functions are `SECURITY INVOKER`, so the worker's list includes the tables its writes reach through triggers (for example `workspace_corpus_stats` and `credit_ledger`). Foreign-key cascades run as the table owner and need no grant.

The server's database watchdog counts its own pool's backends in `pg_stat_activity`. Postgres shows a role the state of its own sessions, so the server's pool and probe must use the same role.
