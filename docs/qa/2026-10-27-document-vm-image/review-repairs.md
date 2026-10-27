# Independent review repair delta

These changes follow implementation commit `543ce1a` and do not rebuild, enlarge,
publish or launch the image. Campaign `46c1f2c` is merged forward, preserving both
parents' completed-work entries; its worker/layout sources remain identical to
the tested `03aa2c4` code. The recorded OCI/archive/bundle/profile hashes stay fixed.

## Attestation admission

The original inspector verified blob hashes but did not require or bind the two
attestations. The repaired gate requires exactly one SPDX and one SLSA provenance
statement, their precise statement/predicate/layer types and predicate structure,
BuildKit sibling index reference to the selected image, and OCI artifact subject
digest/size/media type. Build metadata must identify the exported root index.
Nonempty statement subjects must match the selected image; empty statement
subjects are accepted only with verified modern OCI-artifact subject and BuildKit
index-reference binding. Legacy empty/unbound statements fail closed.

This follows [BuildKit's attestation storage format](https://docs.docker.com/build/metadata/attestations/attestation-storage/).
The actual archive uses the modern OCI artifact form: both inner statement
subjects are empty, but the attestation manifest's OCI subject and its index
annotations name the selected image. `oci-record.json` now records both bindings.
No signed-authenticity claim is made: signatures remain a separate release gate.

The gate also decompresses and hashes every rootfs layer against its diff ID,
then compares the exact ordered diff IDs, runtime config and platform to the
tested local image. Exporter metadata/index/config IDs may differ from local
image IDs; equality is established by the verified bytes and runtime settings,
not by assuming those IDs are interchangeable. Missing, duplicate, incorrectly
typed or misbound attestations, wrong metadata, changed layers/rootfs/config are
covered by synthetic archive negative tests.

## Native converter admission

The exporter now reads the approved source lock before download, checks its
immutable revision and verifies the exact source-file set and every hash **after
download but before invoking Paddle2ONNX**. Symlinks, changed bytes, extra files
and unapproved revisions are refused before native execution. It rechecks source
hashes after conversion and retains the post-export graph lock. Tests intercept
the converter and prove it is never called for tampered local or downloaded
inputs; a generated wrong graph is also refused without a provenance record.

The retained image predates this tooling repair, but its complete source/graph
hashes already match the approved lock and remain unchanged. No new export or
image build was run for this delta. A future build will record the updated
exporter hash and therefore legitimately produce a new bundle/profile identity;
operators must use that build's sealed manifest rather than reuse these pins.

## Timed-out container cleanup

Every local validation case now gets its own unpredictable owned container name.
The controller always runs bounded `docker rm -f <that-name>` in `finally`, even
when `subprocess.run` kills a timed-out Docker CLI. Cleanup failures are loud;
only a successful removal or explicit missing-owned-container response counts.
The regression uses a synthetic Docker client with a separate daemon-state marker:
timeout kills the client, cleanup removes the marker by the same unique name.
It also checks unique names and refusal to claim cleanup when the daemon is
unavailable. No live Docker or VM workload is required by these tests.

Six test methods pass, including parameterized negative cases; see
`image-integrity-tests.log`. The strengthened inspector also passes against the
**existing actual OCI archive** and tested-image inspect record. The archive hash
remains `46733e0df89522d13a14a295e9cd0749b1f692c0240a1e3d6cccd3169599b842`.
The prior 28 actual guest checks remain evidence for the unchanged packaged image;
the new timeout-controller behavior is verified by the separate regression.

The independent reviewers/coordinator must reassess this delta. No council
clearance, publication, live VM isolation proof or human merge approval is claimed.
