# Manual signing of the reviewed document VM image

`.github/workflows/sign-document-vm.yml` is a signing-only, `workflow_dispatch`-only workflow. It runs only on `DocSlurp/docslurp-oss` main while the repository is public, on the standard `ubuntu-24.04` runner, with a six-minute job limit. No checkout, build, image execution, native file parser, model job or layer extraction runs. Merging this workflow does not dispatch it.

The repository visibility was confirmed read-only through the GitHub repository API on 2026-10-27 (`visibility: public`, `private: false`). [GitHub billing documentation](https://docs.github.com/en/actions/concepts/billing-and-usage) states that standard hosted runners in public repositories are free. This does not make private GHCR package storage free or resolve any Modal image-import/storage cost limit. The workflow uploads no Actions artifacts. Registry reads are bounded to metadata and the two attestation blobs, not the image layers.

## Fixed reviewed subject

- Repository: `ghcr.io/docslurp/worker-document-vm` (private package).
- Signed image manifest: `sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21`.
- Reviewed OCI index: `sha256:fbbdd7f307ff8ccf49c3fd74e7fc448b5c4eda8878bfb1accf0920669b39b3ee`.
- BuildKit attestation manifest: `sha256:56ae2cbce81f13a687ea9eac9671c42e664c6f311caf6bf966407cedea9a4940`.
- SPDX layer: `sha256:1e0c700f7e1ae1c905962c3026f9d5cc9da07368e6c56ded0f538bad50bd511e` (2,561,186 bytes).
- SLSA layer: `sha256:c6e8969381e3820857b47dfe10f4553de5454a5a55420ff452d7bf689a434871` (23,095 bytes).

These constants and descriptor sizes come from PR #202's `docs/qa/2026-10-27-document-vm-image/oci-record.json`, the original OCI archive, and its BuildKit SPDX/SLSA evidence. This supporting PR is based on main and does not copy or modify #202's QA evidence. The workflow independently fetches and hashes the exact remote index, image manifest, attestation manifest and both statement blobs. It verifies both the attestation's OCI `subject` and the index's `vnd.docker.reference.digest` point to the fixed image. It rejects extra index entries or layers, changed sizes/digests, predicate changes and any binding mismatch before signing.

The original statement `subject` arrays are empty. Their image association is established through the verified OCI subject and BuildKit index reference, not through a fabricated statement subject. The original BuildKit build type remains `https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md`. This workflow does **not** use `actions/attest-build-provenance`, mint a replacement provenance statement, or claim the image was built on GitHub Actions. The fixed image manifest is signed; the reviewed index is checked, not separately signed.

## Certificate identity and package access

This image has a different signing identity from the lean/full worker builds:

```sh
cosign verify ghcr.io/docslurp/worker-document-vm@sha256:66a14b948cd0eca3d8ac7869e90cf8dfd5a0987508dca0b65ac0cb269952cd21 \
  --certificate-identity https://github.com/DocSlurp/docslurp-oss/.github/workflows/sign-document-vm.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The workflow uses SHA-pinned Cosign installer and Docker login actions, with Cosign pinned to v3.0.6. Its only elevated permissions are `packages: write` and `id-token: write`; `contents: read` is retained. Authentication uses the job's `GITHUB_TOKEN`. The package owner must grant this repository Actions read/write access to the private package if not already inherited. Failure to obtain registry access refuses signing; no PAT fallback is included. Registry bearer credentials are never forwarded to object-storage redirects. No credentials belong in workflow inputs, commits or logs.

A human owner must arrange the required independent reviews and approve merging this draft PR. Dispatch/signing is a separate manual decision after merge. This implementation has not been dispatched or signed an image. Passing offline tests does not prove GHCR write access, Fulcio/Rekor availability or a successful signature. A later owner-run dispatch must retain its successful exact-identity verification result before treating the signature release blocker as resolved. Image import, live VM smoke and their budgets remain separate operational gates.

Validation: `node --test scripts/sign-document-vm-workflow.test.mjs` executes the exact inline verifier with mocked registry data and transport, including negative digest, binding, predicate, redirect and response-limit cases. The signing workflow itself is never executed by these tests.
