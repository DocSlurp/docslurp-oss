# Document and workspace summaries

New workspaces default to `summaries: true`. This generates one reusable summary
per document during ingestion. Summaries improve document search: the document
index matches query text against summaries as well as filenames, and workspace
overview answers can use the stored summaries instead of rereading whole files.
This option does not create page-level summaries or per-page model calls.

```json
{
  "name": "Product catalogs",
  "summaries": true
}
```

Use this body with `POST /v1/workspaces`. To disable future generation, send
`{"summaries": false}` to `PATCH /v1/workspaces/:id`, or use the SDK:

```ts
await client.updateWorkspace("catalogs", { summaries: false });
```

Workspace responses expose the effective `summaries` value. The setting uses the
existing `pipeline.summarize` storage and run snapshot; there is no second copy of
the setting. On creation, `summaries` defaults to true and takes precedence over
`pipeline.summarize`. On update, an omitted `summaries` leaves the pipeline's value
unchanged. Template locks still win, including the legal and medical templates
that disable hosted summaries for privacy. Existing workspaces retain their saved
setting. Disabling generation does not delete summaries already created.

## Cost and existing documents

Summary generation and embedding add a **one-time processing cost per document
version**, rather than regenerating the document summary on every search. A
completed stage checkpoint reuses its output on resume. New versions, explicit
reprocessing, backfills or failed attempts can incur additional calls and costs.
Workspace overview synthesis still has the normal chat-generation cost.

Enabling summaries for an existing workspace affects new uploads. To also process
existing documents, use `{"summaries": true, "apply": "reindex"}`. Recommended
backfills also follow the workspace's existing `autoConfirmReindex` setting.
Use `POST /v1/workspaces/:id/estimate` with the same body to estimate work first.
See [config-change jobs](config-change-jobs.md).

The worker uses the configured `document-summary` text model, with the shared
lightweight text-model default when no override is set. See
[model configuration](model-configuration.md). Generation and embedding usage
are recorded separately. Privacy restrictions and provider rate limits apply.

## Bounded work for large collections

Short documents are kept intact when they fit in 24,000 characters. For larger
documents, deterministic selection retains a sampled heading outline and excerpts
spread across the text, including its beginning and end. Exact repeated dense
rows are removed from long inputs. Different prices and product codes are not
normalized away, and near-duplicate versions are not assumed interchangeable.

Limits are independent of a document's page count:

- Read at most **256 KiB of extracted text** per document. Larger artifacts use
  16 sequential byte-range reads spread across the object. A pointer manifest
  may add at most 64 KiB. The summary stage never downloads or reparses a PDF.
- Supply at most **24,000 characters** of selected evidence to one document-level
  generation call, with at most **512 output tokens**, including when a workspace
  requests a larger output limit.
- Process at most **four summaries concurrently per activity**, also respecting
  lower document-concurrency settings. Worker activity concurrency and provider
  rate limits bound concurrency across activities; this is not a global cap of four.
- Apply a **120-second abort deadline** to source reads, generation and embedding.
  An exhausted configured run cost cap stops admitting further summaries; calls
  already in flight can still finish and incur cost.

If extracted text is unavailable or its pointer manifest exceeds the limit, the
stage records a skipped-summary reason instead of launching another parser. Range
responses are validated and counted while streaming; an endpoint that ignores
the requested range cannot cause an unbounded download into memory. Summary
artifacts and stage statistics record bytes read, source size, input characters
and whether the input was sampled.

Workspace overview context has a separate size budget and uses current,
non-superseded documents. Missing summaries and documents omitted by that budget
are disclosed as partial coverage. A workspace overview is generated on request;
this feature does not add a background full-corpus synthesis job.

These are topic overviews, not exhaustive catalog extraction or a version diff.
A rare change outside sampled text can be missed. Use document retrieval or
structured extraction for exact prices, product records and version comparisons.
The limits above constrain summary work; they do not replace ingestion limits
for parsing, OCR, page indexing or storage.
