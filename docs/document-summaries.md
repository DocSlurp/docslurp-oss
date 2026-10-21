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

Short documents keep their full text when it fits the 10,000-byte UTF-8 evidence
budget. Extraction prepares a small evidence artifact from text it already has;
this does not create page summaries or invoke another parser or model. With verified
page boundaries, it selects up to ten pages: the first three (identity/contents),
the final page, and seeded samples spread across the remainder. Retries select the
same pages. Exact repeated dense rows are removed while prices and codes remain
distinct. Page positions and clipped-page flags accompany the excerpts.

The default budgets come from a small pilot: 150 non-reasoning generations had no
truncation, with a maximum of 212 output tokens. A 16-call refinement retained the
catalog identity in every output using 10,000-byte evidence. The corpus contained
two related real catalogs and three synthetic short documents; these results do
not establish universal optima or search-quality gains.

- Selected evidence is at most **10,000 UTF-8 bytes**, including page labels.
  Its version-bound JSON artifact is at most **12,000 bytes**, including metadata
  and escaping. The summary stage reads that artifact rather than the full text.
- Existing artifacts without this evidence use at most **10,000 bytes** of text
  in four spread byte ranges. A legacy pointer manifest may add at most **4,000
  bytes**. No PDF reparse fallback is permitted. Page references are explicitly
  unavailable when the extractor cannot verify boundaries.
- One document-level generation call allows at most **256 output tokens**, even
  when a workspace requests a larger output limit. Reasoning defaults to `none`
  for summaries; explicit workspace/task reasoning settings still apply.
  Provider-specific minimum reasoning settings remain respected.
- Empty or token-truncated output is recorded as a skipped summary, with its
  generation usage retained; it is not embedded or indexed. Sampled summaries
  receive a deterministic coverage notice even if the model omits one.
- At most **four summaries run concurrently per activity**, respecting lower
  document-concurrency settings. Worker/provider limits also apply across activities.
- A **120-second abort deadline** still bounds reads, generation and embedding.
  This is a safety guard, not a calibrated latency target: the pilot measured
  generation alone (median 1.79 s, maximum 3.55 s), without storage, embedding or load.
  An exhausted run cost cap stops new summaries; in-flight calls may still incur cost.

Unavailable extracted text or oversized legacy manifests produce a recorded skip.
Range responses are validated while streaming. Evidence is bound to the current
document ID and Markdown artifact URI; stale or invalid evidence fails validation.
Summary artifacts and stage statistics retain source size, bytes read, selected
input bytes, page coverage and whether the evidence was sampled. Omitted pages are
unknown; the model is not asked to invent their contents.

Workspace overview context has a separate size budget and uses current,
non-superseded documents. Missing summaries and documents omitted by that budget
are disclosed as partial coverage. A workspace overview is generated on request;
this feature does not add a background full-corpus synthesis job.

These are topic overviews, not exhaustive catalog extraction or a version diff.
A rare change outside sampled text can be missed. Use document retrieval or
structured extraction for exact prices, product records and version comparisons.
The limits above constrain summary work; they do not replace ingestion limits
for parsing, OCR, page indexing or storage.
