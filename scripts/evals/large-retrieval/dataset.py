#!/usr/bin/env python3
"""Offline, content-addressed large-document evaluation dataset builder."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata


def normalize(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def file_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def page_texts(path):
    pages = Path(path).read_text().split("\f")
    if not pages[-1].strip():
        pages.pop()
    return pages


def build(manifests, query_paths, output):
    output = Path(output).resolve()
    repository = Path(__file__).resolve().parents[3]
    if output.is_relative_to(repository):
        raise ValueError("Dataset media and labels must be outside the repository")
    if (output / "dataset.json").exists():
        raise ValueError("Immutable dataset already exists; choose a new version directory")
    output.mkdir(parents=True, exist_ok=True)
    documents, seen, texts = [], set(), {}
    for manifest in manifests:
        for source in json.loads(Path(manifest).read_text())["documents"]:
            if source["id"] in seen:
                raise ValueError("Duplicate document id: " + source["id"])
            seen.add(source["id"])
            sha = file_hash(source["local_path"])
            if sha != source["sha256"]:
                raise ValueError("Source checksum mismatch: " + source["id"])
            if any(d["sha256"] == sha for d in documents):
                raise ValueError("Duplicate PDF bytes cannot count as distinct documents")
            info = subprocess.check_output(["pdfinfo", source["local_path"]], text=True)
            count = int(re.search(r"^Pages:\s+(\d+)", info, re.M)[1])
            pages = page_texts(source["full_text_file"])
            if count != source["pdfinfo_pages"] or count != len(pages):
                raise ValueError("PDF/text page count mismatch: " + source["id"])
            media = output / "sources" / sha
            media.mkdir(parents=True, exist_ok=True)
            for origin, name in [(source["local_path"], "source.pdf"), (source["full_text_file"], "pages.txt")]:
                dest = media / name
                if not dest.exists():
                    try:
                        os.link(origin, dest)
                    except OSError:
                        shutil.copyfile(origin, dest)
            documents.append({"id": source["id"], "title": source["title"], "url": source["url"],
                              "sourcePage": source.get("source_page"), "usage": source["usage"],
                              "sha256": sha, "bytes": Path(source["local_path"]).stat().st_size,
                              "pages": count, "textSha256": file_hash(media / "pages.txt"),
                              "pdf": str(media.relative_to(output) / "source.pdf"),
                              "text": str(media.relative_to(output) / "pages.txt")})
            texts[source["id"]] = pages
    queries, ids = [], set()
    for query_path in query_paths:
        for q in json.loads(Path(query_path).read_text())["queries"]:
            if q["id"] in ids:
                raise ValueError("Duplicate query id: " + q["id"])
            ids.add(q["id"])
            if q.get("split", "development") not in {"development", "validation-provisional"}:
                raise ValueError("Imported labels cannot claim held-out/gold status")
            if not q.get("expected_answer"):
                raise ValueError("Missing positive answer/rubric: " + q["id"])
            evidence = q.get("support_evidence", [{"document": q["document"], "support_pages": q.get("support_pages"), "support_match_all": q.get("support_match_all")}])
            relevant = []
            for item in evidence:
                pages = texts[item["document"]]
                if not item.get("support_pages") or not item.get("support_match_all"):
                    raise ValueError("Missing positive evidence: " + q["id"])
                needles = [normalize(s) for s in item["support_match_all"]]
                if not normalize(q["expected_answer"]) or not all(needles):
                    raise ValueError("Empty normalized labels: " + q["id"])
                supporting = [i + 1 for i, page in enumerate(pages) if all(n in normalize(page) for n in needles)]
                if not set(item["support_pages"]).issubset(supporting):
                    raise ValueError("Imported labels do not match source pages: " + q["id"])
                relevant.extend({"document": item["document"], "page": p} for p in supporting)
            queries.append({"id": q["id"], "split": q.get("split", "development"), "labelStatus": q.get("label_status", "source-derived"),
                            "sourceDocument": q["document"], "question": q["question"], "answerable": True,
                            "expectedAnswer": q["expected_answer"], "relevant": relevant,
                            "supportEvidence": evidence, "position": q.get("position", "cross-document"),
                            "challenges": q.get("challenges", ["long-document", "cross-document-distractors"]),
                            "rubric": q.get("rubric"),
                            "provenance": q.get("provenance", "Previously inspected/run questions; never held-out evidence")})
    # Mechanical missing-identifier controls, not naturalistic no-answer gold.
    for d in documents[:1]:
        token = "UNLISTED-" + d["sha256"][:24]
        if any(token.casefold() in page.casefold() for pages in texts.values() for page in pages):
            raise ValueError("Negative identifier unexpectedly exists")
        queries.append({"id": "negative-" + d["id"], "split": "development", "labelStatus": "synthetic-control",
                        "sourceDocument": d["id"], "question": f"What does {d['title']} say about record {token}?", "answerable": False,
                        "expectedAnswer": None, "relevant": [], "challenges": ["negative", "exact-identifier"],
                        "provenance": "Deterministic identifier absent in every extracted page; not a semantic absence claim"})
    # No unreviewed or previously seen labels are promoted to gold/held-out.
    dataset = {"schema": "docslurp-large-retrieval-v1", "documents": documents,
               "pages": sum(d["pages"] for d in documents), "documentCount": len(documents),
               "chunks": None, "chunkNote": "Record actual index row count per run; depends on pipeline",
               "queries": queries, "heldOutGoldQueries": 0,
               "sourceManifestHashes": [file_hash(p) for p in manifests],
               "querySourceHashes": [file_hash(p) for p in query_paths]}
    dataset["versionSha256"] = digest(dataset)
    write_json(output / "dataset.json", dataset)
    return dataset


def scenario(dataset, target, split="development"):
    selected, count = [], 0
    # Whole distinct PDFs; threshold is minimum pages, never claimed exact.
    for document in dataset["documents"]:
        selected.append(document["id"])
        count += document["pages"]
        if count >= target:
            break
    if count < target:
        raise ValueError(f"Target {target:,} pages unmet: only {count:,} distinct-source pages")
    result = {"schema": "docslurp-large-retrieval-scenario-v1", "datasetSha256": dataset["versionSha256"],
              "targetPages": target, "actualPages": count, "documents": selected, "split": split,
              "documentCount": len(selected), "syntheticReplicas": 0,
              "queryIds": [q["id"] for q in dataset["queries"] if q.get("split", "development") == split and q.get("sourceDocument", selected[0]) in selected and (not q["relevant"] or all(r["document"] in selected for r in q["relevant"]))]}
    if not result["queryIds"]:
        raise ValueError("No queries for this scenario and split")
    result["versionSha256"] = digest(result)
    return result


def load_dataset(path):
    dataset = json.loads(Path(path).read_text())
    content = {k: v for k, v in dataset.items() if k != "versionSha256"}
    if digest(content) != dataset["versionSha256"]:
        raise ValueError("Dataset content hash mismatch")
    return dataset


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    commands = p.add_subparsers(dest="command", required=True)
    b = commands.add_parser("build")
    b.add_argument("--manifest", action="append", required=True)
    b.add_argument("--queries", action="append", required=True)
    b.add_argument("--output", required=True)
    s = commands.add_parser("scenario")
    s.add_argument("--dataset", required=True)
    s.add_argument("--pages", type=int, choices=[10000, 25000, 50000], required=True)
    s.add_argument("--output", required=True)
    s.add_argument("--split", choices=["development", "validation-provisional"], default="development")
    args = p.parse_args()
    if args.command == "build":
        result = build(args.manifest, args.queries, args.output)
        print(json.dumps({"versionSha256": result["versionSha256"], "pages": result["pages"], "documents": result["documentCount"], "queries": len(result["queries"])}))
    else:
        result = scenario(load_dataset(args.dataset), args.pages, args.split)
        write_json(args.output, result)
        print(json.dumps(result))
