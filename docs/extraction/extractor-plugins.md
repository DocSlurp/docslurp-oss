# Extractor plugins

DocSlurp ships an open default for every extraction path. A deployment can add four optional providers without
changing core code:

- a **sandboxed PDF extractor**, served as the `vm-pdf` extractor id;
- an **image orientation provider**, used for quarter-turn correction of page and embedded images;
- a **sandboxed OCR provider** (`sandboxedOcr`), which runs OCR when `DOCSLURP_OCR_MODE=vm` (see
  [OCR](ocr.md));
- a **page image reader** (`pageImageReader`), which reads OCR page images in its own VM when
  `DOCSLURP_OCR_PAGE_READER` is on (see [OCR](ocr.md#page-reader)).

Plugins are loaded by configuration, never imported by core. Core builds, typechecks and tests with none present.

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `DOCSLURP_EXTRACTOR_PLUGINS` | worker | Comma-separated absolute module paths (or `file:` URLs) loaded at startup. |
| `DOCSLURP_PDF_EXTRACTOR=vm-pdf` | API and worker | Make `vm-pdf` the default PDF extractor. Empty keeps the built-in order; any other value stops the process. |
| `DOCSLURP_VM_PDF_INSTALLED=1` | API (and worker) | List `vm-pdf` in `GET /v1/extractors` and admit PDFs up to its source limit. Must be empty, `0` or `1`. |
| `DOCSLURP_EXTRACTOR_ID_ALIASES` | API and worker | Legacy extractor ids, `<old>:<new>[,<old>:<new>]`; see [Renaming an extractor](#renaming-an-extractor). |

Projects select the extractor with `documentExtraction.order.pdf: ["vm-pdf"]` and pass its options under
`documentExtraction.options["vm-pdf"]` (`images.enabled`, `images.minWidth`, `images.minHeight`,
`pdf.extractImages`).

## Fail closed

- A module that cannot load, or that exports no `register`, stops the worker at startup.
- `DOCSLURP_PDF_EXTRACTOR` is trimmed and must be empty or `vm-pdf`; any other value (a typo, a retired id) stops
  the worker and the API at startup instead of silently routing PDFs to the built-in host parsers. Worker and API
  read it through one resolver (`resolvePdfExtractorSetting` / `sandboxedPdfConfigured` in `@docslurp/shared`).
- `DOCSLURP_PDF_EXTRACTOR=vm-pdf` or `DOCSLURP_VM_PDF_INSTALLED=1` without a registered provider stops the worker.
- Either setting makes the API cap PDF uploads at the sandboxed provider's source limit.
- At load the worker logs one line with the plugin API version and the generic ids of the loaded capabilities
  (`[extractor-plugins] loaded api=1 providers=vm-pdf,image-orientation`). A plugin's own name and details are the
  plugin's to log.
- Preparing `vm-pdf` without a provider, or with one whose `assertConfigured()` throws, refuses the candidate. The
  VM route never falls back to parsing on the worker host.
- With a sandboxed PDF provider registered, embedded image extraction requires the `vm-pdf` route alone. Without
  one, the local artifact graph serves image targets.
- Image orientation without a provider is off; it never decodes pixels on the host.

### Checking a configuration before a release

`node worker/dist/temporal/preflight-main.js` (in the image, `/app/worker/dist/temporal/preflight-main.js`) runs
the worker's startup configuration checks with the current environment and exits: the parser sandbox probe, plugin
load and API version, the `DOCSLURP_PDF_EXTRACTOR` setting, extractor id aliases, the OCR mode, profile and provider
(including the provider's own `assertConfigured()`), the OCR model manifest and the native PDF engine. Exit 0 means
the worker would start; 1 names the failing step (`[worker-preflight] FAILED step=...`); 2 means the checks did not
finish within `DOCSLURP_WORKER_PREFLIGHT_TIMEOUT_MS` (default 120000). It never connects to Temporal or the database,
runs no migrations, schedulers or maintenance and writes nothing, so a deployment can run it on a new image before
migrating. Checks that need the database (the vision ledger schema) are reported as skipped.

## Renaming an extractor

When a deployment's stored configs name an extractor by an id it no longer serves (for example after moving a
provider behind the `vm-pdf` id), set `DOCSLURP_EXTRACTOR_ID_ALIASES=<old>:<new>` on the API and the worker:

- Parsing rewrites the old id to the new one wherever a `documentExtraction` config names an extractor: `order`,
  `components`, `pages`, `enrich`, `voting.secondary` and the `options` key. It applies to requests and to stored
  project, run and upload-session configs alike, so nothing written after the deploy carries the old id. Free text
  elsewhere in a pipeline is never touched.
- Startup refuses an alias whose target the process does not serve (`vm-pdf` without a provider on the worker, or
  without `DOCSLURP_VM_PDF_INSTALLED=1` on the API), an alias that names a built-in id, a chain, or a malformed
  entry. Ids that are neither aliased nor known still fail validation as before.
- A config holding options under both the old and the new key is never merged: requests are rejected, and stored
  reads keep the new key's options and log the dropped old key.

Order of a rename:

1. Deploy the API and the worker with the alias and the provider under its new id, in one release. Runs created
   before the deploy, and runs in flight across it, load their stored config through the alias and complete.
2. Old configs keep working; new and updated configs are written with the new id.
3. Optionally rewrite stored rows (a deployment's own tested script), so nothing still names the old id.
4. Remove the alias in a later release, once nothing stored names the old id.

## Module contract

A plugin module exports `register(host)` and returns an `ExtractorPlugin` (`worker/src/extractors/plugins.ts`):

```ts
export function register(host: ExtractorPluginHost): ExtractorPlugin {
  return {
    apiVersion: 1,
    name: "example",
    sandboxedPdf: {
      id: "example-vm",
      maxSourceBytes: 500 * 1024 * 1024,
      assertConfigured() { /* throw when the VM image or credentials are missing */ },
      async run(job, context, signal) { /* in a VM; write Markdown to job.output */ return { exitCode: 0, stdout: "{}", stderr: "" }; },
      timeoutMs: (pages) => 180_000,
      embeddedImages: { producerId: "example-embedded-images", optionsDigest: "…", read: async (output) => imageSet },
      figures: { producerId: "example-figures" }, // only when DOCSLURP_DOPPLER_IMAGE_EXTRACT is on
      shardProfile: { key: "extract-markdown:example-vm", prior },
    },
    imageOrientation: { id: "example-orientation", maxCostCents: 1, orient: async (input, output) => ({ result, usage }) },
  };
}
```

- `host` carries the worker's own runtime values (`SandboxRunError`, the Modal SDK loader, `planPageShards`,
  `currentPerfContext`). A plugin imports only types from the worker, so the errors and usage it raises are the
  worker's own classes.
- `run` writes Markdown with one form-feed-separated slot per page. Throw `host.SandboxRunError(message, usage)` on
  failure so the usage is recorded; never put raw provider or parser text in the message. The host refuses Markdown
  that is not a regular file or exceeds 256 MiB (`SANDBOXED_PDF_MAX_MARKDOWN_BYTES`) before reading it.
- `run` may return `ocrPages`: the 1-based pages whose text it read with OCR. Each is billed as one Scan page read.
  The host requires unique integers within the document's page count and refuses the run otherwise. Omit the field
  when unknown: the host then records no OCR reads for the document. It never infers them for this route.
- `imageOrientation.orient` returns a record the host validates against `orientationResultSchema`
  (`@docslurp/shared`): strict fields, bounded numbers, a status enum, a 64-hex `modelSha256`, and `model` equal to
  the provider's `id` (it becomes the derived artifact's producer id). A failing record refuses the image.
- `embeddedImages.read(output)` returns an `EmbeddedImageSet`. Core validates it again
  (`validateEmbeddedImageSet`): strict facts, hashes that match bytes, size limits and page range.
- `figures` (with `DOCSLURP_DOPPLER_IMAGE_EXTRACT=1`, see [Doppler figures](doppler-figures.md)): the job carries
  `figures.dir`, an empty host folder. The provider writes Doppler's figure folder there (`manifest.json` in the
  `doppler-figures@1` shape plus `<id>.<format>` files) and returns `figures: { status: "extracted" }`, or
  `{ status: "failed", reason }` when Doppler kept the Markdown but could not extract figures. `reason` is raw text
  for telemetry only. Core validates the whole folder again and stores nothing from a folder that fails any rule; a
  provider that returns `figures` for a job that did not ask is refused.
- `run` may return `pageFacts`: Doppler's [page facts](doppler-page-facts.md) (`doppler-page-facts/1` JSON lines, a
  string or the raw bytes) from the same job. The host parses them with a strict, bounded reader and records each
  page's text layer, scan class and math and table encoding words (`document_page_facts`); malformed or oversized facts
  are dropped, never repaired, and never bill. `job.pageFacts.include` names the families to add to the basic level
  (`pdftomarkdown --page-facts-include`, comma-separated; today `mathtables`); a provider that cannot compute one returns
  facts without it, which the host reads as unknown.
- `shardProfile` registers the provider's prior cost profile; calibration refines it from the shard timings it
  records through `context.recordTiming`.

## OCR provider (sandboxedOcr)

`DOCSLURP_OCR_MODE=vm` (the production default) runs OCR only through this provider. Without one, the worker refuses
to start; it never moves OCR to the worker host or to a hosted model instead. See [OCR](ocr.md) for the modes.

- The provider receives file paths and a job (`SandboxedOcrJob` in `worker/src/extractors/plugins.ts`): the stored
  input file and its kind (`image` or `pdf`), the pages to read, the output path, an empty image directory, and the
  CLI settings (recognisers, attempts, retry threshold, frame and long-edge limits, which frames to keep for
  escalation). The host never decodes the input first.
- It runs the fixed `worker/scripts/docslurp_ocr.py` CLI inside the VM with exactly those settings and the models
  pinned in `worker/ocr-models.json`, and copies back the CLI's JSON result to `output` and the PNGs it wrote (bounded
  by `maxLongEdge`) to the image directory.
- It runs every job in a VM or microVM with the requirements below. A warm VM may serve jobs of any run or
  organization one after another; each job's results go back only to that job.
- `run(job, signal, context)` receives `tenantKey` (the run's organization) and `affinityKey` (the document) for
  accounting, fairness caps and placement hints.
- `maxSourceBytes` refuses larger inputs before any VM work; `timeoutMs(frames)` bounds one run's wall time;
  `assertConfigured()` throws when the image, models or credentials are missing, which stops the worker at start.
- The host validates everything it gets back: the result against the shared OCR result schema, page numbers, sizes,
  and every PNG's bytes and dimensions. It refuses what does not validate, and a failed VM read fails the page. There
  is no fallback.

At load the worker lists the capability as `vm-ocr` (`[extractor-plugins] loaded api=1 providers=...,vm-ocr`).

## Page image reader (pageImageReader)

`DOCSLURP_OCR_PAGE_READER=escalation|all` reads OCR'd pages through this provider before hosted escalation, and
`DOCSLURP_VISION_PAGE_READER=all` reads vision-extract's plain page transcription through it before the hosted vision route. With the
flag on and no provider (or `assertConfigured()` throwing), the worker refuses to start. Off by default.

- The provider receives a `PageImageReadJob` (`worker/src/extractors/plugins.ts`): `scope` (`orgId`, `runId`) and
  `pages`, each an opaque `key` and the absolute path of a PNG the OCR boundary wrote and the host checked by signature
  and size. It never receives the customer's stored file, a document id or credentials.
- It reads the pages in a VM or microVM, which may be a warm VM shared by jobs of any run or organization. Each
  page's Markdown goes back only to the job that sent it. The VM has no network beyond the job's own connection, no
  credentials and no cloud metadata access.
- `read(job, signal)` resolves with `results` (at most one per key: `{ key, status: "read", markdown, inputTokens?,
  outputTokens? }` or `{ key, status: "failed", reason }`, reason one of `timeout`, `refused`, `oversized`, `invalid`,
  `vm-lost`, `capacity`) and `usage`, the provider cost of the job as usage events.
- A rejection that spent compute carries it as `pageReaderUsage` (an array of usage events, read with
  `pageReaderUsageOf`); set `ocrRefused: true` when the input was refused rather than the job failing to run. Either way
  the host keeps the recogniser's text: a page reader never fails a page.
- `maxPagesPerJob`, `maxImageBytes` and `maxMarkdownBytes` bound each job; the host never sends more or larger, and
  rejects a job whose answer is larger. `model` is logged in `[ai-usage]` and stored on usage events; it is never shown
  in the product.
- The host validates every response and records usage under its own metric (`ocr-page-reader`, or `vision-page-reader`) and scope, at provider
  cost and 0 credits.
- Optional `estimateJobCostCents(pages)`: an upper estimate of one job's provider cost. The host reserves it against the
  organization's daily reader budget (`DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS`, [OCR](ocr.md#page-reader))
  before sending the job, so concurrent jobs cannot pass the cap together; without it the host reserves 0. It is required
  with `DOCSLURP_VISION_PAGE_READER` (the worker refuses to start without it), and a vision job whose estimate is 0 or not
  finite is not sent.
- Optional `privateRoute` (`{ modelUri, capability, baseUrl? }`): the operator-registered private model route the reader
  serves (`llm://private/<alias>/<model>`, registered in `DOCSLURP_PRIVATE_MODEL_ENDPOINTS` for `capability`). Projects
  under `local-only` or `strict-privacy` have pages read by the reader only when this resolves as private the same way
  `llm://private` routes do; without it, or with a route the registry does not hold, they skip the reader before any
  reader VM starts and keep the recogniser's text ([Quality and visuals](quality-and-visuals.md#the-page-image-reader-under-privacy-modes)).
- Optional `hostCountry` and `operatorCountry`: ISO 3166-1 alpha-2 codes for where the reader's VMs process pages and for
  the company that operates them, by ownership and jurisdiction (`CN` for a Chinese-owned cloud wherever it is listed).
  Vision page reads require both and apply the organization's provider-region policy to each
  ([OCR](ocr.md#vision-page-reader)).
- Optional `maxLongEdgePx` (256 to 4000): the longest page edge the reader's model reads at. Vision page reads render
  PDF pages at this size and refuse a PNG whose header reports a longer edge ([OCR](ocr.md#vision-page-reader)).
- Optional `evalScore` (0 to 1) and `evalRef`, together: the reader's composite on the page-OCR tier benchmark and the
  recorded run it comes from. A tier word in `DOCSLURP_OCR_PAGE_READER` ranks the reader by it against the hosted
  escalation reader ([OCR](ocr.md#page-reader)); a reader without it is never chosen by a tier.
- Optional `warm`: non-blocking start-up for a reader whose VMs take minutes to boot ([OCR](ocr.md#warm-start)).
  `warm.start(scope)` begins making a reader ready for that organization and run, within the provider's own caps, and
  returns at once; `warm.status(scope)` answers from memory with `none`, `booting`, `ready` (plus provider-reported
  `bootMs` and `bootCostCents` for telemetry), `failed` or `refused`. Neither may block, throw for a capacity or boot
  failure, or send a page: a start binds a VM to `scope` exactly as a job's lease would. `refused` must mean nothing was
  started or billed (the host then returns the start-up reservation); anything else that ends a start is `failed`. The host sends jobs only once
  `status` reports `ready`, marked `requireReady: true`; the provider must then use an already ready VM of the scope or
  reject the job at once (a `capacity` failure), never boot one for it. The first job served by a warmed reader records
  its boot as provider cost. Optional `warm.minPages`: the reader pages a run should expect before a start-up pays for
  itself under the provider's own cost model (the host's threshold unless the operator sets one).

At load the worker lists the capability as `page-reader`.

## Sandboxed PDF batch (`sandboxedPdf.batch`)

A sandboxed PDF provider may also declare `batch`: many PDFs of one run converted in one isolated VM job, with each file's
result streamed back as soon as it is ready. The first pass (`worker/src/pipeline/first-pass.ts`) uses it so that a run's
documents become keyword searchable one by one instead of waiting for a VM per file and for the slowest document at every
stage.

```ts
batch?: {
  maxFiles: number; maxBatchBytes: number; maxBatchPages: number;
  run(job: SandboxedPdfBatchJob, onEvent: (event: SandboxedPdfBatchEvent) => Promise<void>, signal?: AbortSignal): Promise<{ usage: UsageEvent[] }>;
}
```

- **One run per batch.** `job.scope` names the run and organization. The host checks every document against the database
  before any VM work (`assertSingleScopeBatch`) and refuses a batch that mixes runs or organizations; the provider refuses it
  again. Document ids never go to the VM.
- **Events.** Per file, in any order across files: `text` (the Markdown is in the file's `output`, with the VM's structural
  page count), then `figures` when the job asked for them, or `failed` with a fixed reason (`page-count`, `timeout`, `parser`,
  `oversized`, `vm-lost`, `invalid`). The host validates every event (`acceptSandboxedPdfBatchEvent`): a known index, one
  text result per file, figures only after text, page counts within bounds, and the same result checks as a single-file run.
  A malformed event fails the batch; a failed file fails only itself.
- **Billing.** The measured page count arrives on the `text` event and is recorded before anything bills; `processedPages`
  (when the converter read fewer pages) is the Markdown's slot count, billed and flagged partially extracted as for a
  single-file run. A file without a text event, every PDF of a failed batch and every PDF no batch takes is counted the
  ordinary way before the stage loop takes it, so nothing bills an estimate.
- **Host refusals end the batch.** When `onEvent` rejects (a credit refusal, a failed write, a malformed event) the provider
  stops every VM, starts no retry, sends nothing more and rejects with that same error. Every rejection carries the cost
  of every VM the batch ran as `batchUsage` (`batchUsageOf`). Providers also check ownership themselves through
  `host.documentOwners`, which fails closed when the worker has no database bound.
- **Failed closed is final.** A provider that cannot trust its own VM run (the guest could not confine itself, could not
  verify a file's cleanup, or never reported an explicit exit status) sets `batchFinal: true` on its rejection
  (`BATCH_FINAL_PROPERTY`, `isFinalBatchFailure`). The batch activity then fails without retry, and its documents are
  counted and take the ordinary per-document stages once; the batch never runs again.
- **Admission.** Each source is staged against its upload hash and admitted like any parser command (quarantined sources
  and organizations, the teardown breaker) before it enters a batch; a refused document never reaches the VM.
- **Provisional checkpoints.** The checkpoints the first pass writes are re-run by the ordinary loop when the run extracts
  PDFs differently (served from the persisted batch result, no second VM) or when the Markdown a later stage read changed.
- **Isolation.** The same rules as single-file runs: a VM with no credentials or network, bounded output. Every file of
  the batch belongs to the job's run (checked against the database), so results land on the right documents.
- **Options.** `math` (`pdftomarkdown --math`: on unless the project's `documentExtraction.options["vm-pdf"].math` is
  `false`, with `DOCSLURP_DOPPLER_MATH_DEFAULT` on, the default; still behind the deploy gate `DOCSLURP_FIRST_PASS_MATH`),
  `figures` (the deploy's figure extraction) and `pageFacts` (as a single-file job's `pageFacts`). Workers advertise `workflow.first-pass` only when a batch provider is registered.

The first pass runs only when the deploy sets `DOCSLURP_FIRST_PASS=on`, the pipeline's `firstPass` is not `off`, and the
whole fleet advertises the capability; unsetting the flag is the rollback. To roll out to a few organizations first, also
set `DOCSLURP_FIRST_PASS_ORGS` to a comma-separated list of org ids: runs of any other org, or of a run without an org, then
skip the first pass. Nothing becomes searchable before the document's
publish gate passes (`worker/src/pipeline/first-pass-gate.ts`: a clean malware verdict).

## Capability pool members (`poolMembers`)

Every plugin service that reads customer pages is a member of its capability's pool (`@docslurp/shared` `capability-pools.ts`): `text` for a sandboxed PDF provider, `ocr` for a sandboxed OCR provider or a page image reader. The plugin registers one `CapabilityPoolServiceRegistration` per service on its `poolMembers` array:

| Field | Meaning |
| --- | --- |
| `capability` | `text`, `ocr` or `vision` |
| `stage` | `read` (default); `second-read` only for `ocr` |
| `backend` | the service's provider `id` (`sandboxedPdf.id`, `sandboxedOcr.id`, `pageImageReader.id`) |
| `engine` | a generic, public-safe label (2-24 lowercase letters, digits, `-`): part of the member id, so never a private name |
| `regions` | where the service processes pages: `{ region: "US" or "EU", evidence: "endpoint-tag", "provider-docs" or "openrouter-metadata", source, checked }`, at least one; never inferred from a company's headquarters |
| `automaticFailover` | whether the pool may move to this member on its own |
| `quality`, `pagesPerDollar` | optional `{ value, evalRef }` measurements |
| `priority` | optional order among the capability's services (lower first) |

The member id is `<capability>.service.<engine>.<region>` (`text.service.vm-pdf.us`). It is stamped where the member serves pages (`SandboxedPdfResult.poolMemberId`, `sandboxedPdfPoolMember(job)`, page reader usage metadata and summary `poolMemberId`), for per-page records.

The worker refuses to start when a service has no member, when a member states a region other than US, EU or `global` (`global`: an unpinned cloud region; `local` is reserved for core's built-in, customer-owned execution; a plugin renting marketplace GPUs must exclude China-controlled hosts itself), or when `DOCSLURP_CAPABILITY_POOL_<CAPABILITY>` names an id nobody registers. Several plugins may each provide a sandboxed PDF provider when every one is a `text` member: the text pool then runs a job on its first member and fails over to the next automatic member when a member cannot run it (an infrastructure error; a refusal of the input, `refused: true` or `ocrRefused: true`, never fails over). Figures, embedded images, batches and shard profiles are the first member's; a job asking for figures or images fails over only to a member returning them under the same producer id.

## Isolation requirements

Untrusted files are processed behind a VM or microVM boundary (`AGENTS.md`). The boundary keeps customer bytes away from
the worker's secrets; it does not separate one job, run or organization from another. VMs may be shared and kept warm
across jobs of any organization. A provider must:

- run each job in a VM with no network, no credentials and no cloud metadata access;
- bound input, output, memory and time, and stop a VM that misbehaves;
- return only framed, bounded output that the host validates without decoding pixels or parsing the PDF.

## Host-side PDF parsing that remains

The sandboxed route moves Markdown extraction into the provider's VM. It does not yet move every read of the PDF.
When a PDF goes to `vm-pdf` (the deployment sets `DOCSLURP_PDF_EXTRACTOR=vm-pdf`, or the project order names it),
the extract stage skips these host probes, and its stage stats record `hostPdfProbes: "skipped-sandboxed-route"`:

- page facts (`pdftotext`, `pdfimages -list`) for the ingest report;
- page-image evidence for classify-route (`pdfimages`, `pdfinfo` and the text-layer verifier);
- the OCR ledger's text-layer probe (`pdftotext`). OCR reads come only from the provider's `ocrPages`.

Other stages still read the PDF on the worker host. Today that includes:

- `normalize` runs `pdfinfo` for page count and metadata;
- page rasterization for vision extraction, page embeddings and deferred page materialization (`pdftoppm`,
  `pdftotext`);
- the document map reads the outline and structure in process, with pdf.js;
- a fallback extractor, when a project's order lists one after `vm-pdf` and the provider fails, runs on the host
  like any built-in extractor.

The poppler commands run under the worker's parser sandbox (see `docs/worker-image.md`), which is defense in depth
inside the worker, not a VM boundary. The pdf.js structure read runs inside the worker process itself. Moving these
behind the provider, or deriving their facts from provider output, is open work.

