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
