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
| `DOCSLURP_OCR_MAX_ATTEMPTS` | `3` | Recogniser attempts per page under `auto` (1 to 7). |
| `DOCSLURP_OCR_LANGUAGE` | `auto` | Default language for projects left on `auto`. |
| `DOCSLURP_OCR_MAX_LONG_EDGE` | `2000` | Long-edge cap in pixels (640 to 4000). Above 2000 is an explicit opt-in (see [Sizing](#sizing)). |
| `DOCSLURP_OCR_MAX_CONCURRENT` | `1` | Concurrent OCR jobs per worker process. |

`DOCSLURP_OCR=off` no longer exists; use `DOCSLURP_OCR_MODE=off`.
