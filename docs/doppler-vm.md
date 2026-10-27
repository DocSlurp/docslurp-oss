# Doppler PDF extraction

The optional `doppler` document extractor runs a fixed native PDF-to-Markdown command in a fresh Modal **VM** per document. The open-source core contains only the generic adapter and guest entry point. A private deployment supplies the licensed native binaries and immutable image; no proprietary engine source or binary is included here.

Set `DOCSLURP_PDF_EXTRACTOR=doppler` to choose it for PDFs without an explicit workspace extractor order. Set `DOCSLURP_DOPPLER_VM_IMAGE` to a registry image **digest**, `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` on the worker control host, and optionally `DOCSLURP_DOPPLER_REGISTRY_SECRET` to the name of a Modal secret containing only registry pull credentials. Registry credentials are passed to image resolution, never mounted into the guest. The API advertises the capability only when `DOCSLURP_DOPPLER_INSTALLED=1` is configured on the API host.

Unavailable images, credentials or VM capacity fail visibly. There is no Doppler-to-local-parser fallback. Explicit workspace extractor orders, voting and enrichment remain explicit user choices. A successful empty one-page result is valid, so scans remain eligible for the existing OCR/vision routing; Doppler does not itself perform OCR.

## Boundary and limits

- VM runtime is mandatory; network and OIDC identity are disabled, with no guest secrets, volumes or bucket mounts.
- One regular, no-follow input, at most 64 MiB; one bounded Markdown output, at most 64 MiB. XML intermediate at most 256 MiB.
- Half a physical CPU core reserved, burst limit one core, 1 GiB VM memory; parser address space 768 MiB. Absolute control deadline 60 seconds and bounded cleanup. Late-created VMs are terminated and uncertain allocation is conservatively recorded as a full-lifetime estimate.
- Output is staged locally and atomically published only after VM teardown succeeds. SDK errors and parser-controlled error text are not exposed.
- The guest receives no user-defined command, environment, URL or flag. `-compact-layout` rounds word coordinates to 0.001 point, retaining text and metadata; tables and rules remain enabled.

This isolates **the Doppler extraction command**, not the entire existing ingestion pipeline. Existing page-facts probing, rasterization and other opt-in stages retain the known host-isolation gap tracked in `TODO.md`. Doppler results skip implicit native shadow extraction and native parser enrichment, avoiding redundant host parsing. Do not claim whole-pipeline VM isolation.

## Accounting and rollout

VM allocation is a separate scoped usage-ledger event. The recorded cost uses the one-core ceiling conservatively; metadata also records the half-core reservation floor. Its USD estimate uses published Modal sandbox CPU/memory rates observed 2026-10-27, not a bill; image import, storage, egress and regional premiums are excluded. Pending creation without an acknowledgement records conservative maximum-lifetime exposure. Provider estimates are nonbillable to users until the existing pricing policy assigns charges.

The private app owns binary provenance, hashes, image construction and manual deployment. Merge this reviewed core dependency first, then update the app's pin to that merged main SHA. A successful local container smoke check is packaging evidence, **not** evidence of VM isolation. Validate live VM availability and the registry pull credential before enabling the default. Keep security-sensitive PRs draft until two independent council reviews are reconciled and a human owner approves merge.
