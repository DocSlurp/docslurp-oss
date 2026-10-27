# Local document VM image preparation

This workflow builds a dedicated CPU guest image, validates its packaged programs
in restricted local containers, and exports an OCI archive, provenance and SBOM.
It never publishes images, provisions a VM or deploys the application.

```sh
export TMPDIR=/home/dan/tmp/agents TMP=/home/dan/tmp/agents TEMP=/home/dan/tmp/agents
bash scripts/document-vm/build.sh "$PWD/.cache/document-vm-image/new-build"
```

Requires an unprivileged host user with Docker/Buildx access, Python 3 and `uv`.
Set `UV=/absolute/path/to/uv` if its shell shim is not configured. Public-network
access is used only for dependencies, official pinned model weights and license
text. Validation containers have no network. The output path must be new.

- `source-lock.json`: reviewed official Apache-2.0 PP-DocLayout-S source revision,
  source/license hashes and exported graph hash; no model bytes in Git.
- `export-requirements.lock`: complete hashed Python 3.12 export environment.
- `requirements.lock`: exact hashed Linux amd64 Python 3.12 guest wheels.
- `prepare.py`: verify export/source locks and prepare a minimal image context.
- `seal.py`: verify all assets and derive the bundle/profile in the final image
  with exactly the guest's offline environment and explicit CPU arguments.
- `validate.py`: actual WebP program and layout entrypoint, synthetic images,
  identity/asset/input rejection, resource checks and local cancellation cleanup.
- `inspect_oci.py`: verify blob sizes/hashes and retain OCI manifests,
  attestations and SPDX SBOM; distinguish image manifest from Docker config ID.

The base image is digest-pinned. System packages come from Debian apt and their
installed versions/licenses are retained, but apt dependencies are not locked to
a dated snapshot. Future rebuilds can change system layers. The approved model
graph is hash-locked; an export drift requires review and a source-lock update.
The optional exporter optimizer is disabled to prevent implicit installation.

See [the local evidence and operational blockers](../../docs/qa/2026-10-27-document-vm-image/README.md).
Container success does not establish a production VM isolation boundary. A live
VM smoke, registry publication, deployment, council review and human merge
approval remain separate actions.

The coordinator-only [one-shot Modal QA runner](../../docs/qa/2026-10-27-document-vm-image/modal-smoke-runner.md)
uses the exact published image in one CPU VM with the explicitly authorized
1,800-second QA expiry. Its default mode is offline plan generation; two
independent approvals are required for execution. The implementation child only
mock-tests it. Production's 60-second executor remains unchanged.
