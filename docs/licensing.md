# DocSlurp licensing

The server (`server/`, the Hono API with its database code in `server/db/`),
worker and CLI use the **Business Source License 1.1** (BUSL-1.1). Each version
converts to Apache-2.0 three years after it is first published. The SDKs,
shared contracts and client integrations are MIT; they are listed in the root
`LICENSE` and carry package-local licenses. The BUSL text is unmodified
(`LICENSES/BUSL-1.1.txt`); DocSlurp fills in only its parameters.

Licensor and copyright holder: **17th Street Labs, LLC**, doing business as
"DocSlurp, by 17th Street Labs" (owner, 2026-11-12).

## The free tier (Additional Use Grant)

Modelled on [boxd.sh](https://boxd.sh/self-hosting/)'s self-host license:
free up to a fixed amount of compute, a commercial license above it.

- **Production use is free** when the whole deployment, including affiliates,
  runs on **no more than 16 vCPUs in total across no more than 4 worker or GPU
  instances**.
- A **worker or GPU instance** is any machine, VM, microVM, container or
  sandbox that runs the worker, processes its jobs (parser and OCR sandboxes
  count) or provides GPU acceleration, including self-hosted GPU inference.
  Model inference bought per request from a third-party API does not count.
  API, database, queue and storage hosts do not count.
- **vCPUs** are each instance's logical CPUs (its CPU quota, if lower), added
  up at the busiest moment.
- Offering DocSlurp, or a derivative, to third parties as a hosted document
  ingestion, extraction, search, retrieval or chat service is not covered.
- Non-production use (development, testing, evaluation) is always allowed by
  BUSL itself, at any size. So is using the CLI against a DocSlurp service run
  by the Licensor.
- Above the grant: commercial license from legal@docslurp.io.

**Honor system (owner, 2026-11-12).** No license key, no sign-up, no telemetry
and no runtime check. The software never refuses work because of the limit.
Do not add phone-home or vCPU enforcement code without an owner decision. The
license is the control; in source-available code a check is trivially removed.

## Why BUSL

| Option | Hosted-service consequence | Fit |
| --- | --- | --- |
| BUSL-1.1 | Production use only within the Additional Use Grant; the rest needs a commercial license. Converts to the Change License per version | **Chosen 2026-11-12**: the only common source-available license that can carry a size-based free tier |
| SSPL-1.0 (previous) | Offering the program as a service triggers section 13's service-source requirement; GPLv3-style "no further restrictions" rules out a vCPU cap | Used until 2026-11-12, following [Inngest](https://github.com/inngest/inngest/blob/main/LICENSE.md) |
| PolyForm Internal Use | Internal use only, no redistribution | What boxd.sh uses, with binary-only distribution. Incompatible with a public source repo and npm-published CLI |
| AGPLv3 | Modified network services must offer source; competing services stay permitted | Open source, but no paid tier |

BUSL's covenants require a GPL-compatible Change License (Apache-2.0 is, via
GPLv3), a Change Date no later than four years after release, and no other
edits to the text. BUSL is source-available, not OSI-approved open source.
Do not call the server open source. BSL-1.0 is the Boost license, not this one.

References: [BUSL 1.1](https://mariadb.com/bsl11/),
[SSPL](https://www.mongodb.com/legal/licensing/server-side-public-license).

## Earlier versions

- Versions published before 2026-11-12 under SSPL-1.0 keep SSPL-1.0 and their
  irrevocable three-year Apache-2.0 future grant (`LICENSES/SSPL-1.0.txt`).
- The 0.1.x SDK and CLI npm releases keep Apache-2.0.
- Relicensing future versions relies on the CLA's relicensing grant from every
  contributor; see `CLA.md`.

## Boundaries and use

- The SDK (including `@docslurp/sdk/embed`), the Astro component and the search compatibility package are MIT.
  Applications can use them under MIT without adopting BUSL merely because
  they communicate with DocSlurp over HTTP.
- Shared contracts are MIT because both server and client integrations may
  need them. They do not import dashboard or worker implementation code.
- `packages/contrib-algolia-server` is MIT (owner decision, 2026-10-15). It is
  a client-side wrapper that syncs Algolia-style settings, synonyms, rules and
  imports into DocSlurp over HTTP, so it sits with the other client packages in
  the root `LICENSE` MIT list.
  `packages/contrib-wordpress` is an MIT client integration, including its website
  proxy; it talks to the service rather than implementing the ingestion service.
- `docslurp --license` prints the CLI's license. SDK npm packages include MIT
  text, NOTICE and the historical Apache text. CLI packages include BUSL-1.1
  with its parameters, NOTICE and the Apache text (the Change License).
- User documents and extraction output are not covered by BUSL; output is
  covered only when its content itself constitutes a covered work.
- Existing Apache-2.0 and SSPL-1.0 grants are irrevocable subject to their
  conditions. This change does not revoke old release rights or erase
  upstream notices.

## Open-source split status

Tracked in the split ticket. The
private monorepo stays the source of truth and an allowlist exporter publishes
the public tree to `DocSlurp/docslurp-oss` (private until the owner flips it).

- Root `LICENSE` scope now names `server/` and states that the private
  frontend (`app/`) is not part of the public tree and is all rights reserved.
  `app/LICENSE` is all rights reserved (owner, 2026-11-12).
- `app`, `worker` and `packages/shared` are `"private": true`; only
  `releasePackages` can be published.
- Public messaging: "source-available server (BUSL-1.1, free up to 16 worker vCPUs / 4 instances,
  Apache-2.0 after three years), MIT SDKs". Do not call the server open source.
- Public-repo drafts live in `docs/public/` (README, AGENTS, TRADEMARK) plus
  `CONTRIBUTING.public.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and `CLA.md`.
- Contributions: owner decision 2026-10-15 is a **CLA** (not DCO), so the right to
  relicense (BUSL with an Apache-2.0 Change License, plus commercial terms) is granted by each
  contributor. [CLA.md](../CLA.md) is modelled on the Apache ICLA/CCLA (individual Part A,
  entity Part B), names 17th Street Labs, LLC (DocSlurp) and is a draft for counsel review. The public repo
  enforces it with `contributor-assistant/github-action` (template
  `ops/oss-export/templates/.github/workflows/cla.yml`; setup in
  open-source-cla-setup.md).
- Trademark: the code licenses grant no rights to the name or logo; the policy
  (`docs/public/TRADEMARK.md`, exported as `TRADEMARK.md`) requires modified forks and
  hosted offerings to rebrand. Registration status: unregistered, pending.
- Contact for legal, licensing, security, conduct and trademark requests:
  **legal@docslurp.io**. The licensor and copyright holder is "17th Street Labs, LLC
  and contributors" in `LICENSE` (owner, 2026-11-12). Existing CLA signatures cover the
  BUSL relicensing and the licensor name change (owner, 2026-11-12); the CLA stays at
  version 1.0.
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
provide equivalent source access (BUSL is a source license; SSPL section 6
still applies to old SSPL binaries). A main-branch
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
