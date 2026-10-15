# DocSlurp licensing

The server (the API, extracted to `server/` for the public tree), worker, CLI and server-side Algolia adapter use SSPL-1.0,
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
| SSPL-1.0 | Offering the program's functionality to third parties as a service triggers section 13's Service Source Code requirement, including service infrastructure | Matches Inngest's model; chosen for the server and CLI |
| Business Source License 1.1 (BUSL-1.1) | Production permissions depend on a custom Additional Use Grant; requires change-license/date parameters | Alternative if we want a targeted competing-service restriction instead of service-wide source disclosure |
| AGPLv3 | Modified network services must offer corresponding source; compliant competing services remain permitted | Appropriate for an open-source network copyleft strategy, but does not reproduce SSPL's service-wide requirement |

SSPL and BUSL are source-available licenses, not OSI-approved open-source
licenses. Do not describe the whole service as MIT or open source. BSL-1.0 is
the Boost Software License, not the Business Source License.

References: [SSPL section 13](https://www.mongodb.com/legal/licensing/server-side-public-license),
[BUSL 1.1](https://mariadb.com/bsl11/),
[AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html).

## Boundaries and use

- SDK (including `@docslurp/sdk/embed`), the Astro component and the search compatibility package are MIT.
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
  `CONTRIBUTING.public.md`, `SECURITY.md` and `CODE_OF_CONDUCT.md`.
- Model weights: YOLO26 binaries are pinned in `models/weights.manifest.json`
  and fetched on first use (`scripts/fetch-model-weights.mjs`, `models/weights.py`).
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
