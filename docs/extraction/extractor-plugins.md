# Extractor plugins

DocSlurp ships an open default for every extraction path. A deployment can add three optional providers without
changing core code:

- a **sandboxed PDF extractor**, served as the `vm-pdf` extractor id;
- an **image orientation provider**, used for quarter-turn correction of page and embedded images;
- a **sandboxed OCR provider** (`sandboxedOcr`), which runs OCR when `DOCSLURP_OCR_MODE=vm` (see
  [OCR](ocr.md)).

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
      async run(job, context, signal) { /* one fresh VM; write Markdown to job.output */ return { exitCode: 0, stdout: "{}", stderr: "" }; },
      timeoutMs: (pages) => 180_000,
      embeddedImages: { producerId: "example-embedded-images", optionsDigest: "…", read: async (output) => imageSet },
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
- `run` may return `ocrPages`: the 1-based pages whose text it read with OCR. Each is billed as one Rich page read.
  The host requires unique integers within the document's page count and refuses the run otherwise. Omit the field
  when unknown: the host then records no OCR reads for the document. It never infers them for this route.
- `imageOrientation.orient` returns a record the host validates against `orientationResultSchema`
  (`@docslurp/shared`): strict fields, bounded numbers, a status enum, a 64-hex `modelSha256`, and `model` equal to
  the provider's `id` (it becomes the derived artifact's producer id). A failing record refuses the image.
- `embeddedImages.read(output)` returns an `EmbeddedImageSet`. Core validates it again
  (`validateEmbeddedImageSet`): strict facts, hashes that match bytes, size limits and page range.
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
- It must isolate every job in a fresh VM or microVM, with the requirements below. One job never sees another
  job's files.
- `maxSourceBytes` refuses larger inputs before any VM work; `timeoutMs(frames)` bounds one run's wall time;
  `assertConfigured()` throws when the image, models or credentials are missing, which stops the worker at start.
- The host validates everything it gets back: the result against the shared OCR result schema, page numbers, sizes,
  and every PNG's bytes and dimensions. It refuses what does not validate, and a failed VM read fails the page. There
  is no fallback.

At load the worker lists the capability as `vm-ocr` (`[extractor-plugins] loaded api=1 providers=...,vm-ocr`).

## Isolation requirements

Untrusted files are processed behind a VM or microVM boundary (`AGENTS.md`). A provider must:

- run each job in a fresh VM with no network, no credentials and no cloud metadata access;
- bound input, output, memory and time, and terminate the VM on every exit path;
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

