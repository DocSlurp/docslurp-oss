#!/usr/bin/env python3
"""Generate provisional, source-derived acronym questions without a model/judge.

These are candidates for independent review, not gold questions or performance evidence.
Pick first qualifying definition per document third deterministically before any run.
"""
import argparse
import json
from pathlib import Path
import re
from dataset import normalize, page_texts, write_json


def generate(manifest):
    questions = []
    for d in manifest["documents"]:
        pages = page_texts(d["full_text_file"])
        used = set()
        for third, position in enumerate(["beginning", "middle", "end"]):
            lo, hi = len(pages)*third//3, len(pages)*(third+1)//3
            found = None
            for index in range(lo, hi):
                for match in re.finditer(r"\b([A-Z][A-Za-z]+(?:[ -]+(?:[A-Za-z]+)){1,7})\s*\(([A-Z]{2,6})\)", pages[index]):
                    expansion, acronym = match.groups()
                    initials = "".join(w[0].upper() for w in expansion.split() if w.lower() not in {"of", "and", "the", "for", "in", "to", "a"})
                    if initials != acronym or acronym in used:
                        continue
                    found = (index, " ".join(expansion.split()), acronym)
                    break
                if found: break
            if not found: continue
            index, expansion, acronym = found
            used.add(acronym)
            needles = [expansion, "("+acronym+")"]
            support = [i+1 for i, page in enumerate(pages) if all(normalize(n) in normalize(page) for n in needles)]
            questions.append({"id": f"acronym-{d['id']}-{third}", "document": d["id"], "position": position,
                              "question": f"In {d['title']}, what does {acronym} stand for?",
                              "expected_answer": expansion, "support_pages": support,
                              "support_match_all": needles, "split": "validation-provisional", "label_status": "provisional",
                              "challenges": ["abbreviation", "cross-edition-disambiguation", "long-document"],
                              "provenance": "Deterministic initial-letter-matched source definition; not human-reviewed; may have multiple meanings. Frozen before retrieval tuning; no gold claim."})
    return {"queries": questions}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--manifest", required=True);p.add_argument("--output", required=True)
    args = p.parse_args();result = generate(json.loads(Path(args.manifest).read_text()))
    write_json(args.output, result);print(json.dumps({"provisionalQueries": len(result["queries"])}))
