# Quality and visuals

Two project settings say how DocSlurp reads your files:

- **`quality`**: `fastest` | `balanced` | `smart` (default `balanced`). How pages are read.
- **`visuals`**: `none` | `figures` | `charts` | `charts-ai`. What happens to figures and charts.

They replace `quality: fast|auto|good`, `visionFallback`, `figures` and `chartExport.tier`, which stay accepted during a
deprecation window (see [Deprecated names](#deprecated-names)). `quality` uses the same words as chat tiers: the
quickest and cheapest route, the default balance, and the best measured reads.

## `quality`

| Quality | Reads | Billing |
|---|---|---|
| `fastest` | Every page takes its text layer or the format's own structure. Pages without one are kept as page images, not read and not searchable. Never OCR, never a model. | Fast pages only |
| `balanced` (default) | Text layer first; scans and pages whose text layer is missing, garbled or unreliable are read by OCR or AI vision; low-confidence OCR pages get a second read. | Fast pages for text pages, Rich pages for pages a reader read |
| `smart` | Every page is read by AI vision (the text layer is a hint). A failed AI read falls back to `balanced`'s rules. | Rich pages for every page read |

Office, HTML, EPUB, JSON and text files are read from their structure at every quality. Audio and video follow
`mediaVideo`. Prices: [docslurp.io/pricing](https://docslurp.io/pricing); estimates quote them before you upload.

## `visuals`

An ordered ladder over the PDF figure pass and chart export. Embedded images in Office/EPUB/HTML output and page
images follow `preserveImages`, not `visuals`.

| Visuals | Adds | Billed |
|---|---|---|
| `none` | nothing | — |
| `figures` | PDF figures (pictures and vector figures) as files, referenced from the Markdown | stored bytes, where storage is billed |
| `charts` | chart data from files that carry it: Office chart parts, embedded chart specs, vector graphics; no model | no |
| `charts-ai` | also reads other charts and diagrams with AI | per chart or diagram a model reads |

**Unset** `visuals` means the deployment's default for the run's origin: `app` (the DocSlurp app) or `machine` (API,
MCP, SDK, CLI). Both are `figures` unless the operator changes them. The project record reports them as
`visualsDefaults: { app, machine, available }`, where `available` lists the rungs a request may choose on this
deployment. `chartExport.formats` and `chartExport.diagrams` keep their names and still choose the export formats.

An explicit `charts` (in a request or saved on a project) is allowed while the deployment runs the free chart steps
inline in its quarantine VM (operator setting `charts.explicitFree`: `auto`, the default, follows inline extraction;
`on`/`off` force it; until the operator config file lands it is `DOCSLURP_CHART_EXPORT_FREE_EXPLICIT`). While refused,
a request for it gets `400 visuals_unavailable`, and a saved `charts` counts as unset.

## Setting them

Project settings (`PATCH /v1/projects/:project`), per request (upload, URL ingest, direct upload sessions, extract and
website ingest take them in the request's `pipeline`; reprocess and the estimate endpoints take top-level `quality` and
`visuals`), MCP (`upload`, `extract`, `uploadEstimate`, `reprocessEstimate`, `proposeProjectSettings`), SDK and CLI:

```bash
curl -X PATCH "$DOCSLURP_URL/v1/projects/q3-earnings" -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H "content-type: application/json" -d '{ "pipeline": { "quality": "balanced", "visuals": "charts" } }'

curl -X POST "$DOCSLURP_URL/v1/uploads/url" -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "urls": ["https://example.com/q3-earnings.pdf"], "pipeline": { "quality": "smart", "visuals": "charts-ai" } }'

curl -X POST "$DOCSLURP_URL/v1/runs/$RUN_ID/reprocess" -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H "content-type: application/json" -d '{ "visuals": "charts" }'
```

```ts
await client.upload({ urls: ["https://example.com/q3-earnings.pdf"] }, { quality: "smart", visuals: "charts-ai" });
await client.reprocessRun(runId, { visuals: "charts" });
```

```bash
docslurp upload q3-earnings.pdf --quality smart --visuals charts-ai
docslurp reprocess <runId> --visuals charts --estimate
```

`visuals: null` on a project means "use the deployment default".

## Who may choose what

Every run resolves both settings once, the same way on every surface (`resolveExtractionSettings` in
`@docslurp/shared`):

1. The run asks for `request ?? project ?? origin default`, per setting.
2. A request **above** the project's value is a raise. Raising to `smart` or `charts-ai` needs a project editor's
   session, or an API key whose stored scopes include `pipeline:billed-features` (or `projects:manage`) **and** whose
   owner is a project editor. Otherwise: `403 quality_smart_forbidden` / `403 chart_export_models_forbidden`. A
   revoked or unknown key never qualifies. Raising to `balanced`, `figures` or (where allowed) `charts`, and every
   lowering, needs nothing.
3. Replays (reprocess, bulk reprocess, reindex, full index) inherit the source run's values, capped at what the project
   allows now: a document read at `smart` before the project moved to `balanced` is reprocessed at `balanced` unless the
   request asks for `smart` explicitly (and passes step 2).
4. The result is intersected with the project's `privacyMode`, its `vision.profile` locality and the deployment's
   switches. Scopes never override these.
5. An explicit request they rule out gets `400 quality_unavailable` or `400 visuals_unavailable` (with `details.reason`:
   `privacy` or `switch`). A saved project value they rule out is lowered for the run and recorded in `capsApplied`;
   uploads never fail on it.

Under `local-only` or `strict-privacy`, `smart` needs a local vision reader (a `*-local` vision profile or an
operator-registered private route); `charts-ai` (a hosted read) is not available.

## What a run executed

Every run is stamped with what it executes, `pipeline.effective`:

```json
{ "quality": "balanced", "visuals": "charts", "readsPages": true,
  "capsApplied": [{ "field": "quality", "from": "smart", "to": "balanced", "reason": "privacy" }] }
```

Run records expose it as `extraction` (`{ quality, visuals, readsPages, capsApplied, legacy }`). Runs created before this
release are mapped on read with `legacy: true`; their stored snapshots are never rewritten, and they keep the rules they
were admitted under until they complete, retries and resumes included. `readsPages` is true when the run may send pages
to OCR or a model reader. The ingest report lists any caps a run recorded under "Settings lowered for these runs".

Run snapshots may carry `pipeline.configVersion` (the semantics version). Absent means the rules a run was admitted
under before this release. A worker refuses a run whose version it does not know.

## The page image reader under privacy modes

An operator can enable a page image reader (an operator-run model that re-reads OCR page images in its own isolated
VM). Projects under `local-only` or `strict-privacy` have pages read by it only when its provider declares an
operator-registered private route (`PageImageReaderProvider.privateRoute`, an `llm://private/<alias>/<model>` URI that
resolves in `DOCSLURP_PRIVATE_MODEL_ENDPOINTS` for its capability). Otherwise those projects skip it, before any reader
VM is started, and keep the recogniser's text. See [extractor plugins](extractor-plugins.md).

## Deprecated names

| Deprecated | Current |
|---|---|
| `quality: "fast"` / `"auto"` / `"good"` | `quality: "fastest"` / `"balanced"` / `"smart"` |
| `visionFallback` | `quality` (`balanced` reads hard pages; `visionFallback: false` with `auto` maps to `balanced`) |
| `figures: false` | `visuals: "none"` |
| `chartExport.tier: "off"` / `"free"` / `"models"` | `visuals: "figures"` / `"charts"` / `"charts-ai"` |
| `chartExportDefaults` | `visualsDefaults` |
| reprocess / estimate `chartExport: { tier }` | `visuals` |
| CLI `--chart-export`, `--no-figures`; `--quality fast\|auto\|good` | `--visuals`; `--quality fastest\|balanced\|smart` |

A request that uses a deprecated name still works; its response carries a `Deprecation: true` header and
`warnings: [{ "code": "deprecated_field", "field", "replacement", "message" }]` (a route whose `warnings` are strings
gets the messages). Sending a current name and a deprecated name that disagree is `400 extraction_config_conflict`.
In this release projects are still stored in the deprecated shape and the project's `pipeline` object still shows it;
read `project.extraction` (`{ quality, visuals }`) for the current names. A later release stores the new shape, and
the release after that refuses the deprecated names with a `400` naming the replacement.

## For operators and contributors

- Raw SQL never reads `pipeline->>'quality'`, `'visionFallback'`, `'figures'`, `'chartExport'` or `'visuals'`
  directly: use the fragments in `packages/shared/src/pipeline-sql.ts`, which read the stamped `effective` values first
  and both stored shapes. `server/src/__tests__/raw-pipeline-readers.test.ts` fails on any other raw read.
- Origin defaults and the explicit-charts rule come from today's chart export variables
  (`DOCSLURP_CHART_EXPORT_APP_DEFAULT`, `_API_DEFAULT`, `_FREE_EXPLICIT`, `_INLINE`) until they move to the operator
  config file; `DOCSLURP_CHART_EXPORT=off` / `free` act as the `charts` / `charts-ai` switches.
