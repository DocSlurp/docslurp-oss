#!/usr/bin/env python3
"""Read-only source-first curation inventory; region labels are declarations, not visual QA."""
import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inventory(root):
    pages = []
    image_groups = defaultdict(list)
    documents = defaultdict(list)
    for path in sorted((root / "sources").glob("*.json")):
        source = json.loads(path.read_text())
        identifier = source.get("id", path.stem)
        regions = source.get("regions", [])
        issues = []
        image = root / "images" / f"{identifier}.png"
        if image.exists():
            image_groups[digest(image)].append(identifier)
        else:
            issues.append("missing_default_image_path")
        for key in ("expected_markdown", "prose_contract"):
            record = source.get(key, {})
            artifact = root / record.get("path", "__missing__")
            if not artifact.is_file():
                issues.append(f"missing_{key}")
            elif record.get("sha256") != digest(artifact):
                issues.append(f"hash_mismatch_{key}")
        for region in regions:
            attrs = region.get("attributes", {})
            if region.get("label") == "table":
                cells = attrs.get("cells", [])
                if not cells:
                    issues.append(f"missing_cells:{region.get('id')}")
                for cell in cells:
                    if not all(key in cell for key in ("row", "column", "text", "bbox")):
                        issues.append(f"incomplete_cell:{region.get('id')}")
            if region.get("label") == "formula" and not any(attrs.get(key) for key in ("source_math_expression", "latex", "source_expression", "expected_math", "expression")):
                issues.append(f"missing_math_source:{region.get('id')}")
        document = source.get("document_id", identifier)
        documents[document].append(identifier)
        pages.append({"id": identifier, "document_id": document,
                      "image_path": str(image), "source_path": str(path),
                      "source_sha256": digest(path),
                      "declared_labels": dict(Counter(region["label"] for region in regions)),
                      "review_status": source.get("review_status", "unspecified"),
                      "issues": sorted(set(issues))})
    manifest_path = root / "pilot-manifest.jsonl"
    manifest_rows = [json.loads(line) for line in manifest_path.read_text().splitlines() if line.strip()] if manifest_path.exists() else []
    indexed = {row["id"] for row in manifest_rows}
    return {"manifest_rows": len(manifest_rows),
            "sources_missing_from_manifest": [page["id"] for page in pages if page["id"] not in indexed],
            "scope": "root authored sources only; archive originals and captures require separate manifests",
            "evidence_level": "source-declared; no visual or semantic acceptance implied",
            "authored_source_pages": len(pages), "document_groups": dict(documents),
            "unique_exact_rasters": len(image_groups),
            "exact_duplicate_raster_groups": [ids for ids in image_groups.values() if len(ids) > 1],
            "layout_family_count": None, "layout_family_note": "Requires human curation; never equate source IDs with families.",
            "pages": pages}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    result = inventory(args.root)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return int(any(page["issues"] for page in result["pages"]))


if __name__ == "__main__":
    raise SystemExit(main())
