"""Build an isolated evidence bundle from explicitly selected coordinator inputs.

Recompute score arithmetic from the exact independent reports. Corpus labels and
PDFs are never opened here. The separately supplied evidence index is trusted
coordinator configuration, not an authorization field inside an approval.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

from approval_v4 import validate_approval, validator_identity
from contract import file_hash, immutable_json
from evidence_v4 import EvidenceScope
from fools_gold_v4_common import freeze


def entry(path):
    return dict(path=str(path.absolute()), sha256=file_hash(path))


def run_score_snapshot(snapshot, expected_hash, arguments):
    """Execute one verified byte buffer, never reopen its mutable source path."""
    payload=snapshot.read_bytes()
    if hashlib.sha256(payload).hexdigest()!=expected_hash:raise ValueError('changed-score-snapshot')
    bootstrap=("import sys; source=sys.stdin.buffer.read(); sys.argv=sys.argv[1:]; "
               "exec(compile(source,sys.argv[0],'exec'),"
               "{'__name__':'__main__','__file__':sys.argv[0]})")
    result=subprocess.run([sys.executable,'-I','-c',bootstrap,str(snapshot),*arguments],
                          input=payload,capture_output=True,check=True)
    if file_hash(snapshot)!=expected_hash:raise ValueError('changed-score-snapshot')
    return json.loads(result.stdout)


def bind(dataset, semantic_path, reports, out, snapshots, reviewer_ids,
         score_script, pilot_path=None, review_semantic_path=None):
    dataset = dataset.resolve()
    manifest_path = dataset/'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    reviewed_path = pilot_path.absolute() if pilot_path else manifest_path
    reviewed = json.loads(reviewed_path.read_text())
    review_semantic_path = review_semantic_path or semantic_path
    if set(reports) != {'audit', 'judge'} or len(set(reviewer_ids.values())) != 2:
        raise ValueError('two-independent-reviewers-required')
    if file_hash(reports['audit']) == file_hash(reports['judge']):
        raise ValueError('distinct-review-reports-required')
    if out.resolve().is_relative_to(dataset) or dataset.is_relative_to(out.resolve()):
        raise ValueError('evidence-scope-overlaps-corpus')
    out.mkdir(parents=True, exist_ok=False)
    aliases, files, stages = {}, {}, {}

    def copy(source, relative):
        source = source.absolute()
        target = out/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        aliases[str(source)] = relative
        files[relative] = file_hash(target)
        return target

    copy(score_script, 'score-script.py')
    semantic_entries = {}
    for i, path in enumerate(dict.fromkeys([semantic_path, review_semantic_path])):
        receipt = json.loads(path.read_text())
        snapshot = snapshots[path.absolute()].resolve()
        if Path(receipt['validationSnapshot']).resolve() != snapshot:
            raise ValueError('explicit-validator-snapshot-mismatch')
        index_path = snapshot/'snapshot-hashes.json'
        index = json.loads(index_path.read_text())
        copy(index_path, f'validation-{i}/snapshot-hashes.json')
        for name in index['files']:
            source = snapshot/name
            if Path(name).is_absolute() or '..' in Path(name).parts or not source.resolve().is_relative_to(snapshot):
                raise ValueError('unsafe-validator-snapshot-path')
            copy(source, f'validation-{i}/{name}')
        semantic_entries[path.absolute()] = entry(copy(path, f'semantic-{i}.json'))
    semantic = json.loads(semantic_path.read_text())
    approval = dict(schema='mixed-pdf-evaluation-approval@3', coordinatorApproval=True,
        stage=manifest['stage'], candidate=str(dataset), datasetManifestSha256=file_hash(manifest_path),
        handoffHash=manifest['handoffHash'], semanticValidatorIdentityHash=validator_identity(semantic),
        semanticValidation=semantic_entries[semantic_path.absolute()],
        reviewScope='generator-pilot' if pilot_path else 'corpus')
    if pilot_path:
        copy(pilot_path, 'pilot-manifest.json')
        # Preserve original candidate-directory identity through the allowlisted alias.
        approval.update(balancedPilotApproved=True, pilotManifest=entry(pilot_path))
    report_paths = {stage: copy(path, f'{stage}-report.json') for stage, path in reports.items()}
    for stage in ['audit', 'judge']:
        report = json.loads(report_paths[stage].read_text())
        if report.get('stage', stage) != stage:
            raise ValueError('review-report-stage-mismatch')
        digest = file_hash(report_paths[stage])
        stages[digest] = dict(stage=stage, reviewerId=reviewer_ids[stage])
        command = ['--stage', stage,
                   '--audit', str(report_paths['audit']), '--attempt', '4', '--round', '2',
                   '--max-attempts', '20', '--no-record']
        if stage == 'judge': command += ['--judge', str(report_paths['judge'])]
        decision = run_score_snapshot(out/'score-script.py', files['score-script.py'], command)
        decision.update(schema='mixed-pdf-score-proof@1', reviewReportSha256=digest,
                        scoreScriptSha256=files['score-script.py'])
        if stage == 'judge': decision['auditReportSha256'] = file_hash(report_paths['audit'])
        freeze(decision, 'proofHash')
        score_path = out/f'{stage}-score.json'; immutable_json(score_path, decision)
        files[score_path.name] = file_hash(score_path)
        bound = dict(**{k:decision[k] for k in ['stage', 'score', 'pass', 'decision', 'counts']},
                     schema='mixed-pdf-bound-review@1', reviewerId=reviewer_ids[stage],
                     candidate=str(reviewed_path.parent), corpusManifestSha256=file_hash(reviewed_path),
                     handoffHash=reviewed['handoffHash'], reviewReport=entry(report_paths[stage]),
                     semanticValidation=semantic_entries[review_semantic_path.absolute()], scoreDecision=entry(score_path))
        freeze(bound, 'bindingHash')
        bound_path = out/f'{stage}-bound.json'; immutable_json(bound_path, bound)
        files[bound_path.name] = file_hash(bound_path)
        approval[stage+'Decision'] = entry(bound_path)
    immutable_json(out/'approval.json', approval)
    files['approval.json'] = file_hash(out/'approval.json')
    index_path = out/'evidence-index.json'
    immutable_json(index_path, dict(schema='mixed-pdf-evidence-scope@1', files=files,
                                   aliases=aliases, reviewStages=stages))
    evidence = EvidenceScope(index_path, protected_roots=[dataset])
    spec_path = next((dataset/'handoff').glob('spec-*.json'))
    validate_approval(approval, manifest, file_hash(manifest_path), candidate=dataset,
                      spec=json.loads(spec_path.read_text()), evidence=evidence)
    print(json.dumps(dict(approval=str(out/'approval.json'), evidenceIndex=str(index_path), stage=manifest['stage'])))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['dataset', 'semantic', 'audit-report', 'judge-report', 'out', 'validator-snapshot', 'score-script']:
        parser.add_argument('--'+name, type=Path, required=True)
    for name in ['audit-reviewer', 'judge-reviewer']:
        parser.add_argument('--'+name, required=True)
    parser.add_argument('--pilot-manifest', type=Path)
    parser.add_argument('--review-semantic', type=Path)
    parser.add_argument('--review-validator-snapshot', type=Path)
    args = parser.parse_args()
    snapshots = {args.semantic.absolute(): args.validator_snapshot}
    if args.review_semantic:
        if not args.review_validator_snapshot: parser.error('--review-validator-snapshot required')
        snapshots[args.review_semantic.absolute()] = args.review_validator_snapshot
    bind(args.dataset, args.semantic, dict(audit=args.audit_report, judge=args.judge_report), args.out,
         snapshots, dict(audit=args.audit_reviewer, judge=args.judge_reviewer), args.score_script,
         args.pilot_manifest, args.review_semantic)
