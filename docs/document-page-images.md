# Page images in citations

Opening a PDF citation shows its cited page in the page reader. Existing images load immediately. For native PDFs that have text but no page images, the reader requests only the selected page and shows the excerpt while that image renders. Arrow keys and Home/End navigate pages; Escape closes the reader and returns focus.

Rendering needs a completed PDF with a retained source, a known page count, workspace edit access and available interactive credits. Read-only users can view existing images. Withheld originals are never recreated as unredacted images. Unsupported files or unavailable sources retain an excerpt and, when permitted, an original-file link.

The reader waits for up to about one minute. If rendering takes longer, reopening the page retries; a previously completed image is reused. A busy queue or service failure leaves the document and excerpt usable.

## Internal browser endpoint

`POST /v1/documents/:documentId/pages/:pageNumber/image` requests a page; `GET` checks the result without starting work. Both authorize the document before returning cached artifacts and use private, non-cacheable responses. The POST uses session authentication and workspace edit permission; it is not an API-key mutation endpoint.

- `200`: a ready artifact, using the existing authenticated file URL.
- `202`: pending; poll GET after the `Retry-After` interval.
- `429`: the organization's render queue is full; retry later.
- `404`: missing page/document or insufficient scoped access.
- `409`: the source is not eligible for rendering.
- Spend denial uses the standard billing error response.

## Operations

Workers consume the `docslurp-page-render` Temporal queue with two activity slots per worker. Durable demand wakes workers through the existing autoscaler. Each organization can have eight active page requests; demand expires after ten minutes, and workflow execution is limited to five minutes. These limits bound concurrency, not total organization spending.

The worker uses the sandboxed PDF raster cache, rechecks source/privacy eligibility before publication, and atomically stores the page-artifact reference and its scoped usage receipt. Stable receipt IDs prevent duplicate charges on activity replay. No model call is needed. Inspect the `worker-page-render` usage metric, Temporal workflow failures and `document_page_renders` demand when investigating a missing image.


## Resolution and export

New reader rasters default to 120 DPI for every account. Existing authorized canonical or reader images are reused rather than rendered again for a downgrade; their DPI may be unknown. An explicit Sharper image or PNG export requests 250 DPI, for every organization: resolution never depends on what an organization has bought. Each render is local compute recorded as a `worker-page-render` usage event. No intermediate 200-DPI demand tier is introduced. The original PDF link retains vector quality.

Both native and Poppler paths inspect page dimensions before raster allocation. Resolution is reduced when needed to stay within a 4096-pixel long edge and 16 million pixels; an unknown or invalid page size fails closed. Poppler renders the same CropBox measured by `pdfinfo`, rather than the potentially much larger MediaBox. Both paths also receive an independent preallocation long-edge cap of at most 4000 pixels (4000² = 16 million), so the pixel-product limit remains safe even if geometry, rotation or UserUnit interpretation differs. Normal pages retain their requested resolution below this cap. Native adapters must honor `maxEdgePx` before allocating raster memory; the optional native binary must be validated separately from adapter-double tests. Raster cache keys are versioned independently from ingestion-era pixels.

Add `?quality=reader` (default) or `?quality=export` to the image endpoint. GET remains read-only; POST requires a session and workspace edit access, including cached responses. Reader/export demand rows, workflow IDs, artifact slots and deterministic compute receipts include effective DPI; version 3 identities cannot mistake a cached 120-DPI export for a 250-DPI one. GET and POST ready/pending responses include `capabilities: { sharperImage, exportDpi }`; known-policy images include `dpi`, while reused legacy images omit it. Both qualities share the existing eight-request organization limit and two activity slots. Migration 0077 adds the demand quality key; 0079 adds DPI (120/250) to its primary key, retaining existing demands conservatively at 120. The worker validates the document-owned policy independently, including before publication. The worker accepts only the two policy resolutions (120 for readers, 250 for exports) and fails any other combination nonretryably. Exact DPI cleanup cannot erase another active quality tier. Reader publication also updates the canonical page slot so existing citations continue to work; export artifacts are excluded from ordinary preview-page enumeration.

Reader renders are stored as lossless WebP when the worker has `cwebp`: `image/webp`, the same pixels as the PNG render, roughly half the bytes, encoded at effort 1 to keep latency low. Export renders stay PNG. PNG pages stored earlier, or during a `cwebp` outage, stay PNG. Clients should use the artifact's content type rather than assume PNG.

Browser export fetches and validates the renderer's PNG bytes before downloading them. It never captures the DOM. Native image documents retain their existing preview and original-file link; this export endpoint is for completed PDFs.

### Rollout order

Apply migration 0079 before starting the new renderer. Upgrade and verify **all**
workers polling the page-render task queue before enabling the new API/UI policy;
drain or stop old workers first. Old workers ignore the approved DPI argument,
use the previous render policy and delete demand by quality alone. Do not run
mixed old/new page-render consumers against newly admitted DPI-specific jobs.
The manual production deployment upgrades workers before the API and verifies
worker readiness; confirm every page-render consumer uses the new image, and
check queued/in-flight page renders, before advancing the API/UI. Demand expires
after ten minutes as a fallback, so retained legacy rows do not need deletion.
