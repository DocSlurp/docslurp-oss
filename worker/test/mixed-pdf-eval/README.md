# Mixed-PDF yield evaluation harness

Local paired measurements of native text, cheap OCR and stronger OCR on mixed born-digital and scanned PDF pages. The
plan, metrics and integrity rules are in [`docs/evals/mixed-pdf-yield-v1/plan.md`](../../../docs/evals/mixed-pdf-yield-v1/plan.md).

## Inputs and execution

This harness is for **generated or public fixtures, and files the operator owns**. It is never a way to process a
DocSlurp customer's files.

- Both OCR arms run the worker's PP-OCR CLI (`worker/scripts/docslurp_ocr.py`) under `worker/scripts/parser-sandbox.sh`.
  That sandbox is bubblewrap: defence in depth, not the isolation boundary DocSlurp requires for customer bytes. In the
  service, customer files are OCR'd only in a fresh VM per job ([OCR](../../../docs/extraction/ocr.md)).
- `execution_guard.py` enforces this:
  - it refuses to run under `DOCSLURP_SERVICE_PROFILE=service`;
  - `measure.py` and `timing.py` refuse a `--dataset`, or any case PDF in it (symlinks resolved), outside the data
    roots: this directory, plus the absolute paths in `MIXED_EVAL_DATA_ROOTS` (separated by `:`).
- Point `MIXED_EVAL_DATA_ROOTS` only at directories of generated fixtures (`generate.py --out`), public corpora or your
  own files.

## Running

```bash
bash scripts/install-ocr-runtime.sh "$PREFIX"            # OCR venv and pinned models
export DOCSLURP_OCR_PYTHON="$PREFIX/venv/bin/python3" DOCSLURP_OCR_MODEL_DIR="$PREFIX/models"
export MIXED_EVAL_DATA_ROOTS=/path/to/eval-data TMPDIR=/path/to/scratch
python3 worker/test/mixed-pdf-eval/generate.py --out /path/to/eval-data/mixed-pdf-yield
python3 worker/test/mixed-pdf-eval/measure.py --dataset /path/to/eval-data/mixed-pdf-yield --out RUN_DIR \
  --scorers SCORERS_DIR --split train
```

The harness needs PyMuPDF, Pillow, latex2mathml, markdown-it-py and lxml, plus bubblewrap, Poppler (`pdftotext`,
`pdfimages`) and `qpdf`. Tests: `python3 -m unittest test_*.py` from this directory (`test_scorer.py` also needs
`MIXED_PDF_SCORERS`).

Results recorded before 2026-11-05 used a retired OCR engine and are not comparable with new runs.
