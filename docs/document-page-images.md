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

The selected reader page requests a 200 DPI lossless PNG, even when ingestion or an older reader already cached a 120/150 DPI image. Only opening a page upgrades it; no neighbouring pages are rasterized. An explicit export requests the exact selected page at up to 300 DPI. The original PDF link retains vector quality.

Both native and Poppler paths inspect page dimensions before raster allocation. Resolution is reduced when needed to stay within a 4096-pixel long edge and 16 million pixels; an unknown or invalid page size fails closed. Raster cache keys are versioned independently from ingestion-era pixels.

Add `?quality=reader` (default) or `?quality=export` to the image endpoint. GET remains read-only; POST requires a session and workspace edit access, including cached responses. Reader/export demand rows, workflow IDs, artifact slots and deterministic compute receipts are distinct. Both qualities share the existing eight-request organization limit and two activity slots. Migration 0077 adds the demand quality key. Reader publication also updates the canonical page slot so existing citations continue to work; export artifacts are excluded from ordinary preview-page enumeration.

Browser export fetches and validates the renderer's PNG bytes before downloading them. It never captures the DOM. Native image documents retain their existing preview and original-file link; this export endpoint is for completed PDFs.
