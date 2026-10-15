#!/usr/bin/env python3
"""Parity report: Python (PyMuPDF) page probe vs native-pdf page probe.

Usage: page_probe_parity.py <jobs.json> <py.jsonl> <native.jsonl> [--out report.json] [--md report.md]

Inputs come from page_probe_batch.py and probe-native-batch.ts over the same jobs. jobs.json entries carry
{id, set, split, path}; gold comes from the eval-suite references (text_layer_state, unusual_features) for
jobs whose id starts with "routing::". Per-field tolerances are the PARITY table below.
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

# field -> (kind, tolerance). abs = |a-b| <= tol; rel = |a-b| <= tol*max(|a|,|b|,1); exact = equal.
PARITY: dict[str, tuple[str, float]] = {
    "charCount": ("rel", 0.02), "wordCount": ("rel", 0.02), "textCoverage": ("abs", 0.02), "fontCount": ("exact", 0),
    "unmappedGlyphRatio": ("abs", 0.01), "mathGlyphRatio": ("abs", 0.005), "tableRuleScore": ("exact", 0),
    "imageCoverage": ("abs", 0.02), "largestImageCoverage": ("abs", 0.02), "fullPageImage": ("exact", 0),
    "imageCount": ("exact", 0), "vectorDrawingCount": ("rel", 0.1), "uncoveredVectorRatio": ("abs", 0.05),
    "garbled": ("exact", 0), "smallestFontPt": ("abs", 0.1), "widthPt": ("abs", 0.1), "heightPt": ("abs", 0.1),
    "rotation": ("exact", 0), "blur": ("rel", 0.25), "contrast": ("abs", 0.03), "brightness": ("abs", 0.02),
    "invisibleTextRatio": ("abs", 0.02), "textOverImageRatio": ("abs", 0.05), "controlCharRatio": ("abs", 0.01),
    "commonWordRatio": ("abs", 0.02), "ocrEngineHint": ("exact", 0), "largestImageDpi": ("rel", 0.05),
    "textLayerStatus": ("exact", 0), "needsAttention": ("exact", 0),
}
STATE_OK = {"good": {"ok"}, "absent": {"absent", "unknown"}, "bad": {"suspect", "ocr-layer", "unknown"}, "partial": {"ok", "suspect", "ocr-layer", "unknown"}}


def load(path: str) -> dict[str, dict]:
    return {j["id"]: j for j in (json.loads(l) for l in open(path) if l.strip())}


def close(kind: str, tol: float, a, b) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if kind == "exact":
        return a == b
    if kind == "abs":
        return abs(a - b) <= tol
    return abs(a - b) <= tol * max(abs(a), abs(b), 1.0)


def percentile(xs: list[float], q: float) -> float:
    if not xs:
        return 0.0
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round((len(xs) - 1) * q)))]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("jobs"); ap.add_argument("py"); ap.add_argument("native")
    ap.add_argument("--out"); ap.add_argument("--md")
    a = ap.parse_args(argv)
    jobs = {j["id"]: j for j in json.load(open(a.jobs))}
    py, nat = load(a.py), load(a.native)
    fields: dict[str, Counter] = defaultdict(Counter)
    diffs: dict[str, list[float]] = defaultdict(list)
    status_conf: Counter = Counter()
    feat = defaultdict(Counter)          # feature -> counts of (py/native presence) per page
    feat_exact = Counter()
    disagreements: list[dict] = []
    gold = defaultdict(Counter)          # engine -> gold counters
    gold_feat = {"py": defaultdict(Counter), "native": defaultdict(Counter)}
    errors = {"py": Counter(), "native": Counter()}
    secs = {"py": [], "native": []}
    pages_total = 0
    by_set = defaultdict(lambda: Counter())
    for jid, job in jobs.items():
        p, n = py.get(jid), nat.get(jid)
        if p is None or n is None:
            errors["py" if p is None else "native"]["missing"] += 1
            continue
        for eng, rec in (("py", p), ("native", n)):
            if rec["error"]:
                errors[eng][rec["error"].split(":")[0] + ":" + rec["error"][:60]] += 1
            secs[eng].append((len(rec["rows"]) or 1, rec["seconds"]))
        if p["error"] or n["error"]:
            by_set[job["set"]]["doc-error"] += 1
            continue
        prow = {r["pageNumber"]: r for r in p["rows"]}
        nrow = {r["pageNumber"]: r for r in n["rows"]}
        if set(prow) != set(nrow):
            by_set[job["set"]]["page-set-mismatch"] += 1
            if not prow.get(0) and not nrow.get(0):
                disagreements.append({"id": jid, "kind": "pageSet", "py": sorted(prow)[:3], "native": sorted(nrow)[:3]})
            continue
        ref = None
        if jid.startswith("routing::"):
            ref = json.loads((Path(job["path"]).parents[1] / "references" / (jid.split("::", 1)[1] + ".json")).read_text())
        for pno, pr in prow.items():
            nr = nrow[pno]
            pages_total += 1
            by_set[job["set"]]["pages"] += 1
            status_conf[(pr.get("textLayerStatus"), nr.get("textLayerStatus"))] += 1
            for f, (kind, tol) in PARITY.items():
                x, y = pr.get(f), nr.get(f)
                ok = close(kind, tol, x, y)
                fields[f]["ok" if ok else "off"] += 1
                if isinstance(x, (int, float)) and isinstance(y, (int, float)) and not isinstance(x, bool):
                    diffs[f].append(abs(x - y))
                if not ok and f in ("textLayerStatus", "needsAttention"):
                    disagreements.append({"id": jid, "page": pno, "field": f, "py": x, "native": y,
                                          "pyFacts": pr.get("textFacts", {}).get("line"), "nativeFacts": nr.get("textFacts", {}).get("line")})
            pf, nf = set(pr.get("unusualFeatures") or []), set(nr.get("unusualFeatures") or [])
            feat_exact["same" if pf == nf else "differ"] += 1
            for f in pf | nf:
                feat[f][("both" if f in pf and f in nf else "py-only" if f in pf else "native-only")] += 1
            if pf != nf:
                disagreements.append({"id": jid, "page": pno, "field": "unusualFeatures", "py-only": sorted(pf - nf), "native-only": sorted(nf - pf)})
            if ref and pno <= len(ref["pages"]) and ref["pages"][pno - 1].get("routing"):
                rt = ref["pages"][pno - 1]["routing"]
                gf = set(rt.get("unusual_features") or [])
                split = job["split"]
                for eng, r in (("py", pr), ("native", nr)):
                    gold[eng][f"state-ok:{split}"] += r["textLayerStatus"] in STATE_OK[rt["text_layer_state"]]
                    gold[eng][f"state-n:{split}"] += 1
                    ef = set(r.get("unusualFeatures") or [])
                    gold[eng][f"features-exact:{split}"] += ef == gf
                    gold[eng][f"features-n:{split}"] += 1
                    for f in gf | ef:
                        gold_feat[eng][f]["tp" if f in gf and f in ef else "fn" if f in gf else "fp"] += 1
    def total_secs(eng):
        return sum(s for _, s in secs[eng]), sum(n for n, _ in secs[eng])
    pys, pyp = total_secs("py"); ns, np_ = total_secs("native")
    report = {
        "pages": pages_total, "docs": len(jobs), "bySet": {k: dict(v) for k, v in by_set.items()},
        "fields": {f: {"agree": c["ok"] / max(1, c["ok"] + c["off"]), "n": c["ok"] + c["off"], "meanAbsDiff": statistics.fmean(diffs[f]) if diffs[f] else None,
                       "p95AbsDiff": percentile(diffs[f], 0.95) if diffs[f] else None, "tolerance": PARITY[f]} for f, c in fields.items()},
        "textLayerStatusMatrix": {f"{k[0]}->{k[1]}": v for k, v in sorted(status_conf.items(), key=lambda kv: -kv[1])},
        "unusualFeaturesPageExact": dict(feat_exact), "unusualFeatureCounts": {k: dict(v) for k, v in sorted(feat.items())},
        "gold": {e: dict(c) for e, c in gold.items()}, "goldFeatures": {e: {f: dict(c) for f, c in sorted(m.items())} for e, m in gold_feat.items()},
        "errors": {e: dict(c) for e, c in errors.items()},
        "timing": {"py": {"seconds": pys, "pages": pyp, "msPerPage": 1000 * pys / max(1, pyp)}, "native": {"seconds": ns, "pages": np_, "msPerPage": 1000 * ns / max(1, np_)}},
        "disagreementSample": disagreements[:80], "disagreementCount": len(disagreements),
    }
    if a.out:
        Path(a.out).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({k: report[k] for k in ("pages", "docs", "unusualFeaturesPageExact", "errors", "timing", "disagreementCount")}, indent=2))
    print(f"{'field':24}{'agree':>8}{'mean|d|':>10}{'p95|d|':>10}  tol")
    for f, r in sorted(report["fields"].items(), key=lambda kv: kv[1]["agree"]):
        print(f"{f:24}{r['agree']*100:7.2f}%{(r['meanAbsDiff'] or 0):10.4f}{(r['p95AbsDiff'] or 0):10.4f}  {r['tolerance']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
