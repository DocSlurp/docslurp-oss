#!/usr/bin/env python3
"""Vector-chart PDFs with known data, for the PDF-figure yield and accuracy check (pdf-figure-words.mjs --truth).

Seeded, synthetic, upbeat business content; written outside the repository.

    venv/bin/python -I gen_pdf_truth.py OUT_DIR   ->  OUT_DIR/truth-charts.pdf, OUT_DIR/truth.json
"""
import json
import os
import random
import sys

import matplotlib

matplotlib.use("pdf")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.backends.backend_pdf import PdfPages  # noqa: E402

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
rng = random.Random(20261113)
REGIONS = ["London", "Tokyo", "Austin", "Lagos", "Lima", "Oslo"]
QUARTERS = ["Q1", "Q2", "Q3", "Q4"]
truth = []


def vals(n, lo=20, hi=90):
    return [round(rng.uniform(lo, hi)) for _ in range(n)]


def bar(ax, k):
    v = vals(len(REGIONS))
    ax.bar(REGIONS, v, color="#2a9d8f")
    ax.set_title(f"New stores opened {2024 + k}")
    ax.set_ylabel("Stores")
    return {"type": "bar", "categories": REGIONS, "series": {"": v}}


def hbar(ax, k):
    v = vals(len(REGIONS))
    ax.barh(REGIONS, v, color="#7b61ff")
    ax.set_title(f"Bookings growth by city {2024 + k}")
    return {"type": "hbar", "categories": REGIONS, "series": {"": v}}


def line(ax, k):
    s = {name: vals(len(QUARTERS), 40, 120) for name in ["Revenue", "Margin"]}
    for name, v in s.items():
        ax.plot(QUARTERS, v, label=name, marker="o")
    ax.legend()
    ax.set_title(f"Earnings beat by quarter {2024 + k}")
    return {"type": "line", "categories": QUARTERS, "series": s}


KINDS = [bar, hbar, line]
with PdfPages(os.path.join(OUT, "truth-charts.pdf"), metadata={"CreationDate": None}) as pdf:
    for page in range(9):
        fig, ax = plt.subplots(figsize=(8.5, 6))
        truth.append({"page": page + 1, **KINDS[page % 3](ax, page)})
        pdf.savefig(fig)
        plt.close(fig)
with open(os.path.join(OUT, "truth.json"), "w") as f:
    json.dump(truth, f, indent=1)
