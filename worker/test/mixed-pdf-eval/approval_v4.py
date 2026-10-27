"""Verify corpus-bound review evidence and frozen semantic-validator receipts.

These are local coordinator attestations, not signatures against a malicious root.
Every referenced artifact and case outcome is checked before source-label access.
"""
import json
from pathlib import Path
import re

from contract import file_hash, identity_hash
from fools_gold_v4_common import record_hash


def require(condition, message):
    if not condition:
        raise ValueError(message)


def load_hashed(entry):
    path = Path(entry['path'])
    require(file_hash(path) == entry['sha256'], 'changed-approval-evidence')
    return json.loads(path.read_text())


def validator_identity(receipt):
    return identity_hash({k: receipt[k] for k in ['schema', 'validatorCodeSha256', 'validatorDependencySha256']})


def check_semantic(receipt, manifest, manifest_sha, candidate, expected_validator):
    require(receipt.get('schema') == 'mixed-pdf-semantic-revalidation@1', 'unsupported-semantic-receipt')
    require(record_hash(receipt, 'receiptHash') == receipt.get('receiptHash'), 'semantic-receipt-self-hash')
    require(receipt.get('passed') is True and receipt.get('misses') == [], 'semantic-validation-failed')
    for key in ['originalCorpusUnchanged', 'cleanInputsUnchanged', 'validatorCodeUnchangedDuringRun']:
        require(receipt.get(key) is True, 'incomplete-semantic-execution')
    require(receipt.get('corpusManifestSha256') == manifest_sha
            and receipt.get('handoffHash') == manifest['handoffHash']
            and Path(receipt['candidate']).resolve() == candidate.resolve(), 'semantic-corpus-binding')
    require(validator_identity(receipt) == expected_validator, 'unapproved-semantic-validator')
    code, deps = receipt['validatorCodeSha256'], receipt['validatorDependencySha256']
    require({'fools_gold_v4_check.py', 'fools_gold_v4_semantic.py'} <= set(code)
            and bool(deps), 'missing-validator-dependencies')
    folder = Path(receipt['validationSnapshot']).resolve()
    index_path = folder / 'snapshot-hashes.json'
    require(file_hash(index_path) == receipt['snapshotHashesSha256'], 'changed-validator-snapshot')
    index = json.loads(index_path.read_text())
    require(index.get('schema') == 'mixed-pdf-validator-snapshot@1'
            and record_hash(index, 'snapshotHash') == index.get('snapshotHash'), 'invalid-validator-snapshot')
    require(index['validatorCodeSha256'] == code and index['dependencySha256'] == deps,
            'validator-snapshot-identity-mismatch')
    for name, digest in {**index['files'], **code, **deps}.items():
        path = (folder / name).resolve()
        require(not Path(name).is_absolute() and path.is_relative_to(folder)
                and re.fullmatch('[0-9a-f]{64}', digest) is not None, 'unsafe-validator-snapshot-path')
        require(index['files'].get(name) == digest and file_hash(path) == digest,
                'stale-validator-or-dependency')
    exit_code = receipt.get('tests', {}).get('exitCode')
    require(type(exit_code) is int and exit_code == 0, 'semantic-validator-tests-failed')
    expected_counts = dict(families=manifest['counts']['families'],
                           authoringPages=manifest['counts']['families'] * 10,
                           labelPages=manifest['counts']['pages'], pdfsHashed=manifest['counts']['pdfs'])
    require(all(receipt.get('counts', {}).get(k) == v for k, v in expected_counts.items()),
            'semantic-count-mismatch')
    expected = {c['id']: c for c in manifest['cases']}
    checked = receipt.get('checkedCases', [])
    require(len(checked) == len(expected) and {c['id'] for c in checked} == set(expected),
            'semantic-case-inventory-mismatch')
    for row in checked:
        case = expected[row['id']]
        require(row.get('schemaPassed') is True and row.get('result', {}).get('passed') is True
                and row['result'].get('misses') == [] and row['result'].get('checkedPages') == case['pages'],
                'semantic-case-failed')
        for key, source in [('pdfSha256', 'sha256'), ('labelSha256', 'labelHash'),
                            ('authoringHash', 'authoringHash'), ('worldHash', 'worldHash')]:
            require(row.get(key) == case[source], 'semantic-case-evidence-mismatch')
    families = {c['familyId']: c for c in manifest['cases']}
    checked_families = receipt.get('checkedFamilies', [])
    require(len(checked_families) == len(families)
            and {f['familyId'] for f in checked_families} == set(families), 'semantic-family-inventory-mismatch')
    for row in checked_families:
        case = families[row['familyId']]
        require(row.get('schemaPassed') is True and row.get('result', {}).get('passed') is True
                and row['result'].get('misses') == [] and row['result'].get('checkedPages') == 10,
                'semantic-family-failed')
        require(row.get('authoringHash') == case['authoringHash'] and row.get('worldHash') == case['worldHash']
                and row.get('sourceLayoutByteSha256') == case['sourceLayoutHash'], 'semantic-family-evidence-mismatch')


def report_receipt_binding(report, stage, receipt, receipt_sha, manifest_sha):
    """Accept the standardized binding, or the original independently checked v1 reports."""
    binding = report.get('corpusBinding')
    if binding is not None:
        require(binding.get('corpusManifestSha256') == manifest_sha
                and binding.get('semanticReceiptSha256') == receipt_sha
                and binding.get('validatorIdentityHash') == validator_identity(receipt), 'review-report-corpus-binding')
    elif stage == 'audit':
        require(report.get('checks', {}).get('receipt', {}).get('receiptHash') == receipt['receiptHash']
                and report.get('checks', {}).get('endOfReview', {}).get('receiptCanonicalHashStillMatchesVerified') is True,
                'audit-report-receipt-binding')
    else:
        require(report.get('semanticCorrection', {}).get('receiptSha256') == receipt_sha,
                'judge-report-receipt-binding')


def check_review(bound, stage, manifest, manifest_sha, candidate, expected_validator):
    require(bound.get('schema') == 'mixed-pdf-bound-review@1'
            and record_hash(bound, 'bindingHash') == bound.get('bindingHash'), 'invalid-bound-review')
    require(bound.get('stage') == stage and bound.get('corpusManifestSha256') == manifest_sha
            and bound.get('handoffHash') == manifest['handoffHash']
            and Path(bound['candidate']).resolve() == candidate.resolve(), 'review-corpus-binding')
    semantic = load_hashed(bound['semanticValidation'])
    check_semantic(semantic, manifest, manifest_sha, candidate, expected_validator)
    report = load_hashed(bound['reviewReport'])
    require(Path(report['candidate']).resolve() == candidate.resolve(), 'review-report-candidate-mismatch')
    require(isinstance(report.get('misses'), list)
            and all(m.get('severity') == 'low' for m in report['misses']), 'review-report-unresolved-misses')
    report_receipt_binding(report, stage, semantic, bound['semanticValidation']['sha256'], manifest_sha)
    decision = load_hashed(bound['scoreDecision'])
    require('candidate' not in decision or Path(decision['candidate']).resolve() == candidate.resolve(),
            'score-decision-candidate-mismatch')
    require('corpusManifestSha256' not in decision or decision['corpusManifestSha256'] == manifest_sha,
            'score-decision-corpus-mismatch')
    for key in ['stage', 'score', 'pass', 'decision', 'counts']:
        require(bound.get(key) == decision.get(key), 'changed-score-decision')
    score, counts = decision.get('score'), decision.get('counts', {})
    require(decision.get('stage') == stage and decision.get('pass') is True
            and decision.get('decision') == 'pass' and type(score) is int and 95 <= score <= 100
            and all(type(counts.get(k)) is int for k in ['fatal', 'high', 'medium', 'low'])
            and all(counts[k] == 0 for k in ['fatal', 'high', 'medium'])
            and len(report['misses']) <= decision.get('counts', {}).get('low', 100) <= 5,
            'quality-gate-not-cleared')


def validate_approval(approval, manifest, manifest_sha, candidate=None, spec=None):
    require(approval.get('schema') == 'mixed-pdf-evaluation-approval@2'
            and approval.get('coordinatorApproval') is True and approval.get('stage') == manifest['stage']
            and approval.get('datasetManifestSha256') == manifest_sha
            and approval.get('handoffHash') == manifest['handoffHash'], 'unbound-corpus-approval')
    root = Path(approval['candidate']).resolve()
    require(candidate is None or candidate.resolve() == root, 'approval-candidate-mismatch')
    identity = approval['semanticValidatorIdentityHash']
    semantic = load_hashed(approval['semanticValidation'])
    check_semantic(semantic, manifest, manifest_sha, root, identity)
    reviewed, reviewed_sha, reviewed_root = manifest, manifest_sha, root
    if manifest['stage'] == 'full':
        require(approval.get('reviewScope') == 'generator-pilot'
                and approval.get('balancedPilotApproved') is True and spec is not None, 'full-corpus-without-approved-pilot')
        reviewed = load_hashed(approval['pilotManifest'])
        reviewed_sha = approval['pilotManifest']['sha256']
        reviewed_root = Path(approval['pilotManifest']['path']).resolve().parent
        from seal_v4 import validate_inventory
        validate_inventory(reviewed, spec)
        require(reviewed['stage'] == 'factorial-pilot' and reviewed['handoffHash'] == manifest['handoffHash']
                and reviewed['specHash'] == manifest['specHash']
                and reviewed['builderSourceHashes'] == manifest['builderSourceHashes'], 'full-generator-differs-from-reviewed-pilot')
    else:
        require(approval.get('reviewScope') == 'corpus', 'unsupported-review-scope')
    check_review(load_hashed(approval['auditDecision']), 'audit', reviewed, reviewed_sha, reviewed_root, identity)
    check_review(load_hashed(approval['judgeDecision']), 'judge', reviewed, reviewed_sha, reviewed_root, identity)
