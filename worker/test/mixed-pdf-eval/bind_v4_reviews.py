"""Bind independent review reports and score arithmetic to exact corpus evidence.

Full corpora reuse explicitly identified, code-identical training-pilot reviews;
their own automatic semantic receipt still covers every newly generated case.
No labels, predictions, PDFs, extractors or model APIs are accessed here.
"""
import argparse
import json
from pathlib import Path

from approval_v4 import check_review, check_semantic, validate_approval, validator_identity
from contract import file_hash, immutable_json
from fools_gold_v4_common import freeze


def entry(path):
    return dict(path=str(path.resolve()), sha256=file_hash(path))


def bind(dataset, semantic_path, reports, out, pilot_path=None, review_semantic_path=None):
    dataset = dataset.resolve()
    manifest_path = dataset/'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest_sha = file_hash(manifest_path)
    semantic = json.loads(semantic_path.read_text())
    identity = validator_identity(semantic)
    check_semantic(semantic, manifest, manifest_sha, dataset, identity)
    reviewed_path = pilot_path.resolve() if pilot_path else manifest_path
    reviewed = json.loads(reviewed_path.read_text())
    reviewed_sha, reviewed_root = file_hash(reviewed_path), reviewed_path.parent
    review_semantic_path = review_semantic_path or semantic_path
    approval = dict(schema='mixed-pdf-evaluation-approval@2', coordinatorApproval=True,
        stage=manifest['stage'], candidate=str(dataset), datasetManifestSha256=manifest_sha,
        handoffHash=manifest['handoffHash'], semanticValidatorIdentityHash=identity,
        semanticValidation=entry(semantic_path), reviewScope='generator-pilot' if pilot_path else 'corpus')
    if pilot_path:
        approval.update(balancedPilotApproved=True, pilotManifest=entry(pilot_path))
    bounds = {}
    for stage, (report_path, decision_path) in reports.items():
        decision = json.loads(decision_path.read_text())
        bound = dict(decision, schema='mixed-pdf-bound-review@1', candidate=str(reviewed_root),
                     corpusManifestSha256=reviewed_sha, handoffHash=reviewed['handoffHash'],
                     semanticValidation=entry(review_semantic_path), reviewReport=entry(report_path),
                     scoreDecision=entry(decision_path))
        freeze(bound, 'bindingHash')
        check_review(bound, stage, reviewed, reviewed_sha, reviewed_root, identity)
        bounds[stage] = bound
    out.mkdir(parents=True, exist_ok=False)
    for stage, bound in bounds.items():
        path = out/f'{stage}-bound.json'; immutable_json(path, bound)
        approval[stage+'Decision'] = entry(path)
    spec = json.loads((dataset/'handoff/spec-a4.json').read_text())
    validate_approval(approval, manifest, manifest_sha, candidate=dataset, spec=spec)
    immutable_json(out/'approval.json', approval)
    print(json.dumps(dict(approval=str(out/'approval.json'), stage=manifest['stage'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, required=True)
    parser.add_argument('--semantic', type=Path, required=True)
    parser.add_argument('--audit-report', type=Path, required=True)
    parser.add_argument('--audit-score', type=Path, required=True)
    parser.add_argument('--judge-report', type=Path, required=True)
    parser.add_argument('--judge-score', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--pilot-manifest', type=Path)
    parser.add_argument('--review-semantic', type=Path)
    args = parser.parse_args()
    bind(args.dataset, args.semantic, dict(audit=(args.audit_report, args.audit_score),
        judge=(args.judge_report, args.judge_score)), args.out, args.pilot_manifest, args.review_semantic)
