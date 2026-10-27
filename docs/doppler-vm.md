# Doppler PDF extraction

The optional `doppler` document extractor runs a fixed native PDF-to-Markdown command in a fresh Modal **VM** per document. The open-source core contains only the generic adapter and guest entry point. A private deployment supplies the licensed native binaries and immutable image; no proprietary engine source or binary is included here.

Set `DOCSLURP_PDF_EXTRACTOR=doppler` to choose it for PDFs without an explicit workspace extractor order. Set `DOCSLURP_DOPPLER_VM_IMAGE` to a registry image **digest**, `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` on the worker control host, and optionally `DOCSLURP_DOPPLER_REGISTRY_SECRET` to the name of a Modal secret containing only registry pull credentials. Registry credentials are passed to image resolution, never mounted into the guest. The API advertises the capability only when `DOCSLURP_DOPPLER_INSTALLED=1` is configured on the API host.

Unavailable images, credentials or VM capacity fail visibly. There is no Doppler-to-local-parser fallback. Explicit workspace extractor orders, voting and enrichment remain explicit user choices. A successful empty one-page result is valid, so scans remain eligible for the existing OCR/vision routing; Doppler does not itself perform OCR.

## Boundary and limits

- VM runtime is mandatory; network and OIDC identity are disabled, with no guest secrets, volumes or bucket mounts.
- One regular, no-follow input, at most 500 MiB (shared with API admission); one bounded Markdown output, at most 64 MiB. Sources above 8 MiB use a private bounded disk snapshot and streaming upload, avoiding a document-sized host buffer.
- Half a physical CPU core reserved, burst limit one core, 1 GiB VM memory; parser address space 768 MiB. Absolute control deadline 180 seconds and bounded cleanup. Late-created VMs are terminated and uncertain allocation is conservatively recorded as a full-lifetime estimate.
- Output is staged locally and atomically published only after VM teardown succeeds. SDK errors and parser-controlled error text are not exposed.
- The guest counts pages and extracts consecutive ranges of at most 32 pages (at most 10,000 pages/document), reuses a 256 MiB-bounded XML intermediate, and merges Markdown with form-feed page slots, including blanks. A failed chunk fails the whole document; no partial output is published. The guest has a 150-second total wall budget and 45-second per-command ceiling. Layout uses each chunk’s body-font context. Repeated furniture must meet the full document’s repetition threshold; this conservatively retains some headers rather than dropping section labels in short tail chunks. Long-document output can therefore differ from whole-document reconstruction.
- The guest receives no user-defined command, environment, URL or flag. `-compact-layout` rounds word coordinates to 0.001 point, retaining text and metadata; tables and rules remain enabled.

This isolates **the Doppler extraction command**, not the entire existing ingestion pipeline. Existing page-facts probing, rasterization and other opt-in stages retain the known host-isolation gap tracked in `TODO.md`. Doppler results skip implicit native shadow extraction and native parser enrichment, avoiding redundant host parsing. Do not claim whole-pipeline VM isolation.

## Accounting and rollout

VM allocation is a separate scoped usage-ledger event. The recorded cost uses the one-core ceiling conservatively; metadata also records the half-core reservation floor. Its USD estimate uses published Modal sandbox CPU/memory rates observed 2026-10-27, not a bill; image import, storage, egress and regional premiums are excluded. Pending creation or unconfirmed termination records conservative maximum-lifetime exposure and uncertainty metadata. Provider estimates are nonbillable to users until the existing pricing policy assigns charges.

The private app owns binary provenance, hashes, image construction and manual deployment. Merge this reviewed core dependency first, then update the app's pin to that merged main SHA. A successful local container smoke check is packaging evidence, **not** evidence of VM isolation. Private deployments can preimport the digest-pinned image during CI and set `DOCSLURP_DOPPLER_MODAL_IMAGE_ID` to its immutable Modal ID. The worker then resolves that ID without registry credentials; a failed lookup never falls back to registry/local parsing. The digest remains mandatory provenance. Validate the exact production adapter against the imported image before enabling the default. Keep security-sensitive PRs draft until two independent council reviews are reconciled and a human owner approves merge.
