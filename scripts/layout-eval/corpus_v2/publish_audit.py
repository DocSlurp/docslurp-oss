#!/usr/bin/env python3
"""Fail-closed publication evidence audit. No copying, relabeling or publishing."""
import argparse
import hashlib
import json
from pathlib import Path
from datetime import datetime, timezone


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def receipt(record, root):
    issues = []
    for evidence in record.get("evidence", []):
        path = Path(evidence["path"])
        if not path.is_absolute():
            path = root / path
        if not path.is_file() or sha(path) != evidence.get("sha256"):
            issues.append("missing_or_changed_rights_evidence:" + str(path))
    if not record.get("evidence"):
        issues.append("missing_saved_rights_evidence")
    if not record.get("reviewed_by") or not record.get("reviewed_at"):
        issues.append("missing_rights_reviewer_or_date")
    return issues


def audit(root, clearances):
    approvals = {record["sha256"]: record for record in clearances.get("dependencies", [])}
    declaration = clearances.get("contribution_release", {})
    release_issues = []
    if declaration.get("license") not in ("CC-BY-4.0", "CC0-1.0") or not declaration.get("approved_by") or not declaration.get("attribution") or not declaration.get("original_content_scope"):
        release_issues.append("missing_explicit_original_contribution_release")
    qa_path = root / "qa/visual-qa-ledger.json"
    qa = json.loads(qa_path.read_text()) if qa_path.is_file() else {}
    qa_rows = {page["id"]: page for page in qa.get("pages", [])}
    rows = []
    for source_path in sorted((root / "sources").glob("*.json")):
        source = json.loads(source_path.read_text())
        identifier = source["id"]
        issues = list(release_issues)
        artifacts = {}
        for role, path in (("source", source_path), ("image", root / "images" / f"{identifier}.png"), ("reference", root / "references" / f"{identifier}.json"), ("contract", root / source.get("prose_contract", {}).get("path", "__missing__")), ("expected_markdown", root / source.get("expected_markdown", {}).get("path", "__missing__"))):
            if not path.is_file():
                issues.append("missing_artifact:" + role)
            else:
                artifacts[role] = {"path": str(path), "sha256": sha(path)}
        if source.get("provenance", {}).get("kind") not in {"deliberately-authored-editorial-composition", "original-fictional-period-menu-composition"}:
            issues.append("missing_reviewed_source_authorship_declaration")
        dependencies = []
        paths = {command["path"] for command in source.get("commands", []) if command.get("op") == "image"}
        for region in source.get("regions", []):
            asset = region.get("attributes", {}).get("asset", {})
            if asset.get("path"):
                paths.add(asset["path"])
        for name in sorted(paths):
            path = Path(name)
            if not path.is_absolute():
                path = root / path
            if not path.is_file():
                issues.append("missing_dependency:" + name)
                continue
            digest = sha(path)
            for region in source.get("regions", []):
                claim = region.get("attributes", {}).get("asset", {})
                if claim.get("path") == name and claim.get("sha256") != digest:
                    issues.append("asset_claim_hash_mismatch:" + path.name)
            record = approvals.get(digest, {})
            dep_issues = []
            if "magna-carta" in name.lower() or record.get("use") == "inspiration-only":
                dep_issues.append("inspiration_only_dependency_excluded")
            if record.get("license") not in ("CC0-1.0", "Public-Domain", "CC-BY-4.0", "original-contribution", "generated-output"):
                dep_issues.append("unverified_dependency_license")
            dep_issues += receipt(record, root)
            if not record.get("attribution") or not record.get("modifications"):
                dep_issues.append("missing_attribution_or_modification_record")
            if record.get("license") == "generated-output" and not record.get("generation_provenance"):
                dep_issues.append("missing_generation_provenance")
            dependencies.append({"path": str(path), "sha256": digest, "clearance": record, "issues": dep_issues})
            issues += [problem + ":" + path.name for problem in dep_issues]
        fonts = []
        for face, font in source.get("font_provenance", {}).items():
            path = Path(font["path"])
            fonts.append({"face": face, **font, "export_binary": False})
            if not path.is_file() or sha(path) != font.get("sha256"):
                issues.append("font_hash_mismatch:" + face)
        qa_row = qa_rows.get(identifier, {})
        label_issues = []
        for role in ("source", "image", "reference", "contract"):
            if role not in artifacts or qa_row.get(role + "_sha256") != artifacts[role]["sha256"]:
                label_issues.append("missing_or_stale_qa_hash:" + role)
        confidence_path = root / "qa/confidence" / f"{identifier}.json"
        confidence = source.get("ground_truth", {}).get("confidence")
        confidence_artifact = None
        if confidence_path.is_file():
            confidence_receipt = json.loads(confidence_path.read_text())
            confidence_artifact = {"path": str(confidence_path), "sha256": sha(confidence_path), "evidence_scale": confidence_receipt.get("scale")}
            for role in ("source", "image", "reference"):
                if role not in artifacts or confidence_receipt.get("artifacts", {}).get(role + "Sha256") != artifacts[role]["sha256"]:
                    label_issues.append("stale_confidence_hash:" + role)
        else:
            label_issues.append("missing_confidence_receipt")
        rows.append({"id": identifier, "document_id": source.get("document_id", identifier), "artifacts": artifacts,
                     "dependencies": dependencies, "fonts": fonts,
                     "rights_status": "evidence-ready" if not issues else "blocked",
                     "rights_issues": sorted(set(issues)),
                     "label_evidence_status": "hash-current-review-only" if not label_issues else "blocked-or-stale",
                     "label_issues": label_issues,
                     "confidence": confidence, "confidence_artifact": confidence_artifact,
                     "confidence_interpretation": "Evidence ratings, where supplied, are not probabilities or measured accuracy.",
                     "qa": qa_row})
    eligible = [row for row in rows if not row["rights_issues"]]
    return {"schema": "layout-publish-evidence-audit-v1", "generated_at": datetime.now(timezone.utc).isoformat(),
            "not_a_legal_guarantee": True, "not_a_quality_score_or_eval_admission": True,
            "publication_performed": False,
            "scope": "native authored source pages only; captures, historical originals and inspiration references excluded from export until their own transitive audit",
            "unreviewed_capture_rows": [str(path) for path in sorted((root / "captures").glob("*.row.json"))],
            "contribution_release": declaration,
            "font_policy": "Raster exports only; do not copy font binaries. Generator code retains repository license. Source JSON font paths are reproducibility references, not redistributions.",
            "qa_ledger": {"path": str(qa_path), "sha256": sha(qa_path) if qa_path.is_file() else None},
            "candidate_count": len(rows), "rights_ready_count": len(eligible),
            "publish_entries": eligible, "excluded_entries": [row for row in rows if row not in eligible],
            "excluded_inspiration": ["Magna Carta 1297 photograph: unverified image rights; never add through directory glob export."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("--clearances", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    clearances = json.loads(args.clearances.read_text()) if args.clearances else {}
    report = audit(args.root, clearances)
    payload = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    if args.output:
        args.output.write_text(payload)
    else:
        print(payload, end="")
    return int(report["rights_ready_count"] != report["candidate_count"])


if __name__ == "__main__":
    raise SystemExit(main())
