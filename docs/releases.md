# Package releases

`DocSlurp/docslurp-oss` is the source of truth for the server, worker and public packages. The private app and manual production deployment live in `DocSlurp/app`. The former `DocSlurp/docslurp` repository retains historical commits, release assets and unfinished branches as an archive; do not publish new releases there.

All public libraries listed in `scripts/package-release.mjs` share one stable version and release together from a `v<version>` tag. Package documentation lives at https://docslurp.io/docs/packages/. Package metadata and README source links point to this repository.

## Release procedure

1. Run `pnpm release:prepare patch` (or an explicit stable version), review and commit the package versions, then merge the release PR to main.
2. Run `node scripts/package-release.mjs check`.
3. Dispatch `release-npm.yml` on main with `dry_run=true`. The dry run builds and tests packages, imports every package export on Node 24, inspects the packed tarballs and runs npm publish in dry-run mode. It publishes nothing.
4. After the dry run succeeds, run `pnpm release:tag` on clean, up-to-date main and push that tag to origin. Tag pushes publish packages; do not push a tag during a repository migration or routine verification.

The release workflow validates that a tag matches all package versions, is on main, and has not moved between verification and publishing. The publish job uses the verified tarballs and compares npm SHA-512 integrity afterwards. Existing versions are skipped only when their integrity matches. Retired-package shims and deprecation are explicit workflow inputs.

## Authentication and provenance

The `npm` environment contains release configuration. The repository `NPM_TOKEN` secret supplies token authentication where required; `npm-auth.yml` checks it without publishing. For trusted publishing, configure npm to trust owner `DocSlurp`, repository `docslurp-oss`, workflow `release-npm.yml`, environment `npm`. Repository-specific trusted-publisher settings must name this repository.

The repository remains private until a separate visibility decision. The workflow requests provenance only when GitHub reports a public repository. Historical packages and attestations are immutable; their older source links remain historical evidence.

## Production

Merging core or app changes never deploys production. Production deploys are manually dispatched from the app repository. Core migrations run from `server/db/migrations`; every new migration must pass the expand/contract gate before the app adopts its core pin.

## Verify a repository cutover

After moving release configuration, dispatch `npm-auth.yml` on main to verify token authentication, then dispatch `release-npm.yml` with `dry_run=true` to verify the complete non-publishing path. The dry run must succeed before creating a release tag. A repository migration does not authorize package publishing or a production deployment.

The release environment permits only main and v* tags. Organization-owned contributions use the existing CLA exemption; external contributor setup is documented in [cla-setup.md](cla-setup.md).
