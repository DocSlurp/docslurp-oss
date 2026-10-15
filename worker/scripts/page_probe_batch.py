#!/usr/bin/env python3
"""Run page_probe.probe_pdf over many PDFs in one process (parity harness for the native-pdf probe).

Usage: page_probe_batch.py <jobs.json> <out.jsonl> [--verify-ocr-layer]
jobs.json: [{"id": "...", "path": "/abs.pdf"}, ...]. Emits one JSON line per document:
{"id", "rows": [...], "error": str|null, "seconds": float}. Importing once amortises the interpreter start-up that
the per-document CLI pays (~246 ms, H10); the parity report adds that cost back explicitly.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import page_probe  # noqa: E402


def main(argv: list[str]) -> int:
    jobs = json.loads(Path(argv[1]).read_text())
    verify = "--verify-ocr-layer" in argv
    with open(argv[2], "w") as out:
        for job in jobs:
            t0 = time.perf_counter()
            rows, err = [], None
            try:
                rows = list(page_probe.probe_pdf(job["path"], verify_ocr_layer=verify))
            except Exception as ex:  # a crash is itself a finding
                err = f"{type(ex).__name__}: {ex}"
            out.write(json.dumps({"id": job["id"], "rows": rows, "error": err, "seconds": round(time.perf_counter() - t0, 4)}, separators=(",", ":")) + "\n")
            out.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
