# DocSlurp licensing

The server (`server/`, the Hono API with its database code in `server/db/`), worker, CLI and server-side Algolia adapter use SSPL-1.0,
with an irrevocable Apache-2.0 future grant three years after each version is
first publicly available under these terms. The license text is unmodified;
the scope notice and future grant are separate from it. The MIT exceptions are
listed in the root LICENSE and carry package-local licenses.

## Why this split

[Inngest's server license](https://github.com/inngest/inngest/blob/main/LICENSE.md)
uses SSPL plus a three-year Apache-2.0 grant. Inngest's SDKs use Apache-2.0;
DocSlurp intentionally uses MIT for its SDKs and client integrations.

| Option | Hosted-service consequence | Fit for this change |
| --- | --- | --- |
| SSPL-1.0 | Offering the program's functionality to third parties as a service triggers section 13's Service Source Code requirement, including service infrastructure | Matches Inngest's model; chosen for the server, worker, CLI and Algolia server adapter |
| Business Source License 1.1 (BUSL-1.1) | Production permissions depend on a custom Additional Use Grant; requires change-license/date parameters | Alternative if we want a targeted competing-service restriction instead of service-wide source disclosure |
| AGPLv3 | Modified network services must offer corresponding source; compliant competing services remain permitted | Appropriate for an open-source network copyleft strategy, but does not reproduce SSPL's service-wide requirement |

SSPL and BUSL are source-available licenses, not OSI-approved open-source
licenses. Do not describe the whole service as MIT or open source. BSL-1.0 is
the Boost Software License, not the Business Source License.

References: [SSPL section 13](https://www.mongodb.com/legal/licensing/server-side-public-license),
[BUSL 1.1](https://mariadb.com/bsl11/),
[AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html).

## Boundaries and use

- The SDK (including `@docslurp/sdk/embed`), the Astro component and the search compatibility package are MIT.
  Applications can use them under MIT without adopting SSPL merely because
  they communicate with DocSlurp over HTTP.
- Shared contracts are MIT because both server and client integrations may
  need them. They do not import dashboard or worker implementation code.
- `packages/contrib-algolia-server` implements the service adapter and is SSPL.
  Until 2026-10-15 its `package.json` and package `LICENSE` said MIT while the
  root `LICENSE` said SSPL; both package files now say SSPL, matching the root.
  `0.2.0` is already on npm under MIT and that grant stands, so SSPL applies
  from the next release. Owner decision: keep SSPL (server-side adapter) or move
  the package to the MIT list in the root `LICENSE` instead.
  `packages/contrib-wordpress` is an MIT client integration, including its website
  proxy; it talks to the service rather than implementing the ingestion service.
- `docslurp --license` prints the CLI's license. SDK npm packages include MIT
  text, NOTICE and the historical Apache text. CLI packages include SSPL and
  its future grant, NOTICE and the future Apache text.
- Internal use and self-hosting remain possible subject to the actual terms
  and dependency licenses. SSPL is not a blanket noncommercial license.
  Serving functionality to third parties may trigger section 13 even when
  the code is unmodified. A closed competing service needs separately granted
  rights or a different implementation; paying for an SDK does not grant them.
- User documents and extraction output are not automatically SSPL-covered;
  output is covered only when its content itself constitutes a covered work.
- Existing Apache-2.0 grants are irrevocable subject to their conditions.
  This change does not revoke old release rights or erase upstream notices.

## Open-source split status

Tracked in the split ticket. The
private monorepo stays the source of truth and an allowlist exporter publishes
the public tree to `DocSlurp/docslurp-oss` (private until the owner flips it).

- Root `LICENSE` scope now names `server/` and states that the private
  frontend (`app/`) is not part of the public tree and is all rights reserved.
  `app/LICENSE` still carries the old SSPL text; owner decision whether the
  frontend is proprietary or SSPL while it stays private.
- `app`, `worker` and `packages/shared` are `"private": true`; only
  `releasePackages` can be published.
- Public messaging: "source-available server (SSPL-1.0 + future Apache-2.0
  grant), MIT SDKs". Do not call the server open source.
- Public-repo drafts live in `docs/public/` (README, AGENTS, TRADEMARK) plus
  `CONTRIBUTING.public.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and `CLA.md`.
- Contributions: owner decision 2026-10-15 is a **CLA** (not DCO), so the right to
  relicense (dual SSPL/Apache-future-grant plus commercial terms) is granted by each
  contributor. [CLA.md](../CLA.md) is modelled on the Apache ICLA/CCLA (individual Part A,
  entity Part B), names DocSlurp, Inc. and is a draft for counsel review. The public repo
  enforces it with `contributor-assistant/github-action` (template
  `ops/oss-export/templates/.github/workflows/cla.yml`; setup in
  open-source-cla-setup.md).
- Trademark: the code licenses grant no rights to the name or logo; the policy
  (`docs/public/TRADEMARK.md`, exported as `TRADEMARK.md`) requires modified forks and
  hosted offerings to rebrand. Registration status: unregistered, pending.
- Contact for legal, licensing, security, conduct and trademark requests:
  **legal@docslurp.io**. The licensor and copyright holder is named as "DocSlurp, Inc. and
  contributors" in `LICENSE`; the owner must confirm that this is the correct legal
  entity name and that it holds the rights (see the release review below).
- Model weights: none. The YOLO26 layout models (Ultralytics, AGPL-3.0) were an unused experiment and
  were dropped on 2026-10-15 (code, weights manifest, fetch script and mirror copies); nothing in the
  worker, server or app ever loaded them.
- Third-party test fixtures: pinned in `worker/testdata/third-party-fixtures.manifest.json` and
  fetched by `pnpm fixtures:fetch` into `.cache/fixtures/pdf`. Only generator-produced synthetic
  fixtures stay in git.
- Private asset mirror: the 9 no-upstream PDFs and the byte-exact
  50-page catalog cut are not fetchable from any public URL, so they live in a private S3-compatible
  bucket under content-addressed keys (`fixtures/<sha256>/<name>`, recorded as `mirrorKey` in the manifest).
  The loader (`pnpm fixtures:fetch`) reads it when these are set:
  `DOCSLURP_ASSET_MIRROR=s3://<bucket>`, `DOCSLURP_ASSET_S3_ENDPOINT`, `DOCSLURP_ASSET_S3_REGION`,
  `DOCSLURP_ASSET_S3_ACCESS_KEY_ID`, `DOCSLURP_ASSET_S3_SECRET_ACCESS_KEY`. Use the team's **read-only**
  key from the team secrets (ask the owner; it is never in the repo). Upstream URLs are tried first and
  the mirror is the fallback. Without the key, no-upstream assets print "private asset, not available",
  `fixtures:fetch` skips them (naming one explicitly fails), and tests/benchmarks skip.
  Publishing needs a write key: `node scripts/publish-asset-mirror.mjs --write-manifest` (private only,
  not exported). The exporter's `private-asset-mirror` scrub rule keeps the bucket, endpoint and
  credential names out of the public tree.
- Marker/Surya are removed from the code, lockfiles and docs catalogs; nothing fetches them.
- PyMuPDF/PyMuPDF4LLM (AGPL or commercial) and the MuPDF `mupdf-tools` package are gone from the worker, its locks and
  images, and (2026-10-15) from every dev/eval script and CI job. The scripts author, rasterise and redact PDFs through
  `scripts/pdfkit` (pypdf, pypdfium2/PDFium, reportlab, fontTools, WeasyPrint, pdfplumber: BSD-3-Clause, Apache-2.0 or
  MIT; table in THIRD_PARTY_NOTICES.md). The only remaining installs are the third-party ParseBench harness and GLM-OCR SDK
  on owner-run research hosts, which import PyMuPDF themselves.
- The export ships manifests and fetch scripts only, never binaries (`ops/oss-export/paths.txt`).
- Package metadata keeps pointing at the private repo; the public slug is one
  constant in the package catalog and the exporter rewrites links.
- Clearance inventory: [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md),
  "Phase 2 clearance inventory". Still a draft: nothing there is cleared.

## Release review

Keep this change in draft until the ownership and third-party issues in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) are resolved. Copyright
ownership and contributor authority must be verified before changing grants
or issuing alternative commercial terms. Git authorship alone is not proof.

For every public release, preserve the exact source commit, first publication
date under these terms, and third-anniversary date in the release record.
Do not start the clock from the original Apache release of inherited code.
Ship the matching source/build scripts alongside binary download links or
provide equivalent source access that satisfies SSPL section 6. A main-branch
URL alone is not enough to identify the source for an old binary.

Retain dependency notices and licenses in npm packages, browser bundles and
container distributions. Containers must preserve upstream source/offer
obligations for independently shipped copyleft tools. A Docker COPY of our
own license does not discharge those obligations. Inventory exact model
revisions and weights separately from Python/JavaScript package licenses.

The `/license` page and CLI help provide copyright, no-warranty, redistribution
and license-access notices. Hosted-service terms explicitly preserve software
license rights. No npm publication, main merge or deployment is part of this
licensing draft.
