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

`PATCH /v1/projects/:project` replaces the stored `pipeline`, so send the project's pipeline as you read it with
`quality` and `visuals` changed; `visuals` wins over the deprecated `figures` and `chartExport.tier` it carries:

```bash
pipeline=$(curl -s "$DOCSLURP_URL/v1/projects/q3-earnings" -H "Authorization: Bearer $DOCSLURP_API_KEY" | jq '.pipeline + { quality: "balanced", visuals: "charts" }')
curl -X PATCH "$DOCSLURP_URL/v1/projects/q3-earnings" -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H "content-type: application/json" -d "{ \"pipeline\": $pipeline }"

curl -X POST "$DOCSLURP_URL/v1/uploads/url" -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H "content-type: application/json" \
  -d '{ "urls": ["https://example.com/q3-earnings.pdf"], "pipeline": { "quality": "smart", "visuals": "charts-ai" } }'

curl -X POST "$DOCSLURP_URL/v1/runs/$RUN_ID/reprocess" -H "Authorization: Bearer $DOCSLURP_API_KEY" \
  -H "content-type: application/json" -d '{ "visuals": "charts" }'
```

```ts
const project = await client.getProject("q3-earnings");
await client.updateProject("q3-earnings", { pipeline: { ...project.pipeline, quality: "balanced", visuals: "charts" } });
await client.upload({ urls: ["https://example.com/q3-earnings.pdf"] }, { quality: "smart", visuals: "charts-ai" });
await client.reprocessRun(runId, { visuals: "charts" });
```

```bash
docslurp upload q3-earnings.pdf --quality smart --visuals charts-ai
docslurp reprocess <runId> --visuals charts --estimate
```

`visuals: null` on a project means "use the deployment default". Chat settings proposals take a rung, not `null`.

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
5. An explicit run request (upload, URL ingest, extract, reprocess, MCP) they rule out gets `400 quality_unavailable` or
   `400 visuals_unavailable` (with `details.reason`: `privacy` or `switch`). A project setting is saved as given and
   lowered for each run, recorded in `capsApplied`; uploads never fail on it. (A project change to a chart rung the
   deployment does not offer at all is refused as before, with `chart_export_tier_unavailable`.)

Under `local-only` or `strict-privacy`, `smart` needs a local vision reader (a `*-local` vision profile or an
operator-registered private route); `charts-ai` (a hosted read) is not available.

Project reads (list, detail, dashboard bootstrap, create and update responses) carry the caller's own
`extractionChoices: { quality: [...], visuals: [...] }`: the rungs this caller may ask for on a new upload, URL ingest
or extract into that project from the caller's origin, computed by the same resolution function. A default-project
member who is not an editor sees `["fastest", "balanced"]` on a `balanced` project; an editor also sees `smart`, unless
privacy or a switch rules it out. Clients should offer only these rungs rather than infer rights from roles; the server
still checks every request.

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
under before this release. Run start fails a run whose version this release does not know, and the worker refuses to
load one; a request that sends an unknown `configVersion` is a `400` validation error.

An upload that creates a project (`newProject`, a new `project` name, `templateKey`) never saves `smart` or `charts-ai`
on the new project: the run still asks for them, and step 2 decides.

Estimates price what you ask for; they do not apply the privacy cap, so under `local-only` or `strict-privacy` they can
quote more than the run will read.

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

## Upgrading stored projects (release R1)

Migration `0183_extraction_config_v1_projects` rewrites every stored project pipeline to the new shape (`quality`,
`visuals`, `configVersion: 1`) with the mapping table above. It needs the previous release (which reads both shapes)
deployed first, and it never raises a project's effective quality or visuals, with one exception: `visionFallback:
false` with `auto` becomes `balanced`, which reads scans and complex pages again (and fixes uploaded images that had no
text). `figures: false` with a chart tier becomes `visuals: none`, so those projects stop exporting charts. Projects that
turned figure resume `off` or `manual` keep their existing partial figure passes as they are (blocked, `resume-off`);
new runs finish partial figures automatically within the run's `visuals`.

Before migrating, count what it will change without changing anything:

```sh
DATABASE_URL=postgres://... node server/db/extraction-config-v1-report.mjs        # counts
DATABASE_URL=postgres://... node server/db/extraction-config-v1-report.mjs --ids  # plus affected project ids
```

The migration logs the same counts (`[extraction-config-v1]`) before rewriting. New runs are stamped in the new shape
once every worker advertises `extraction.config-v1`; set `DOCSLURP_EXTRACTION_CONFIG_V1_STAMP=off` to keep stamping
the previous shape (every release reads it).
