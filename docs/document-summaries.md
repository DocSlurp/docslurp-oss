# Document and project summaries

New projects default to `summaries: false`. Turning summaries on generates one
reusable summary per document during ingestion, priced per document. Summaries
improve document search: the document
index matches query text against summaries as well as filenames, and project
overview answers can use the stored summaries instead of rereading whole files.
This option does not create page-level summaries or per-page model calls.

```json
{
  "name": "Product catalogs",
  "summaries": true
}
```

Use this body with `POST /v1/projects`. To turn generation on or off later, send
`{"summaries": true}` or `{"summaries": false}` to `PATCH /v1/projects/:id`, or use the SDK:

```ts
await client.updateProject("catalogs", { summaries: true });
```

Without summaries, a new project takes its title from the first document's
headings, and project overview answers fall back to ordinary search.

Project responses expose the effective `summaries` value. The setting uses the
existing `pipeline.summarize` storage and run snapshot; there is no second copy of
the setting. On creation, `summaries` defaults to false and takes precedence over
`pipeline.summarize`. On update, an omitted `summaries` leaves the pipeline's value
unchanged. Template settings still win: the financial-reports and meeting-notes templates
turn summaries on, and the legal and medical templates lock hosted summaries off
for privacy. Existing projects retain their saved
setting. Disabling generation does not delete summaries already created.

## Cost and existing documents

Summary generation and embedding add a **one-time processing cost per document
version**, rather than regenerating the document summary on every search. A
completed stage checkpoint reuses its output on resume. New versions, explicit
reprocessing, backfills or failed attempts can incur additional calls and costs.
Project overview synthesis still has the normal chat-generation cost.

Enabling summaries for an existing project affects new uploads. To also process
existing documents, use `{"summaries": true, "apply": "reindex"}`. Recommended
backfills also follow the project's existing `autoConfirmReindex` setting.
Use `POST /v1/projects/:id/estimate` with the same body to estimate work first.
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
  when a project requests a larger output limit. Reasoning defaults to `none`
  for summaries; explicit project/task reasoning settings still apply.
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

Project overview context has a separate size budget and uses current,
non-superseded documents. Missing summaries and documents omitted by that budget
are disclosed as partial coverage. A project overview is generated on request;
this feature does not add a background full-corpus synthesis job.

These are topic overviews, not exhaustive catalog extraction or a version diff.
A rare change outside sampled text can be missed. Use document retrieval or
structured extraction for exact prices, product records and version comparisons.
The limits above constrain summary work; they do not replace ingestion limits
for parsing, OCR, page indexing or storage.

## Adaptive summary and labels (`DOCSLURP_SUMMARY_SCAN`)

Off by default (unset and unknown values are off). The summary stage normally makes one model call over at most ten
sampled pages and 10 KB. With `DOCSLURP_SUMMARY_SCAN=on`, a document that has more pages than that sample, verified page
references and a page offset index gets a short read loop instead:

- The first call reads the same evidence as today and returns the whole result: a document type, up to six topics and
  the summary.
- Each later call reads ten further pages, spread across the unread pages (plus pages the model asks for, within the
  loop's limits), and reports only what those pages add: whether they fit the result so far, their own type, up to
  three new topics and one sentence.
- Code merges the reports. The first call's type stands unless at least two later calls, and at least half, say their
  pages do not fit, which makes the document `mixed`. New topics follow the first call's, and each sentence is appended
  to the summary. A later call can extend the result but never replace it.
- The loop stops when two later calls in a row add nothing, when the model says more pages would not change the result
  (after two calls for documents over 200 pages), or at a limit: six model calls in all, a small cost and token cap,
  the summary deadline.

A document whose evidence already holds every page gets one call with the first call's prompt, so it is labelled too.
Every call's tokens and cost are reported as `summary-generation` usage, and the document's one summary unit is recorded
once. The per-document summary charge stays one. When the scan read more pages than the evidence, the "Sampled document
overview" notice and the stored page coverage count the pages it read.

Every other document (no index, unverified pages, text files, a larger document whose pages were redacted for PII) keeps
the single call and the same prompt, and so does any document whose first call returns an unusable reply. A failed later
call or page never fails the document: everything merged so far is stored. `summaries/<documentId>.json` gains two
optional fields, `labels` (`docType`, `topics`) and `scan` (`steps`, `stoppedBy`, `pagesRead`, `pagesTotal`); readers
that do not know them ignore them. Document text, topics and summaries are never logged or traced by this path.

## Summary tree: section summaries for long documents

A project that turns the summary tree on gets, for each long document, summaries
of its contiguous sections and one root summary for the whole document. The
summaries are a derived search index: they live in the project's `summaries`
LanceDB table beside `chunks`. This section covers how the tree is built.
Settings, the kill switches and the state block are in
`packages/shared/src/summary-tree.ts`; deletion is in
[data deletion](data-deletion.md#the-summary-trees-table). The document summary
is replaced by the complete tree root when the tree becomes ready, in the same
transaction as readiness. Partial or skipped trees keep the earlier document
summary. The original sampled stage artifact remains historical evidence; API,
chat overview and naming readers use the updated `document_summaries` row.

### When the stage runs

`summary-tree` is the last stage of a run, after `index`. A document is
searchable before its tree is built, and no stage that makes it searchable reads
the tree.

The stage runs only when all three hold (`summaryTreeBuildActive`):

- the project stores `pipeline.summaryTree.enabled: true`;
- the pipeline embeds and indexes vectors;
- the deployment sets `DOCSLURP_SUMMARY_TREE_BUILD=on`.

Otherwise it reads nothing, writes nothing and makes no model call. The switch is
asked again before every model call, so turning it off stops a build at its next
call.

**The project's setting is the stored one, never a snapshot.** A run's pipeline
is a snapshot, and reprocess, bulk reprocess, retry, the re-index after a
settings change and indexing-mode switches all start from a stored one. The API
therefore writes the project's stored `summaryTree` into every run's pipeline
when the run row is written or rewritten
(`server/src/services/run-summary-tree.ts`), whatever the source carried, and
the stage reads the project's stored setting again before each document
(`projectSummaryTreeEnabled`). A project that turned the tree off builds
nothing more: not on a replayed run, and not for the remaining documents of a
run that is already in progress (`summaryTreeStatus: off`, reason
`project-setting-off`). A project with the tree on always re-runs this stage in a partial
reprocess: summary rows belong to one document version and are never copied from
another.

### What a build does

1. **Format skip.** Decided from the file alone (see [skip rules](#skip-rules)).
2. **Scan the embed artifact.** One streamed pass over
   `<run root>/embeddings/<documentId>.json`. Per leaf it keeps the chunk index,
   heading path, pages, the leaf hash and the cosine similarity to the previous
   leaf. Vectors are dropped as they pass; leaf text goes to a temporary file
   and is read back one group at a time.
3. **Select leaves.** A leaf is a chunk with `overlapIndex` 0 and no row or cell
   table granularity. Whole-table chunks count toward the table share and are
   then left out.
4. **State row.** `document_summary_trees` is set to `building` before anything
   else is written.
5. **Level by level.** For each new layer of nodes: reuse what can be reused,
   call the model for the rest, embed the new summaries with the project's
   embedding model, write registry rows and summary rows.
6. **Compact** the text artifact to one object.
7. **Coverage invariant**, read back from Postgres: every leaf lies in exactly
   one level-1 group, every node but the root has exactly one ready parent above
   it, no row is unfinished.
8. **`ready`**, or **`partial`**. Search serves a document's nodes only while its
   row is `ready`.

What is committed when:

- A summary's text is written to the artifact as its own immutable part the
  moment its model call returns. A build killed after N calls and started again
  makes exactly total − N calls.
- Registry rows and summary rows are written once per window of at most
  `WORKER_SUMMARY_TREE_CONCURRENCY` model calls (default 4): one embedding
  request and one table commit per window. A kill between a part and its window
  costs an embedding request on resume, never a model call.
- A registry row is written (`pending`) before its summary row and set `ready`
  after it, so a row in the table always has a registry row naming it.

### Grouping

Sizes are counted in leaves, never tokens. The values are the server constants
in `packages/shared/src/summary-tree.ts`.

Leaf groups:

1. A section is a run of adjacent leaves with the same heading path. A section
   over the maximum is cut at its lowest adjacent-similarity boundaries; each
   piece keeps at least the minimum. Only relative minima decide, never a fixed
   threshold.
2. A group under the minimum joins a neighbour, deepest headings first: inside
   each heading, in document order, two adjacent groups become one when at least
   one is under the minimum and together they fit the maximum. What is still
   small is offered to its neighbours inside the parent heading, and so on up to
   the document. A short section therefore joins its sibling sections before
   anything further away, and crosses a parent heading only when nothing nearer
   fits. A group that fits nowhere stays small.

Rule 2 is a deliberate change from the original plan, which never merged a short
section across a heading. The phase-0 eval measured 340 of 1,067 leaf groups
holding a single chunk under that rule, each a model call that restates one
chunk ([report](evals/summary-tree/phase0-2026-11-14.md), finding 9).

Upper levels:

- Neighbours with the same heading path form a run. A run of at least the
  minimum fan-in gets a parent, unless it and its neighbours inside the heading
  one level up would fit one parent together: then it waits for them. A smaller
  run gets no parent of its own and joins its parent heading's siblings.
- When no run gets a parent, the deepest paths lose their last segment and runs
  are formed again.
- A run over the maximum fan-in is cut by the similarity of the siblings'
  summary vectors.
- Depth never passes `SUMMARY_TREE_MAX_LEVELS`. A layer shaped by headings is
  taken only if the layers left after it would still suffice; otherwise the
  whole frontier is cut by similarity, and at the last level whatever remains
  goes under one root.

No node has exactly one child, and a deeply nested outline does not grow a chain
of near-identical summaries (the eval measured a nine-level tree whose top five
levels held one node each).

### Skip rules

A skipped document gets a state row with `status: skipped` and the reason; the
stage stats carry the finer detail and the counts. Nothing is skipped silently.

| `skip_reason` | Detail in stats (`summaryTreeSkipDetail`) | When |
| --- | --- | --- |
| `format` | `spreadsheet-format`, `structured-data-format` | `office-excel`, `structured-csv`, `structured-json` |
| `media` | `audio-video` | audio or video, by format or MIME type |
| `short` | `chunk-count-below-floor`, `below-long-document-floor` | fewer leaves than `SUMMARY_TREE_MIN_DOCUMENT_LEAVES`. With a stored chunk count under the floor the artifact is not read |
| `tables` | `table-heavy` | more than `SUMMARY_TREE_MAX_TABLE_LEAF_SHARE` of the leaves are tables |
| `no-leaves` | `no-leaves`, `no-embedding-artifact` | nothing to summarize |
| `pii` | `pii-blocked` | the document is blocked by the PII policy |
| `corrected` | `corrected` | a correction reindex replaced the document's chunks (below) |

A document that had a tree and no longer qualifies loses its summary rows and
registry rows when the skip is recorded.

**Corrected documents have no tree.** A build reads the run's embed artifact. A
correction reindex (`POST /v1/documents/:docId/correction-workbench/reindex`)
replaces
the document's chunks in Postgres and leaves that artifact as it was, so a tree
built after the correction would summarize the text from before it, and its
chunk ranges would name chunks that no longer exist. In the transaction that
replaces the chunks, the API therefore:

- sets the document's tree state to `skipped` / `corrected`, creating the row
  when the document had none (the worker's database role cannot read
  corrections; this row is how a build knows);
- deletes its registry rows;
- queues strict removal of its summary rows and text artifact
  (`storage_cleanup_queue`, kind `summary_tree_document`).

No build replaces a `corrected` row: the stage and the backfill skip the
document without reading anything, and a build that was running is refused at
its next write (`refused`, `document-corrected`), including the `ready` write
itself. Search also refuses the tree of any document with a completed correction
reindex, whatever its state row says. The document gets a tree again when a new
version of it is processed.

A correction completed by a server instance that predates this (during a rolling
deploy) leaves no mark. The API's maintenance sweep
(`summary-tree-corrected-reconcile`) finds corrected documents without it and
does the same three things for each, under the document's row lock. It is
idempotent, runs on the first sweep after start, and then every ten minutes
while there is nothing to do.

A queued removal carries the document's build generation
(`document_summary_trees.build_generation`, raised by every build that takes
the document) at the time it was asked for. A tree of a later generation was
rebuilt after the request: while a build is still writing it the sweep waits;
once it is `ready` the sweep keeps its rows, registry and own artifact folder
and strictly prunes the table's older versions instead, so what the removal was
asked about still leaves storage. An unfinished later build is removed with the
rest.

### Statuses

`document_summary_trees.status`:

| Status | Meaning | Served |
| --- | --- | --- |
| `pending` | A build was refused before any call (`error` says why: an organization that may not spend, privacy mode, no model key) | No |
| `building` | A build is running (`build_owner` names it and it touches `updated_at`), or was interrupted and will resume | No |
| `partial` | The build ended without a servable tree; `error` names the reason | No |
| `ready` | The coverage invariant held | Yes |
| `skipped` | The document gets no tree (`skip_reason`) | No |

`partial` reasons:

- `group-failed:<reasons>`: a group still failed after one retry. Reasons:
  `content-refusal`, `truncated-output`, `invalid-output:<detail>`,
  `prompt-too-large`, `model-error`, `leaf-text-mismatch`.
- `stopped:build-switch-off`, `stopped:run-cost-cap`,
  `stopped:stage-time-budget`, and from the backfill job `stopped:cost-cap`,
  `stopped:cancelled`, `stopped:lease-lost`: the build stopped before its next
  call.
- `stopped:credit_exhausted`, `stopped:org_budget_paused`,
  `stopped:project_budget_paused`, `stopped:run-paused`,
  `stopped:run-cancelled`, `stopped:project-setting-off`: refused between two
  commit windows (the organization may no longer spend, the run was paused or
  cancelled, the project turned the tree off).
- `node-cap`: the document needs more nodes than its cap. The cap scales with
  the document (`summaryTreeNodeCap`: `SUMMARY_TREE_MAX_NODES_PER_LEAF` nodes a
  leaf, at least `SUMMARY_TREE_BASE_NODES_PER_DOCUMENT`, at most
  `SUMMARY_TREE_MAX_NODES_PER_DOCUMENT`), so a 20,000-page document fits it.
  It bounds tree shape, not spend: spend and time are bounded by the caller's
  cost cap and time budget. Refused before any call.
- `coverage:<checks>`: the invariant did not hold.
- `embedding-space-mismatch`, `leaf-vectors-unusable`: the embed artifact is not
  in the project's embedding space, or a leaf has no usable vector.
- `error:<ErrorName>`, `stopped:aborted`: the build threw (a storage or database
  failure, a cancelled activity). The row is written `partial` before the error
  reaches the caller, so the document does not sit in `building` until the
  staleness rule finds it; only the error's name is stored. A worker that dies
  outright still leaves `building`, which the staleness rule covers.
- `pii-withheld`, `rows-removed`: the tree was withdrawn (the PII policy blocked
  or redacted a document that already had one; a queued removal deleted its
  rows).

The stage's own checkpoint is `completed` in every case above: a `partial` or
`blocked` tree never fails the document or the run. The stage stats
(`summaryTreeStatus`) add three outcomes that write no tree: `off` (the switch),
`blocked` (state row `pending`) and `refused` (the document is not a live
document of the run's organization and project: `document-not-live`; or it was
corrected while the build ran: `document-corrected`).

A later build of a `partial` or `building` document resumes: it pays only for
the groups that have no stored text, and for the levels above them.

### What search may read, and when

Search serves a document's nodes only while its state row is `ready` for the
document's current run and the project's embedding space, with `built_at` set,
and the document has no completed correction reindex.
The build keeps that true at every step:

- Summary rows are written before the row turns `ready`, with the document's
  run id, and each row's id is its registry row's id.
- A rebuild leaves `ready` before it removes or replaces a row. That includes a
  rebuild with other settings or another embedding space, and a document that
  no longer qualifies: both wipe the earlier tree, and both write `building`
  first.
- `built_at` is set only by a `ready` write, so a rebuild always carries a later
  one.

`server/src/__tests__/summary-tree-build-search.db.test.ts` runs the real build
and then the real search leg against one database and one LanceDB directory.

### Who is building a document

A `building` row names its builder in `build_owner` (`run:<runId>` for a run's
own stage, `job:<jobId>#<claim>` for the backfill job) and the build touches
`updated_at` at every commit and at least every 30 seconds.

- A row not touched for `SUMMARY_TREE_BUILD_STALE_MS` (10 minutes) was left by a
  worker that died. It blocks nothing: any build takes it over, and the project
  state counts it as `partial`, not `building`.
- A run's own stage always takes its document's row (its retry after a crash
  must not wait). The backfill job leaves a row another builder still reports
  on, and comes back to it in a later job.
- A build whose row was taken stops at its next commit and writes no outcome.

One stage activity starts model calls for at most
`WORKER_SUMMARY_TREE_STAGE_BUDGET_SECONDS` (default 20 minutes), so an optional
index never times a run out. Past the budget the document in progress ends
`partial` and documents not yet started are left without a tree state
(`blocked`, `stage-time-budget` in the stage stats); both are finished by a
later build.

### Model calls and spend

- Text operation `summary-tree`, model from the project's text model chain.
  Reasoning is fixed at the lowest effort; the project's reasoning and output
  settings for other operations do not apply. There is no tenant-supplied
  prompt.
- A cut-off answer (`finishReason: length`) is retried once at double the output
  budget. A summary that is still cut off, or that breaks the output contract,
  is never stored. Every attempt that returned is recorded with the provider's
  own token counts.
- Requests go through the fleet rate limiter (`runWithProviderRateLimit`). A
  rate rule for the text route is deployment configuration (`AI_RATE_LIMITS`);
  without one the limiter passes requests through.
- The model's answer is parsed once: control characters (C0 except the
  paragraph break, DEL, C1) and bidirectional controls are removed before the
  summary is stored, so no artifact, table row or reused copy carries one. The
  CLI also strips them from what it prints.
- A content refusal by the model's host is a failed group with the reason
  `content-refusal`. Worker text calls have no content-refusal fallback route,
  so a group refused twice leaves the document `partial`.
- Everything from the document (leaf text, headings, child summaries) is inside
  the prompt's untrusted block. The block is delimited by a tag generated for
  that one request (`untrusted-` plus 72 random bits, never a tag the content
  contains), announced in the user prompt, so the system prompt is the same
  for every call. A document cannot predict the tag, so it cannot close the
  block; its text is passed verbatim and nothing is stripped from it.
- Before the first call: the project's privacy mode must allow a hosted model,
  a model key must exist, and the organization must be allowed to spend
  (`org_spend_status`, read-only). A refusal makes no call.
- Before every commit window (up to `WORKER_SUMMARY_TREE_CONCURRENCY` model
  calls, or a batch of resumed summaries that only need embedding): the same
  spend check again, the project's stored setting, and for a run its pause and
  cancel state. A refusal stops the build there (`partial`,
  `stopped:<reason>`): the window in flight finishes and is committed, and no
  model call or embedding request follows. A pause, a cancel or the setting
  going off also stops the other documents of the same stage at their next
  call. The backfill job parks on a spend refusal and ends when the project
  turned the tree off.
- Before every call, before every window and before every embedding request
  outside a window: the build switch, the run's cost cap
  (`pipeline.maxCostCents`) and the stage's time budget.
- Usage events: `summary-tree-generation` per model attempt and
  `summary-tree-embedding` per embedding request, with `orgId`, `projectId`,
  `runId`, `documentId`, node and attempt in the metadata, through the run's
  usage ledger. These record the model's own cost and bill nothing.

### Billing

The billable unit of the tree is **one summary model call that returned**: a
first answer, the one retry of a cut-off answer and the retry of a failed group
each count, kept or not. A request that failed before the model answered is not
a unit. Embedding requests are part of the unit and are not billed separately.
A document's units are bounded by its node cap, and a unit is known before its
call is made, so a cap can hold one unit back for every call in flight.

- Each unit is a price-card unit charge: usage event `feature-summary-tree`
  (provider `docslurp`, unit `summary-call`, `unitCharge: true`), written with
  the call's own usage event and debited from the organization through the
  pending-debit path, exactly as the knowledge graph rebuild's feature charge
  is. In a run the charge goes through the run's usage ledger and checkpoint,
  so it counts toward the run's spend and `pipeline.maxCostCents`; in a
  backfill job it is written in the same transaction as the call's usage.
- **The price is the pricing provider's.** A provider prices the unit with the
  optional method `summaryTreeCallCredits()`
  ([pricing provider](billing/pricing-provider.md)). This repository holds no
  price for it, and the open pricing default has none.
- **A deployment that charges but has no price builds nothing.** A deployment
  charges for work when billing is enforced (`STRIPE_SECRET_KEY`, or a
  `DOCSLURP_BILL_*` flag set to `true`), when pricing is required
  (`DOCSLURP_PROFILE=service` or `DOCSLURP_PRICING_REQUIRED=1`), or when
  a pricing provider is installed (`DOCSLURP_PRICING_PLUGIN`). There, a provider
  without the method, one that throws, and any answer that is not a finite
  number above zero all mean `unpriced`:
  - `PATCH …/summary-tree` refuses to turn the tree on
    (`400 summary_tree_unpriced`), and the state reports `buildPriced: false`;
  - the stage makes no call and records `blocked` / `unpriced` per document;
  - the backfill estimate and start are refused (`400 summary_tree_unpriced`),
    the status returns no estimate, and a job parks as `blocked` / `unpriced`
    before its claim, before every batch and before every window.
- **A deployment that does not charge** (self-hosted, none of the three above)
  runs as before: no unit is recorded, nothing is billed, and a backfill job's
  cap counts the model's own cost from the configured token rates.
- The run's cost cap and a backfill job's cap are passed by less than one unit:
  a call is admitted only while the spend so far, plus one unit for every call
  in flight, is under the cap.

### Reuse

A node hash covers the tree key version, prompt version, resolved model, text
settings, length target, level, heading path and ordered child hashes. It holds
no document, tenant or page identity, so identical text hashes the same
anywhere. Where a summary may be copied from is therefore a tenant boundary:

1. This document's own artifact (a resumed build).
2. The version this document directly replaces: the completed document of the
   same organization, project and canonical id that is older than this one and
   is either still current or was superseded by exactly this document.

Reuse from the predecessor is refused, and every node is generated, when:

- the document has no canonical id, there is no such version, or more than one;
- the predecessor, or its run's artifacts, is purged or archived;
- the predecessor is PII-blocked, redacted, or withholds artifacts;
- the predecessor has no tree, or its build registered no artifact, or the
  registered artifact is not exactly that document's own tree artifact:
  `<run root>/summary-tree/<documentId>/summaries.jsonl`, with the run root
  taken from the predecessor's own rows (the storage prefix of the run its tree
  was built in, else `<its user>/<that run>`). A registered key that only ends
  in the same folder name, under another run, user or organization, is not
  read.

A deleted document has no row, and a version superseded by a since-deleted
document names that document, so delete then re-upload regenerates. Another
organization or project with identical content gets no hit. A dedup copy is not
in its source's chain: it gets its own tree, rows and artifact. Copied text is
written into the new version's own artifact; nothing later reads the
predecessor's.

### Artifact and stats

Text is stored under `<run root>/summary-tree/<documentId>/`: one
`parts/<hash>.jsonl` per committed summary while building, then
`summaries.jsonl`. Records hold a node hash, a title and the text. The pack is
the stage's registered artifact (`document_run_stage_states.artifact_uri`), so
document, version, run and project deletes remove it with the document's other
artifacts. It is not a readable output and is not part of document exports.

Stage stats: `summaryTreeStatus`, `summaryTreeSkipReason`,
`summaryTreeSkipDetail`, `summaryTreeReason`, `chunks`, `leaves`, `tableLeaves`,
`overlapChunks`, `tableDetailChunks`, `groups`, `nodes`, `levels`, `modelCalls`,
`generatedNodes`, `reusedFromResume`, `reusedFromPredecessor`,
`predecessorReuse`, `failedGroups`, `failureReasons`, `truncationRetries`,
`inputTokens`, `outputTokens`, `embeddedSummaries`, `rowsWritten`,
`staleRowsDeleted`, `durationMs`.

`runSummaryTreeForDocument` (`worker/src/stages/summary-tree.ts`) builds,
resumes or rebuilds one document's tree outside a run. The caller passes the
document's own run id and run root, its embed artifact, a usage recorder with
its own scope and its own cost cap as `stopReason`, then registers the returned
`artifactUri` with `registerSummaryTreeArtifact`
(`worker/src/summary-tree/state-store.ts`).

### Backfill: trees for documents a project already holds

Turning the tree on covers new uploads. Documents indexed before that, documents
a run left `partial` or never started (the stage's time budget), and documents
whose builder died are built by a backfill job
(`worker/src/summary-tree/backfill-job.ts`, table `summary_tree_jobs`).

| | |
| --- | --- |
| Status and estimate | `GET /v1/projects/:projectId/summary-tree/backfill` |
| Estimate only | `POST /v1/projects/:projectId/summary-tree/backfill/estimate` |
| Start | `POST /v1/projects/:projectId/summary-tree/backfill` with `{ "maxCostCents": n }` |
| Job | `GET /v1/projects/:projectId/summary-tree/backfill/:jobId`, or the shared `GET /v1/jobs/:jobId` and `GET /v1/jobs/:jobId/events` (SSE) |
| Cancel | `POST /v1/projects/:projectId/summary-tree/backfill/:jobId/cancel` |
| SDK | `getSummaryTreeBackfill`, `summaryTreeBackfillEstimate`, `startSummaryTreeBackfill`, `getSummaryTreeBackfillJob`, `cancelSummaryTreeBackfill` |
| CLI | `docslurp summary-tree backfill --max-cost-cents <n> [--estimate] [--watch]`, `summary-tree status`, `summary-tree cancel <jobId>` |

Reading needs project access (a server key with any project scope); estimating,
starting and cancelling need edit access (a server key with `projects:manage`).

**Start.** Refused unless the tree is on for the project, the deployment builds
trees and can account for them (see Billing), and the organization may spend.
`maxCostCents` is required; there is no uncapped job. It must be at least 0.01
and at most the operator's ceiling for one job,
`DOCSLURP_SUMMARY_TREE_BACKFILL_MAX_COST_CENTS` (default 10,000 cents;
`400 summary_tree_backfill_cap_too_high` above it). A job that needs more is
started again after it stops at its cap. One active job per project.

**What it builds.** The project's current documents (completed, not superseded,
purged or archived) that have no tree search can read for their current run:
no state row, `pending`, `partial`, a `building` row nobody reports on, or a
tree of another run or embedding space. `ready` and `skipped` documents are not
touched; that includes corrected documents, which are `skipped` and get no tree. Each document is built by
`runSummaryTreeForDocument` with its own run id, run root and embed artifact, so
the model route, the fleet rate limiter, the artifact and every write are the
stage's own.

**The estimate** counts leaves in Postgres (chunks of the current run that are
neither overlap chunks nor table row or cell chunks) and the tokens stored on
them; no artifact is read and no model is called. It is one aggregate over the
chunks of the documents that need work, on `document_chunks (document_id,
chunk_index)`. Node and call counts use the middle of the group and fan-in
ranges until finished builds calibrate them: builds register their stats on the
document's `summary-tree` stage row, and the estimate reads whole builds of the
same organization (this project's first). It assumes no reuse. `costBasis` says
what the cost figures and the job's cap count: `billed` where the deployment
charges for the tree (the expected model calls times the unit's price, so the
shared estimate's `credits` are what the organization would be billed), or
`provider` where it does not (the server's configured token rates). The status
read returns a recent estimate, planned at most once a minute per project; the
estimate route and a started job's own estimate are always current.

**Spend.**

- The cap counts billed credits where the deployment charges for the tree, and
  the model's own cost where it does not (`costBasis` on the job and its
  estimate). `costCents` on the job is what counted so far.
- The cap is checked before every model call, with a reserve held for each call
  in flight: exactly one unit where the deployment charges, twice the largest
  call seen where it does not. The job passes its cap by less than one unit
  (one group, where nothing is charged) whatever the concurrency.
- Every model attempt and embedding request is written to `usage_events`, with
  its unit charge and the organization's debit, and added to the job's totals
  in one transaction when it returns. A worker that dies loses no record of a
  paid call.
- A group that fails is retried by the build and once more by the job. Then the
  document stays `partial` and unserved. No text is written in a summary's
  place.
- At the cap the job ends `cancelled` with the note `Stopped at the cost cap`;
  a later job continues from what was built.

**Parking.** A job that cannot proceed for a reason that clears on its own is
`blocked`: it holds no lease and makes no call. It is looked at again after a
minute the first time and after twice as long for every further park in a row,
up to thirty minutes; progress resets the count. A job that stays parked for
three days without progress ends `failed` with the note `Parked too long
without being able to continue; start it again once the cause is resolved`,
and its last parking reason stays on the row. Whether the organization may
spend is asked before any document is selected, so looking at a job parked for
credits costs one small query and reads no artifact.

| `blockedReason` | Cause | `/v1/jobs` reason |
| --- | --- | --- |
| `build-off` | `DOCSLURP_SUMMARY_TREE_BUILD` is off. Both switches are read before the claim and before every batch; the build reads the build switch before every call | `unavailable` |
| `balance` | the deployment's provider balance probe reports below its floor, or could not answer | `capacity` |
| `credits` | the organization may not spend | `credits` |
| `policy` | the project's privacy mode does not allow the summary model | `policy` |
| `unpriced` | the deployment charges for work but has no price for the tree's unit | `unavailable` |

**Provider balance probe.** Nothing else at runtime reads a model provider's
live balance. A deployment may name a module in
`DOCSLURP_PROVIDER_BALANCE_PROBE` (an absolute path or `file:` URL) that exports
`createProviderBalanceProbe(host)` and returns `{ check(request) }`
(`worker/src/lib/provider-balance-probe.ts`). The job asks it before the claim,
before every batch and before every commit window of a document, with the
usage-ledger provider and model labels of the summary route; a sufficient
reading is reused for fifteen seconds. A reading below the floor stops the
document at that window (`stopped:provider-balance`) and parks the job for the
probe's own retry interval when it gives one. The module decides which account it reads and what is enough; no
probe, provider code or floor ships with this repository. Unset means no check.
A module that cannot be loaded, and a probe that throws or takes longer than ten
seconds, read as not sufficient.

**Settings that change while a job runs.** The project's pipeline, the model
and embedding space that follow from it, and the hosted-call decision are read
before every batch and before every commit window, never once per claim.

- A project that leaves `standard` privacy mode gets no further hosted call
  from the next window on: the document stops (`stopped:privacy-mode`) and the
  job parks as `policy`. The privacy mode is read on its own, so a stored
  pipeline that does not validate under the stricter mode is still a `policy`
  park, not a failed job.
- A changed summary model or embedding space stops the document in progress
  (`stopped:pipeline-changed`); the next batch builds it with what the project
  has now. A node's hash covers the model, so summaries written by the earlier
  model are not reused.

**Lease and resume.** The job is leased for five minutes and renews while it
runs. When a worker dies, another claims the job after the lease expires,
starts after the cursor (the last document the job finished) and resumes the
document in progress from its artifact: groups whose call returned are read
back, never called again. A worker that lost its lease stops at its next call,
and nothing it writes afterwards lands on the new holder's rows.

**Scale.**

- Many small documents: a batch selects 200 documents; those under the
  long-document floor with no state row are marked `skipped` in one statement,
  with no artifact read.
- One very large document: built like any other, committed window by window,
  resumable across leases at any group.
- One job runs at a time, on the maintenance leader
  (`WORKER_SUMMARY_TREE_JOB_POLL_INTERVAL`); documents inside it are built
  `WORKER_SUMMARY_TREE_JOB_DOCUMENT_CONCURRENCY` at a time and share
  `WORKER_SUMMARY_TREE_CONCURRENCY` model calls.

**Fairness between organizations.**

- The claim picks the job attempted longest ago (never attempted first), from
  the organization served longest ago, with `for update skip locked`, and
  stamps the attempt at once. A job that is parked again goes to the back, so
  one organization's parked jobs cannot keep another organization's job
  waiting.
- A running job has a slice of five batches or five minutes. When the slice is
  over and another job is waiting, it releases its lease and goes back in the
  queue behind it; the next claim continues at its cursor. Inside a long
  document the check runs before every commit window: the document stops
  `partial` (`stopped:time-slice`) and resumes from its artifact with no call
  repeated. A job that is alone keeps the runner.
- At most one job of an organization runs at a time.

**Tenant boundary.** Every statement that selects or writes documents names the
job's organization and project. The cursor is a position inside that scope
only. A document deleted while its tree is being built is skipped, and the
summary rows and artifact parts written before the delete are removed by the
job.

### Measured behaviour (2026-11-14, development machine)

| | Measured |
| --- | --- |
| Embed-artifact scan | about 12 MB of JSON a second on one core |
| Leaf grouping, 54,000 leaves | about 0.1 s |
| Leaf text read-back, 54,000 leaves | about 1.2 s |
| Retained heap during a 54,000-leaf build | under a third of the artifact's size, sampled after forced collection |
| Document under the floor with a stored chunk count | two small SQL statements, no artifact read |

A 54,000-leaf document is about 20,000 pages at the 2.7 leaves a page the
phase-0 eval measured.

### Not done yet

- A summary request with an unknown transport outcome has no confirmed receipt.
  Backfill retains a durable outstanding-call reservation and refuses further
  work for that organization until the receipt is reconciled. Never clear
  `summary_tree_jobs.outstanding_calls` merely to unblock a job: first reconcile
  provider receipts and persisted usage/debits, then release only resolved
  reservations. This fail-closed state also survives worker lease expiry.
- The upload estimate and quote do not include the tree's units; only the
  backfill estimate does.
- Backfill jobs run one at a time, on the maintenance leader; they share that
  one runner by time slice.
- The scan parses the whole embed artifact; a vectors-only sidecar would remove
  most of that time for very large documents.

### Recovery after interrupted writes

Before writing tree text, the builder records an artifact watch in the cleanup
queue. A live, eligible document keeps its artifacts, including resumable partial
trees. After deletion, correction or PII withdrawal, the watch removes the
registered roots and remains as a daily tombstone to catch object writes that
complete after a worker dies. Failed cleanup is retried; physical erasure occurs
on a successful sweep, not atomically with the database transaction. These
watch rows are intentionally retained. Corrected or in-place PII-redacted/
withheld documents cannot rebuild from stale embed artifacts; ingest an eligible
new version first.
