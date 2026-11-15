# OCR

OCR reads text from scanned pages and images. It parses customer bytes, so where it runs is an explicit operator
choice, and every mode fails closed: a read that cannot run where the operator put it fails the page. It never moves
to a weaker boundary or to another reader.

## Engine and models

- The engine is PaddleOCR PP-OCRv6 `small` (detection and a multilingual recogniser for Chinese, Japanese, English
  and Latin-script languages), plus PP-OCRv5 mobile recognisers for Korean, East Slavic Cyrillic, Arabic, Devanagari,
  Greek and Thai. They run on CPU through RapidOCR 3.10.0 and onnxruntime.
- Every read goes through one fixed program, `worker/scripts/docslurp_ocr.py` (protocol `docslurp-ocr@1`). The VM
  provider and the local sandbox run the same program with the same arguments. Nothing in a job is a free-form flag.
- The eight model files are pinned by sha256 in `worker/ocr-models.json` (RapidOCR's v3.10.0 ONNX exports, Apache-2.0,
  84 MB in total). The CLI loads models only by explicit path and refuses a missing or mismatched file (exit 3).
  Nothing downloads a model at runtime: images bake them read-only, and `--self-test` checks them.
- No document extractor OCRs, and none links an OCR engine (see [Tesseract](#tesseract)).

## Modes

`DOCSLURP_OCR_MODE` selects where OCR runs.

| Mode | Default | Where OCR runs | Without what it needs |
| --- | --- | --- | --- |
| `vm` | when `DOCSLURP_SERVICE_PROFILE=service` | An extractor plugin's `sandboxedOcr` provider, one fresh VM or microVM per job ([Extractor plugins](extractor-plugins.md#ocr-provider-sandboxedocr)). | No provider: the worker refuses to start. A failed VM read fails the page. |
| `local` | never | `docslurp_ocr.py` under the worker's parser sandbox (bubblewrap). Customer-owned self-hosting only. | Refused at startup unless `DOCSLURP_SERVICE_PROFILE=self-hosted`. A missing venv or model fails the read. |
| `hosted` | never | A hosted vision model reads the stored image bytes as uploaded (PNG, JPEG or WebP, up to 20 MiB). | Anything that would need host decoding, rasterising or resizing (PDF pages, TIFF, other formats) is refused and the page fails. |
| `off` | outside production | Nowhere. | Pages that need OCR get no OCR text. |

An unknown value stops the worker at startup. The worker logs its choice once: `[ocr] mode=vm profile=service
boundary=vm`.

### Service and self-hosted profiles

`DOCSLURP_SERVICE_PROFILE` says who owns the files and the machine.

- `service`: the operator processes other people's files. OCR of those files must run behind a VM boundary, so only
  `vm`, `hosted` and `off` start. `local` is refused at startup.
- `self-hosted`: the customer runs DocSlurp on their own machine for their own files. `local` is allowed.
- Unset: treated like `service` for `local`, which is refused.

The parser sandbox is defense in depth on the worker's own kernel, not a VM boundary ([Parser sandbox
providers](../self-host/sandbox-providers.md)). That is why `local` needs the customer to own both sides.

To opt into local OCR on a self-hosted full worker, set:

```sh
DOCSLURP_SERVICE_PROFILE=self-hosted
DOCSLURP_OCR_MODE=local
```

No image sets either variable. The full worker image (`Dockerfile.full`) bakes the runtime and sets
`DOCSLURP_OCR_PYTHON` and `DOCSLURP_OCR_MODEL_DIR`. The lean image has no OCR engine. Outside Docker,
`scripts/install-ocr-runtime.sh` (or `scripts/setup-cli-linux.sh --with-ocr`) builds the same runtime under
`~/.cache/docslurp/ocr` and prints the variables to set. `scripts/check-worker-prerequisites.mjs` runs the CLI's
self-test whenever the runtime is present, and fails when `local` is set without it.

## What fails closed

- `vm` without a provider, or with one whose `assertConfigured()` throws: the worker does not start.
- `local` under `DOCSLURP_SERVICE_PROFILE=service` or with the profile unset: the worker does not start.
- A `sandboxedOcr` provider plugin loaded with `DOCSLURP_SERVICE_PROFILE` unset, or with `DOCSLURP_OCR_MODE=local` under
  any profile: the worker does not start, and the local runner refuses every job.
- A refused or invalid OCR read (a CLI refusal, a model-pin mismatch, hostile input, a result that fails validation):
  the page fails, without another read of the same bytes, and is recorded as such (`ocr-failed-pages`). Vision page
  selection and the page router skip it; in the router the assignment fails as `ocr-boundary-failed` and never reaches
  the project-model fallback or a cascade. It is not read by a hosted model instead, and an escalation read is never a
  substitute for a read that did not happen. Scan fill stops after three refused batches in a row and fails the
  remaining scanned pages unread.
- An OCR read that could not run (VM creation, capacity, a deadline, a provider that is not ready) is not the page's
  fault: scan fill fails the activity with a retryable `OcrInfrastructureError`, and Temporal retries it with back-off.
  A VM provider marks a deterministic refusal by throwing an error with `ocrRefused: true`; any other error retries.
- A job that names more pages than its frame cap returns the rest as unread pages, which fail; a result that claims
  truncation for a job within its cap is refused. No requested page is left neither read nor failed.
- A blank page is a read with no text: the result names only the detector model, and nothing is charged for it.
- Output from the boundary is untrusted. The host validates the JSON result against the shared schema (bounded fields,
  unknown keys refused) and checks frame numbers, image names and text sizes again. Escalation PNGs are checked by
  signature and size; the host does not decode them.
- `hosted` mode never decodes, rasterises or resizes on the host; inputs that would need it are refused.

## Sizing

One OCR call holds about 1.4 to 1.7 GB RSS at full A4 resolution. The CLI scales every frame so its long edge is at
most `DOCSLURP_OCR_MAX_LONG_EDGE` (default 2000 px, 640 to 4000), which bounds that. `DOCSLURP_OCR_MAX_CONCURRENT`
(default 1) caps concurrent OCR jobs per worker process; plan memory as that many calls on top of the worker. In `vm`
mode the memory is the VM's, not the worker's.

A cap above the 2000 px default is an operator opt-in, off unless set. It buys detail on small print at the cost of more
VM time and memory per page (a VM provider may need a larger size above 3000 px). A page still bills one Rich page,
so with escalation on a dense page at a high cap can cost more than it bills: slightly loss-making. The worker logs
`[ocr] long-edge-opt-in` at startup when it is set, and the provider
cost is recorded at the VM's real rate, so the provider-cost loss alert flags runs that lose money.

## Languages

`DOCSLURP_OCR_LANGUAGE` is the worker's default for projects left on `auto`. It takes `auto` or three-letter codes
such as `eng` or `eng+deu`; anything else stops the worker at startup. Codes map to recogniser families. Under `auto`
the CLI tries `multi` first and then other families while a page's confidence stays low, up to
`DOCSLURP_OCR_MAX_ATTEMPTS` (default 3, 1 to 7). A named language tries only its own families. Scripts no recogniser
covers (for example Hebrew, Bengali, Tamil) are read by `multi` and always escalated.

## Escalation

After a `vm` or `local` read, some pages get an extra hosted read: degraded and low-confidence pages, pages read with
the Arabic or Devanagari (Hindi) recogniser, and pages in a script no recogniser covers.

- The reader is `DOCSLURP_OCR_ESCALATION_MODEL`, default `llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct`.
- `DOCSLURP_OCR_ESCALATION=on` turns it on; it is off unless set. The model must be a hosted, priced route
  (DeepInfra, OpenRouter or OpenAI); a local or private one is refused.
- It has its own per-document page budget (`DOCSLURP_OCR_ESCALATION_MAX_PAGES`, default 25), its own ledger entries,
  the run's cost cap, the project privacy mode and the run's vision attempt guard. The budget counts the document's
  pages in the guard's durable attempt ledger (`vision_run_attempts`, purpose `ocr`), so an activity retry or a worker
  restart does not reset it.
- It reads the PNG the OCR boundary wrote. The host produces no image for it.
- A skipped or failed escalation keeps the recogniser's text. Escalation never stands in for a missing VM.

`hosted` mode uses the same reader, budget and guards for its reads.


Escalation reads survive activity retries. Each hosted call is persisted as it returns (`ocr_escalation_reads`, migration 0129, deleted with its run): a retried activity reuses a page's completed read instead of calling the provider again, and re-records every earlier call's usage under its original id, so a call's provider cost is recorded exactly once even when the activity that made it failed before its checkpoint. A call that does repeat (the first one failed) is recorded again with its own cost and counts against `DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS`. Escalation rows bill 0 credits and keep their cost as `providerCostCents`, which the provider-cost loss alert reads.

## Page reader

A deployment can give OCR'd pages a second read by a page image reader: an extractor plugin's `pageImageReader`
provider ([Extractor plugins](extractor-plugins.md#page-image-reader-pageimagereader)) that reads the PNGs the OCR
boundary wrote, inside its own isolated VM, and returns Markdown per page. It runs after the recogniser's read and
before hosted escalation.

`DOCSLURP_OCR_PAGE_READER` chooses what it reads:

- `off` (the default, also when unset): nothing changes.
- `escalation`: the pages escalation would read (degraded, low-confidence, Arabic or Devanagari, unsupported script).
  The boundary keeps their PNGs even when hosted escalation is off.
- `all`: every page the boundary read. The boundary keeps a PNG of every frame it found text or text regions on; blank
  frames have nothing to read.
- A tier word, `fastest`, `balanced` or `smart`: the reviewed OCR route options (`OCR_ROUTE_OPTIONS` and `selectOcrRoute`
  in `packages/shared/src/tier-options.ts`) pick the mode. `fastest` is the recogniser alone (`off`). `smart` ranks the
  measured readers by their composite on the page-OCR tier benchmark: the registered reader's own `evalScore` against the
  hosted escalation reader's recorded score (when escalation is on); the page reader, if it scores higher, reads every
  page (`all`), else `off`. `balanced` sends the pages escalation would read to a measured page reader (`escalation`),
  else `off`. A reader without `evalScore` is never chosen by a tier. Hosted escalation remains the fallback for every
  page the reader does not return.

A page the reader returns Markdown for takes that text (reader `page-reader:<provider id>`) and leaves hosted escalation.
A page it fails, answers empty, or never reaches keeps the recogniser's text and stays an escalation candidate, so the
hosted reader handles it exactly as it would without a page reader. Markdown tables in a read are rebuilt in the parser
VM, as for escalation reads.

What fails closed:

- An unknown `DOCSLURP_OCR_PAGE_READER` or `DOCSLURP_OCR_PAGE_READER_MAX_PAGES` stops the worker at start.
- With the reader on, the worker refuses to start without a registered provider, when the provider's
  `assertConfigured()` throws, or when `DOCSLURP_OCR_MODE` is not `vm` or `local` (no boundary PNGs to read).
- A job is sent only under an explicit tenant scope, the run's organization and run. A run without an organization is
  skipped and logged; the provider is never called without a scope.
- The host re-checks every PNG by signature and IHDR size against the frame the boundary read and the provider's byte
  cap. It never decodes pixels. A PNG that fails is not sent.
- Each page gets an opaque key, never a document id. The response is validated strictly: known keys, at most one result
  per key, a known status and failure reason, Markdown within the provider's byte cap, token counts as non-negative
  integers. A malformed response rejects the whole job, logged to telemetry only.
- A job that throws, whether refused or failed to run, never fails a page or a document, and the read never moves to
  the worker host or a weaker boundary: its pages keep the recogniser's text and fall through to hosted escalation.

Isolation: a provider meets the same requirements as every VM provider
([Isolation requirements](extractor-plugins.md#isolation-requirements)). Pages are read in a VM bound to one
organization for that VM's whole life (it may serve several jobs of that organization, never another's), with no network beyond the job's own connection, no credentials, no cloud metadata
access and bounded output that the host validates.

Reader usage bills 0 credits, so the run cost cap does not bound it: `DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS`
(default 2000, 0 to 10000000; 0 sends nothing) caps the provider cost one organization's reader jobs may commit per UTC
day, across every worker. Each job is admitted against a shared ledger before it is sent: under the organization's
advisory lock, the day's settled cost plus the reservations of unsettled jobs plus this job's reservation (the provider's
optional `estimateJobCostCents`) must stay within the cap, or the job's pages keep the recogniser read. A completed job
settles its reservation with the cost it recorded; a job that throws (a lease that failed while booting, an abort) settles
at no less than its reservation, since it may have run a VM it could not report; a job that never settles (a crashed
worker) keeps its reservation for the day. A ledger that cannot answer, or whose organization lock is not free within
10 s, sends nothing. A tier word never picks a reader scoring at or under the recogniser alone, and treats a hosted
escalation model other than the measured one as unmeasured. Token counts over 100,000 per page are rejected, control characters are stripped from returned Markdown,
and any error inside the reader path is logged and leaves the pages with their reads (only an abort propagates).

Budget and cost: `DOCSLURP_OCR_PAGE_READER_MAX_PAGES` (default 2000, 0 to 20000) bounds the pages a document sends,
counted across its OCR batches in one activity. Jobs carry at most the provider's `maxPagesPerJob` pages; the run's
cost cap is checked before each job. Each job logs
`[ai-usage] ocr-page-reader model=<model> input_tokens=<n> output_tokens=<n>`, and once per document
`[ocr] page-reader document=... attempted=... replaced=... failed={...} skipped={...}`.

## Vision page reader

The same page image reader can also read vision-extract's plain page transcription, the pages a hosted vision model
would otherwise transcribe (`DOCSLURP_VISION_PAGE_READER`, off by default). It is a deployment setting: it applies to
every eligible run, whatever vision model a project configured.

- `all` sends them to the reader. A tier word (`fastest`, `balanced`, `smart`) is resolved by `selectVisionTranscriptionRoute`
  (`packages/shared/src/tier-options.ts`) against the reader's `evalScore` and the best measured hosted page-ocr option:
  `fastest` picks a measured reader, `balanced` one within 0.02 of the best hosted composite, `smart` only one at or above
  it. An unmeasured reader, or one scoring at or under the OCR recogniser alone, is never picked. With the flag on, the
  worker refuses to start without a ready provider that implements `estimateJobCostCents`.
- Only plain transcription is sent: a transcription prompt template, no output schema, no task prompt, on a PDF page the
  renderer wrote as PNG, in a `standard` privacy project whose configured vision route is hosted (not a local model such
  as `local-cli` or a loopback vLLM or Ollama server, and not an operator-private model), in the legacy whole-document read
  of a document with page triage. Schema and task-prompt reads, pages triage routed as `chart-or-figure` or `image-heavy`,
  drawn-content and table-rescue pages, page-router groups and cascade legs, raster uploads, documents without triage,
  `local-only` and `strict-privacy` projects keep the hosted route. A run without an organization sends nothing.
- Reader pages are not fanned out into one-page tasks (the document's other pages still are). The run reads them in jobs
  of at most `maxPagesPerJob`, two in flight per document, each rendered at the provider's `maxLongEdgePx`, one run of one
  organization per job, with the same PNG checks (signature, byte cap, header size within the long edge and 40 million
  pixels, never decoded), response validation and organization daily cost cap
  (`DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS`, one ledger for both readers). `DOCSLURP_OCR_PAGE_READER_MAX_PAGES`
  bounds the pages a document sends in one activity; nothing past it is rendered at the reader's size, and no further
  batch starts once a budget, a cap or the ledger stopped one.
- A page the reader does not return (a failed, refused or timed-out job, a failed page, empty or invalid Markdown, a
  refused image, the budget or a cap) goes to the run's hosted vision route as it would without the reader. That route is
  the run's own configured model, never one the system picks as a fallback. A render or download error propagates as it
  would on the hosted route; only reader errors fall back.
- Usage: `[ai-usage] vision-page-reader model=<model> input_tokens=<n> output_tokens=<n>` per job, provider cost on the
  ledger at 0 credits; each page read is one Rich page, charged once per run.
- The reader's Markdown passes through vision-extract's own post-processing: HTML tables are rebuilt in the parser VM and
  `$...$` / `$$...$$` math is kept, the conventions the hosted transcription prompts ask for.

## Billing and usage

- An uploaded image: every frame the engine read is one Rich page read, metric `page-ocr`, with or without text in it
  (owner decision, 2026-11-05). The VM costs the same for a blank frame.
- A scanned PDF page: one Rich page read only when the read found words.
- Each charge is keyed by run, document and page, so a retry or a second reader does not charge it twice.
- A TIFF's frames are its pages: the frames read become `documents.page_count`. A TIFF with more than 64 frames (the
  job's frame cap) is refused before anything is charged, with the public error `imageTooManyFrames`.
- Each job records one compute event (`ocr-compute`) with the boundary's measured CPU, peak RSS and wall time. A VM
  provider's own cost arrives separately, at provider cost. Remote usage outside a stage context has no usage ledger:
  it is logged as `[usage-unrecorded]` and counted on `docslurp.usage.unrecorded`, never dropped silently.
- Escalation reads are recorded as `ocr-escalation`, and `hosted` mode reads as `hosted-ocr`, each with the provider's
  actual input and output tokens and cost. An escalated page bills at most one Rich page, whatever the output length
  (escalation output tokens add no Rich pages), and an escalation that returned no text charges nothing; its provider
  cost is still recorded.
- Page reader jobs are recorded as `ocr-page-reader` at provider cost, billing 0 credits (`providerCostCents`), also
  when the job failed. The host sets the metric, model and tenant scope of each event; a provider cannot record a
  billable charge. A page the reader replaced is one Rich page, charged once per run like the recogniser's read of it.
- Quotes count a TIFF's frames as its pages, up to 64.

## Host phases outside OCR

OCR adds no host parsing in `vm` mode: the worker hands the stored file's path to the provider and reads back only the
bounded result and PNGs. PDF handling outside OCR is unchanged and still runs on the worker host:

- `pdfinfo` for page count and metadata;
- page renders (`pdftoppm`) and the page probes and text-layer checks that decide which pages need OCR or vision;
- the other host reads listed in [Extractor plugins](extractor-plugins.md#host-side-pdf-parsing-that-remains).

Those commands run under the parser sandbox. In `local` mode the CLI itself, including its own `pdftoppm` render of a
PDF job, also runs under the parser sandbox on the worker host.

Two checks that used OCR are off until they are re-tuned for the PP-OCR recogniser: the page router's OCR-layer
agreement probe ([Page router](../page-router.md)) and the text-layer OCR cross-check ([Text-layer
quality](../page-text-layer-quality.md)). Pages they would have checked stay unverified.

## Tesseract

PP-OCR above is the only OCR DocSlurp runs. Tesseract still appears in three different forms, and they are not the
same thing:

**1. Tesseract binaries, packages and language data: removed.** No worker image installs a `tesseract` or Leptonica
package, binary, shared library (`libtesseract*`, `liblept*`) or `*.traineddata`; `/usr/share/tesseract-ocr` and
`/usr/share/tessdata` do not exist. Checked by `worker/src/__tests__/no-tesseract.test.ts` (Dockerfiles) and by
inspecting a built `worker/Dockerfile.lean` image (`dpkg -l`, `find` for the libraries, data and `tesseract` on `PATH`).
The mixed-PDF evaluation harness uses the PP-OCR CLI. This covers DocSlurp's images only: a developer machine may have
Tesseract installed by its own package manager (on Arch, `libmupdf` depends on it).

**2. Tesseract statically linked into native addons: removed.** Until 2026-11-05 two npm addons compiled Tesseract 5
and Leptonica in (`@kreuzberg/node` 4.10.2, which also carried a PaddleOCR backend, and `@llamaindex/liteparse`
2.17.0); no OCR-free build existed, so both extractors were removed and their formats moved (see
[Extractors per format](../extraction-feature-matrix.md#extractors-per-format)). `scripts/scan-ocr-engines.mjs` checks that nothing replaces them. It
finds every ELF and WebAssembly object under the given paths by its magic bytes and reads it directly:

- linkage: `DT_NEEDED` entries naming `libtesseract`, `liblept` or a Paddle library;
- symbols: every name in `.dynsym` and `.symtab` (wasm: imports, exports and the name section);
- banners: version strings and embedded language data in `.rodata`, `.comment` and data sections (`tesseract 5.`,
  `Leptonica-1.`, `.traineddata`).

Each object is `hit`, `clean` (its symbol table was present and searched) or `unverified` (stripped or unparseable). A
stripped object without evidence is not proof of absence, so it is never reported clean: corroborate it from its
package (the owning Debian package's dependencies, the crate or npm package's build features) and record that. Against
the retired addons the scanner reports both: the stripped Kreuzberg build through `.dynsym` and an embedded
`tesseract 5.5` banner, LiteParse through 5,244 `.symtab` symbols. `worker/src/__tests__/no-tesseract.test.ts` runs it
over the installed project and fails on any hit, and proves detection on a stripped system binary with a patched-in
banner. Run it over a built image too:

```sh
docker run --rm -u 0 -v "$PWD/scripts/scan-ocr-engines.mjs:/scan.mjs:ro" --entrypoint node <image> /scan.mjs /
```

Pinned model files can be exempted by digest (`--allow-sha256-file worker/ocr-models.json`), never by name; the ONNX
models are not ELF or wasm objects, so the default scan does not need it. A deployment that adds native extensions to
its image (a provider plugin, an optional engine) scans that final image the same way.

**3. A pure-Python wrapper with no binary: `unstructured-pytesseract`.** It stays in the Python lock because
`unstructured[pdf]` requires it. Its wheel (`unstructured.pytesseract-0.3.15-py3-none-any.whl`, sha256 `a3f505c5…13d1`,
pinned by hash) is two Python files that shell out to a `tesseract` binary on `PATH`; it ships no binary, library or
language data, and no image has the binary (case 1). DocSlurp calls unstructured only through
`worker/scripts/unstructured_partition.py`, whose only strategy is `fast` (the PDF's own text layer). The lean image does
not install unstructured at all; it comes with the `unstructured` vendor bundle. Removing the pin would mean dropping the
`[pdf]` extra unstructured needs.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DOCSLURP_OCR_MODE` | `vm` under `DOCSLURP_SERVICE_PROFILE=service`, else `off` | `vm`, `local`, `hosted` or `off`. |
| `DOCSLURP_SERVICE_PROFILE` | unset | `service` or `self-hosted`. `local` needs `self-hosted`. |
| `DOCSLURP_OCR_PYTHON` | `/opt/docslurp/ocr-venv/bin/python3` | OCR venv interpreter (`local`). |
| `DOCSLURP_OCR_MODEL_DIR` | `/opt/docslurp/ocr-models` | Directory holding the pinned models (`local`). |
| `DOCSLURP_OCR_ESCALATION` | off | `on` to enable escalation reads. |
| `DOCSLURP_OCR_ESCALATION_MODEL` | `llm://deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct` | Hosted reader for escalation and `hosted` mode. |
| `DOCSLURP_OCR_ESCALATION_MAX_PAGES` | `25` | Hosted reads per document. |
| `DOCSLURP_OCR_ESCALATION_MAX_ATTEMPTS` | pages + a fifth (`30`) | Hosted requests per document, every page and retry included, counted in the durable vision attempt ledger. |
| `DOCSLURP_OCR_PAGE_READER` | `off` | `escalation` or `all` to read pages with the page image reader plugin first, or a tier word (`fastest`, `balanced`, `smart`) resolved by the OCR route options (see [Page reader](#page-reader)). |
| `DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS` | `2000` | Reader provider cost one organization may commit per UTC day, across workers (0 to 10000000; 0 sends nothing). |
| `DOCSLURP_OCR_PAGE_READER_MAX_PAGES` | `2000` | Most pages one document sends to the page reader (0 to 20000). |
| `DOCSLURP_VISION_PAGE_READER` | `off` | `all` to read vision-extract's plain page transcription with the page image reader plugin, or a tier word (`fastest`, `balanced`, `smart`); see [Vision page reader](#vision-page-reader). |
| `DOCSLURP_OCR_MAX_ATTEMPTS` | `3` | Recogniser attempts per page under `auto` (1 to 7). |
| `DOCSLURP_OCR_LANGUAGE` | `auto` | Default language for projects left on `auto`. |
| `DOCSLURP_OCR_MAX_LONG_EDGE` | `2000` | Long-edge cap in pixels (640 to 4000). Above 2000 is an explicit opt-in (see [Sizing](#sizing)). |
| `DOCSLURP_OCR_MAX_CONCURRENT` | `1` | Concurrent OCR jobs per worker process. |

`DOCSLURP_OCR=off` no longer exists; use `DOCSLURP_OCR_MODE=off`.
