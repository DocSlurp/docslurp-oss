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
- A failed, refused or invalid OCR read: the page fails, and is recorded as such (`ocr-failed-pages`). Vision page
  selection and the page router skip it, and in the router a failed boundary read stops the document's routed run rather
  than reaching the workspace-model fallback or a cascade. It is not read by a hosted model instead, and an escalation
  read is never a substitute for a read that did not happen.
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
`[ocr] long-edge-opt-in` at startup when it is set, `pricing:validate` reports the case as a warning, and the provider
cost is recorded at the VM's real rate, so the provider-cost loss alert flags runs that lose money.

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
  the run's cost cap, the workspace privacy mode and the run's vision attempt guard. The budget counts the document's
  pages in the guard's durable attempt ledger (`vision_run_attempts`, purpose `ocr`), so an activity retry or a worker
  restart does not reset it.
- It reads the PNG the OCR boundary wrote. The host produces no image for it.
- A skipped or failed escalation keeps the recogniser's text. Escalation never stands in for a missing VM.

`hosted` mode uses the same reader, budget and guards for its reads.

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
- Quotes price a TIFF at its frames, up to 64 ([Pricing and credits](../pricing-and-credits.md#quotes-for-tiff-files)).

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
| `DOCSLURP_OCR_MAX_LONG_EDGE` | `2000` | Long-edge cap in pixels (640 to 4000). Above 2000 is an explicit opt-in (see [Sizing](#sizing)). |
| `DOCSLURP_OCR_MAX_CONCURRENT` | `1` | Concurrent OCR jobs per worker process. |

`DOCSLURP_OCR=off` no longer exists; use `DOCSLURP_OCR_MODE=off`.
