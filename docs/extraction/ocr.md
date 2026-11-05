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
- Kreuzberg never OCRs. Its built-in OCR is disabled on every path.

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
- A refused or invalid OCR read (a CLI refusal, a model-pin mismatch, hostile input, a result that fails validation):
  the page fails, without another read of the same bytes, and is recorded as such (`ocr-failed-pages`). Vision page
  selection and the page router skip it; in the router the assignment fails as `ocr-boundary-failed` and never reaches
  the workspace-model fallback or a cascade. It is not read by a hosted model instead, and an escalation read is never a
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

## Languages

`DOCSLURP_OCR_LANGUAGE` is the worker's default for workspaces left on `auto`. It takes `auto` or three-letter codes
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
  the run's cost cap, the workspace privacy mode and the run's vision attempt guard.
- It reads the PNG the OCR boundary wrote. The host produces no image for it.
- A skipped or failed escalation keeps the recogniser's text. Escalation never stands in for a missing VM.

`hosted` mode uses the same reader, budget and guards for its reads.

## Billing and usage

- Every page OCR read with words in it is one Rich page read, metric `page-ocr`, charged once per run, document and
  page, so a retry or a second reader does not charge it twice.
- Each job records one compute event (`ocr-compute`) with the boundary's measured CPU, peak RSS and wall time. A VM
  provider's own cost arrives separately, at provider cost.
- Escalation reads are recorded as `ocr-escalation`, and `hosted` mode reads as `hosted-ocr`, each with the provider's
  actual input and output tokens and cost.

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

## No Tesseract

DocSlurp does not install or run Tesseract in any worker image or development path; PP-OCR above is the only OCR.

- Kreuzberg links an OCR engine that reads Tesseract language data. The worker turns Kreuzberg's OCR off, refuses image
  inputs (by sniffed MIME type, which it passes to Kreuzberg explicitly) and points `TESSDATA_PREFIX` at an empty,
  read-only directory (`/opt/docslurp/empty-tessdata`) in the image, the command's sandbox environment and the extraction
  script, so an OCR call that slipped past those options fails instead of reading pixels on the worker host.
- `unstructured-pytesseract` stays in the Python lock because `unstructured[pdf]` requires it. Its wheel
  (`unstructured.pytesseract-0.3.15-py3-none-any.whl`, sha256 `a3f505c5…13d1`, pinned by hash) is two pure-Python files
  that shell out to a `tesseract` binary on `PATH`; it ships no binary or language data. No worker image installs that
  binary (no `tesseract` package in any Dockerfile; `scripts/install-worker-test-tools` and the prerequisite check assert
  it), and DocSlurp calls unstructured only through `worker/scripts/unstructured_partition.py`, whose only strategy is
  `fast` (the PDF's own text layer). Removing the pin would mean dropping the `[pdf]` extra unstructured needs.
- The mixed-PDF evaluation harness (`worker/test/mixed-pdf-eval`) uses the PP-OCR CLI under the parser sandbox.

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
| `DOCSLURP_OCR_MAX_ATTEMPTS` | `3` | Recogniser attempts per page under `auto` (1 to 7). |
| `DOCSLURP_OCR_LANGUAGE` | `auto` | Default language for workspaces left on `auto`. |
| `DOCSLURP_OCR_MAX_LONG_EDGE` | `2000` | Long-edge cap in pixels (640 to 4000). |
| `DOCSLURP_OCR_MAX_CONCURRENT` | `1` | Concurrent OCR jobs per worker process. |

`DOCSLURP_OCR=off` no longer exists; use `DOCSLURP_OCR_MODE=off`.
