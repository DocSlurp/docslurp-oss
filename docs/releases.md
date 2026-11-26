# Package releases

`DocSlurp/docslurp-oss` is the source of truth for the server, worker and public packages. The private app and manual production deployment live in `DocSlurp/app`. The former `DocSlurp/docslurp` repository retains historical commits, release assets and unfinished branches as an archive; do not publish new releases there.

All public libraries listed in `scripts/package-release.mjs` share one stable version and release together from a `v<version>` tag. Package documentation lives at https://docslurp.io/docs/packages/. Package metadata and README source links point to this repository.

## Release procedure

1. Run `pnpm release:prepare patch` (or an explicit stable version), review and commit the package versions, then merge the release PR to main.
2. Run `node scripts/package-release.mjs check`.
3. Dispatch `release-npm.yml` on main with `dry_run=true`. The dry run builds and tests packages, tests and imports them on Node 20 (the published engines floor), inspects the packed tarballs and runs npm publish in dry-run mode. It publishes nothing.
4. After the dry run succeeds, run `pnpm release:tag` on clean, up-to-date main and push that tag to origin. Tag pushes publish packages; do not push a tag during a repository migration or routine verification.
5. The same tag push runs `worker-images.yml`, which builds `ghcr.io/docslurp/worker-lean` and `ghcr.io/docslurp/worker-full` (linux/amd64) and tags each with the version and the commit SHA. The workflow bakes the version into each image as `DOCSLURP_VERSION`, and the Modal parser sandbox provider defaults to `worker-full:<DOCSLURP_VERSION>`, so confirm both images exist in GHCR before announcing the release. Each image is pushed with max-mode BuildKit provenance and an SPDX SBOM, then a separate job signs its digest with keyless cosign, attaches a GitHub build provenance attestation and verifies the signature; the run summary lists each digest and the `cosign verify` command (see [Verifying worker images](self-host/security.md#verifying-worker-images)). Modal pulls that image without credentials, so the `worker-full` GHCR package must be public (operators with a private copy set `DOCSLURP_MODAL_REGISTRY_SECRET`). To republish images without a package release, dispatch `worker-images.yml` with the `version` input.

The release workflow validates that a tag matches all package versions, is on main, and has not moved between verification and publishing. The publish job uses the verified tarballs and compares npm SHA-512 integrity afterwards. Existing versions are skipped only when their integrity matches. Retired-package shims and deprecation are explicit workflow inputs.

## Authentication and provenance

The `npm` environment contains release configuration. The repository `NPM_TOKEN` secret supplies token authentication where required; `npm-auth.yml` checks it without publishing. For trusted publishing, configure npm to trust owner `DocSlurp`, repository `docslurp-oss`, workflow `release-npm.yml`, environment `npm`. Repository-specific trusted-publisher settings must name this repository.

The repository remains private until a separate visibility decision. The workflow requests provenance only when GitHub reports a public repository. Historical packages and attestations are immutable; their older source links remain historical evidence.

## Production

Merging core or app changes never deploys production. Production deploys are manually dispatched from the app repository. Core migrations run from `server/db/migrations`; every new migration must pass the expand/contract gate before the app adopts its core pin.

## Verify a repository cutover

After moving release configuration, dispatch `npm-auth.yml` on main to verify token authentication, then dispatch `release-npm.yml` with `dry_run=true` to verify the complete non-publishing path. The dry run must succeed before creating a release tag. A repository migration does not authorize package publishing or a production deployment.

The release environment permits only main and v* tags. Organization-owned contributions use the existing CLA exemption; external contributor setup is documented in [cla-setup.md](cla-setup.md).

## Execution-generation rollout

Migration 0112 requires coordinated downtime, not a rolling release. Follow the
[enforced migration preconditions and drain procedure](generation-rollout.md)
before deploying a fleet that uses execution generations.

## How migrations are applied

`node server/db/migrate.mjs` (the release command, the Compose `migrate` service and `RUN_STARTUP_MIGRATIONS`) takes the
migration advisory lock on one direct owner connection and runs `server/db/migration-runner.mjs`:

- **Files, not a journal.** Every `*.sql` file in `server/db/migrations` that the database has not recorded in
  `docslurp_migrations.applied` (by file name) is applied, in name order. The numbered `NNNN_` files are frozen; new ones
  are `YYYYMMDDTHHMM_name.sql` in UTC (`pnpm db:new <name>`) and sort after them. A migration that merges after a
  later-named one was already applied still runs, and the log says so.
- **One transaction per file.** A lock a migration takes is released when that file commits. A failure rolls back that
  file only: the files before it stay applied and recorded, and a re-run continues from the failed file. Because of this
  every migration must be safe to run twice and must keep the previous release working (the expand/contract gate,
  `scripts/check-migration-safety.mjs`, and `worker/src/__tests__/migrations-idempotent.test.ts`).
- **Bounded lock waits.** Each file starts with `lock_timeout` set to `MIGRATION_STATEMENT_LOCK_TIMEOUT_MS` (15 s) and is
  retried `MIGRATION_LOCK_RETRIES` times (3) when the wait times out or deadlocks, so a migration blocked by a long
  transaction fails fast instead of queueing the site behind it.
- **Databases migrated by Drizzle** (every database before this runner) are mapped once, on the first run: the files the
  Drizzle ledger counted as applied are recorded by name and not re-run. The mapping refuses a ledger whose newest stamp
  it does not know. `drizzle.__drizzle_migrations` is kept, marked as mapped, and stays current for the numbered files,
  so a rollback to the previous release still reads its schema as applied. A database first created by this runner has
  no Drizzle ledger: it cannot be rolled back to a release that used Drizzle's migrator.
- **The ledgers are trusted only when the migration owner owns them** (schema and table) and they are plain tables with
  no triggers, rules, row-level security or inheritance. Anything else stops the run before a migration is applied.
- **A migration cannot end its transaction or change role.** The CI gate refuses `BEGIN`, `COMMIT`, `ROLLBACK`,
  `SET ROLE` and session-level `SET search_path` in a migration, and the runner checks both after each file.
- **The generation cutover (0112) stays all or nothing.** A database from before it is upgraded in one transaction, as
  before, because its downtime barrier is verified once for that run.
- **Grants.** Role grants are reconciled after the run, and also after a failed run that committed some files.
- **Changed files.** An applied file whose contents no longer match the recorded hash is reported with a warning and
  never re-run. Put the change in a new migration.
- **A lost ledger** is refused, not replayed and not mapped from Drizzle a second time: see
  `MIGRATION_ASSUME_APPLIED_THROUGH` in [configuration](self-host/configuration.md). Unset it once the run succeeds.

Readiness (`/ready`), the `migrations-not-at-head` alert and `predeploy-check.mjs` compare the files a build ships with
the ledger file by file. The application and worker roles can read the ledger and cannot write it.

## Migrations 0121-0127

These migrations ship in one release. 0125 and 0127 delete rows (pre-release data: webhooks and API keys without exactly one
organization, and memberships beyond one per user), and the only rollback is a database snapshot taken right before migrating.
Run `node server/db/predeploy-check.mjs --strict` from the new image first, snapshot, migrate as a standalone step (not a
`release_command`), then build the folded keyword index with `node server/db/folded-search-index.mjs`. The order, what is
deleted and not rollback-safe, the mixed-version window and SigNoz signals are in [rollout-0121-0127.md](rollout-0121-0127.md).

## Extraction config compatibility release (R0) and cutover (R1)

`DOCSLURP_PROFILE` and `DOCSLURP_DISABLE` ([Deployment profile](self-host/deployment-profile.md)) replace
`DOCSLURP_SERVICE_PROFILE` and several older variables in two releases:

- **R0 (compatibility).** Reads both the old and the new names: a warning when they agree, a startup refusal when they
  disagree. A worker outside development refuses to start with no profile on either name. Knows the whole `DOCSLURP_DISABLE` vocabulary. Workers advertise `extraction.config-v1` and their posture
  digest (migration 0182, additive); `GET /ops/worker-fleet` shows whether the whole fleet enforces the switches.
- **R1 (cutover).** Retired variables refuse startup. Deploy R1 only after R0 runs everywhere and every deployment's
  configuration has moved to the new names.

Rollback is an image, environment and configuration bundle, never an image alone, and goes from R1 to R0 only: R0
understands both name sets and every switch, so it never meets an unknown token. Roll out app first, worker first or as
a mixed fleet in either order; the API applies its own switch lowering whatever the fleet runs.
