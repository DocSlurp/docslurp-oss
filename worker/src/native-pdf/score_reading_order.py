#!/usr/bin/env python3
"""Score bench-cli output against generator-authored page references.

Reading order = order-sensitive word-sequence similarity (difflib ratio over
lower-cased word tokens) per page, so interleaved columns lose points while
markup differences do not. Usage: score_reading_order.py <suiteDir> <benchDir> [filter-substring]
"""
import json, re, sys
from difflib import SequenceMatcher
from pathlib import Path

suite, bench = Path(sys.argv[1]), Path(sys.argv[2])
flt = sys.argv[3] if len(sys.argv) > 3 else ""
tok = lambda t: re.findall(r"\w+", t.lower())

def score(ref, hyp):
    a, b = tok(ref), tok(hyp)
    if not a and not b: return 1.0
    return SequenceMatcher(None, a, b, autojunk=False).ratio()

rows, totals = [], {"raw": [], "assembled": [], "kreuzberg": []}
for f in sorted(bench.glob("*.json")):
    r = json.loads(f.read_text())
    if flt and flt not in r["id"]: continue
    if "error" in r: print(r["id"], r["error"]); continue
    ref = json.loads((suite / "references" / f"{r['id']}.json").read_text())["pages"]
    refs = [p["markdown"] for p in ref]
    if len(refs) != len(r["raw"]): continue
    line = {"id": r["id"]}
    for k in ("raw", "assembled"):
        s = [score(a, b) for a, b in zip(refs, r[k])]
        line[k] = sum(s) / len(s); totals[k] += s
    if "kreuzberg" in r:
        s = score("\n".join(refs), r["kreuzberg"]); line["kreuzberg"] = s; totals["kreuzberg"].append(s)
    rows.append(line)
for l in rows:
    print(f"{l['id']:44s} raw={l['raw']:.3f} assembled={l['assembled']:.3f}" + (f" kreuzberg={l['kreuzberg']:.3f}" if "kreuzberg" in l else ""))
for k, v in totals.items():
    if v: print(f"MEAN {k}: {sum(v)/len(v):.4f} over {len(v)}")
