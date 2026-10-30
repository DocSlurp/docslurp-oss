# Embedded images with Doppler

Born-digital PDF extraction can retain embedded raster images alongside its Markdown. Request `document/media-map`, `page/embedded-image`, or `page/embedded-image-set` in `documentExtraction.enrich` with Doppler in the PDF extractor order. The winning Markdown manifest exposes `artifactGraphUri`; its artifact references resolve every image file and the media map. Assets use the document's existing tenant-scoped artifact root. The source PDF and original Markdown remain separate artifacts.

The image option runs in the **same offline VM and input upload** as Markdown extraction. A fixed `pdfimages` inventory/extraction pass and `cwebp -lossless -exact` convert the decoded pixels to lossless WebP. Byte-identical extracted PNGs are encoded once within a shard; content-hashed WebP assets deduplicate across shards while every page occurrence remains in the media map. Image bytes are never embedded in Markdown or sent to an LLM. No image inventory/encoding runs unless image enrichment is requested.

Alternatively enable strict per-extractor options:

```json
{
  "documentExtraction": {
    "order": { "pdf": ["doppler"] },
    "options": {
      "doppler": { "images": { "enabled": true, "minWidth": 100, "minHeight": 100 } }
    }
  }
}
```

`options.doppler.pdf.extractImages: true` is also supported. These options connect the previously standalone image/PDF option schemas to a runtime route. `images.enabled` defaults false; an `images` block supplies default minimum dimensions of 100×100 pixels. An enrichment target or PDF flag without an `images` block retains every image (minimum 1×1). Filtering applies to base/stencil images and retains their associated masks regardless of mask dimensions. The media map records the applied thresholds. Explicit options on non-PDF documents are ignored unless image enrichment targets are also requested, which is unsupported.

The VM image must contain `/opt/doppler/bin/pdfimages` and `/usr/bin/cwebp`. Image-enabled guests return protocol 5; an older guest cannot silently satisfy an image request. The new guest always reports protocol 5, including Markdown-only requests, and retains the protocol 4 hardening contract. The updated host accepts older guests for Markdown-only requests when their deployment declaration allows it. Deploy an immutable rebuilt guest image, then declare protocol 5 beside its digest. This feature does not deploy or change a configured image automatically.

## Representation and fidelity

`document/media-map` contains a complete page count and an ordered `images` inventory. Each occurrence has a page number, occurrence number, role, dimensions, image artifact ID and SHA-256. Page numbers are absolute across parallel shards. Image-free pages remain represented by the document page count; requesting page image sets also emits empty sets. Consumers resolve `artifactId` through the graph manifest, using existing artifact authorization. The stage records each exact child URI in the document artifact ledger; authorization remains exact-URI and existing PII withholding also covers these children.

Roles are `image`, `stencil`, `mask`, and `smask`. Masks are separately encoded lossless WebP files linked by `maskOf: {pageNumber, occurrence}`. **A base image with a soft mask is not a standalone composited transparent image.** The map retains the decoded raster components and their association. It does not retain every PDF decode/paint instruction and cannot promise reconstruction of the rendered appearance. A reused base image may have different masks on different occurrences. Deduplication does not discard those relationships. Assets used exclusively as masks have kind `page/embedded-image-mask`.

Placement fidelity is **page-only**. No bounding box, rotation or draw transform is invented. Vector drawings are not embedded raster images and are not extracted by this option. Full-page previews remain the separate `render-images` stage. Lossless conversion preserves decoded image pixels, not original JPEG compression bytes or PDF color-management instructions. Unsupported extraction formats/containers refuse the image-enabled conversion rather than drop an asset silently.

## Bounds and publication

The guest preflights at most 512 image/mask occurrences and 16 million total source pixels per shard, counts repetitions against the budget, and caps each file at 8 MiB and accumulated extracted PNG bytes at 24 MiB. The host also enforces 512 occurrences, 16 million pixels and 24 MiB unique encoded assets across the entire document. The binary frame includes Markdown and raw WebP bytes, with a 256 KiB metadata ceiling and 64 MiB total wire ceiling. Each shard gets its existing proportional output allowance; image-heavy shards can therefore refuse earlier. Missing codecs, excessive geometry, malformed assets, unexpected files, inconsistent ranges, hashes or dimensions all fail the requested job.

The host validates a simple lossless WebP container header and SHA-256; it does not decode image pixels. Guest decoding and encoding retain the existing VM, Landlock, seccomp, memory, CPU and absolute time constraints. There is no new network or credential exposure. Protocol framing accepts no archive paths. Validated image sidecars publish before Markdown success, and failed final publication cleans up the sidecar. Shard failures with requested images do not spend on a whole-document retry.

Fast mode retains explicit image preservation while continuing to disable OCR. Every image request requires a Doppler-only PDF extractor order and voting secondary; mixed routes or mixed image/non-image enrichment targets fail before dispatch. Image-only enrichment targets are supported together. Combining them with non-image enrichment targets in the Doppler image graph refuses explicitly. This avoids falling back to local PDF parsing for image requests. The extra passes and WebP conversion consume CPU and storage; no universal latency or cost saving is claimed. VM allocation usage continues through the command runner's existing usage ledger.

## Validation recorded for this change

The focused worker suites pass 99 tests, including a full `ExtractMarkdownStage.run` replay through actual candidate preparation, Markdown upload, image graph persistence, manifest publication and artifact-ledger registration. That replay mocks VM execution and storage/DB infrastructure; it does not claim a live VM integration test. Shared quality/options tests pass 53 cases. Guest range, hardening, image inventory/filter tests pass 21 cases. Worker typecheck and build pass.

Independent coordinator validation used a freshly authored three-page PDF with repeated RGB assets, a soft mask and an image-free page. Actual confined guest extraction preserved Markdown bytes and all decoded RGB/mask pixels, kept four occurrences and deduplicated two asset files. The rebuilt guest container packaging smoke also passed. Six interleaved local guest runs measured median CPU 63.865 ms without images and 100.620 ms with images; wall time 106.35 ms and 148.68 ms. These exclude live VM startup, network and storage. Unique PNG bytes were 439 versus 148 for lossless WebP on this small synthetic pattern; this is not a corpus-wide compression claim. An earlier host timing attempt excluded namespace children and is not valid CPU evidence.

Two independent reviews inspected resource/isolation and fidelity/contracts. Findings addressed: non-yielding final shard publication; preflight rejection of mixed enrichment and non-Doppler candidates; strict image option/threshold integration; Fast-mode image preservation; and a protocol-5 capability declaration. Coordinator inspection additionally identified exact-URI retrieval registration, now included in the artifact ledger. Existing file/native-artifact route scope tests supply regression evidence for the authorization boundary; they do not establish a production download. No customer documents, hosted OCR, competitor APIs, deployment or main merge were used by this change. Live VM execution and broad real-document color/mask fidelity remain unverified.
